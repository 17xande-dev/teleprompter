// Clientside WebRTC: signaling over a per-room WebSocket, then a scroll
// ratio + small control-message protocol carried peer-to-peer over data
// channels. Star topology — the controller holds one RTCPeerConnection per
// viewer; a viewer only ever talks to the controller.
//
// This mirrors ~/dev/webrtc-go's rtc.ts (perfect-negotiation, two negotiated
// data channels: an unreliable/unordered "scroll" channel and a reliable
// "control" channel), generalized from exactly 2 peers to 1 controller + N
// viewers: the controller is always the impolite side and runs one
// independent negotiation per viewer id; a viewer is always polite and only
// ever negotiates with the controller.

import type { ControlMessage } from "./protocol.ts";
import { chunkFile, type Frame, makeReassembler } from "./filetransfer.ts";

type ConnState = "waiting" | "connecting" | "connected" | "disconnected";

// Stop pumping file chunks once this much is queued in the channel, resume
// when it drains to the low threshold. Without this a multi-megabyte PDF goes
// into the send buffer as fast as the loop can push it, and even though the
// file has a stream of its own the shared SCTP association ends up carrying a
// backlog that the scroll samples have to queue behind — which shows up as
// exactly the stutter the rest of this codebase works to avoid.
const FILE_BUFFER_HIGH = 1024 * 1024;
const FILE_BUFFER_LOW = 256 * 1024;

function wsURL(
  room: string,
  role: "controller" | "viewer",
  key?: string,
): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ room, role });
  // Only a controller carries a key; it's what stops someone who has the
  // viewer link from claiming control of the room.
  if (key) params.set("key", key);
  return `${proto}://${location.host}/ws?${params}`;
}

async function fetchIceConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch("/ice");
    const data = await res.json() as { iceServers: RTCIceServer[] };
    return { iceServers: data.iceServers };
  } catch {
    return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  }
}

interface SignalEnvelope {
  kind?: string;
  from?: string;
  peers?: string[];
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface Link {
  ensurePeerConnection(): void;
  onSignal(msg: SignalEnvelope): Promise<void>;
  sendScroll(ratio: number, seq: number): void;
  sendControl(msg: ControlMessage): void;
  sendFile(name: string, bytes: ArrayBuffer): void;
  close(): void;
}

interface LinkOptions {
  polite: boolean;
  rtcConfig: RTCConfiguration;
  sendSignal: (msg: SignalEnvelope) => void;
  onScroll: (ratio: number, seq: number) => void;
  onControl: (msg: ControlMessage) => void;
  onFile?: (name: string, data: ArrayBuffer) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

// makeLink owns exactly one RTCPeerConnection and its two negotiated data
// channels. It's used once per viewer on the controller side, and once
// (for the controller) on a viewer's side.
function makeLink(opts: LinkOptions): Link {
  let pc: RTCPeerConnection | null = null;
  let scrollCh: RTCDataChannel | null = null;
  let controlCh: RTCDataChannel | null = null;
  let fileCh: RTCDataChannel | null = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let lastScrollSeq = 0;
  // A negotiated data channel isn't open the instant it's created — it
  // only opens once SDP/ICE negotiation completes. A caller (e.g. "bring
  // this newcomer up to date") can reasonably send control messages before
  // that finishes, so queue them rather than silently drop them.
  const pendingControl: ControlMessage[] = [];
  // The same problem for files, but a *slot* rather than a queue: the newcomer
  // catch-up in teleprompter.ts fires at peer-joined, well before the channel
  // opens, and only the latest PDF is worth anything. Queuing would send
  // megabytes of superseded document.
  let pendingFile: { name: string; bytes: ArrayBuffer } | null = null;
  // Cancels an in-flight pump when the file it is sending is superseded or the
  // link closes, so two pumps can't interleave chunks on the same channel.
  let fileGeneration = 0;

  function ensurePeerConnection() {
    if (pc) return;
    pc = new RTCPeerConnection(opts.rtcConfig);

    scrollCh = pc.createDataChannel("scroll", {
      negotiated: true,
      id: 0,
      ordered: false,
      maxRetransmits: 0,
    });
    controlCh = pc.createDataChannel("control", {
      negotiated: true,
      id: 1,
      ordered: true,
    });
    // Bulk file transfer gets its own stream rather than riding "control" as
    // base64. SCTP schedules between streams, so a multi-megabyte PDF doesn't
    // park settings and content messages behind it — and raw ArrayBuffers
    // avoid base64's 33% inflation.
    fileCh = pc.createDataChannel("file", {
      negotiated: true,
      id: 2,
      ordered: true,
    });
    fileCh.binaryType = "arraybuffer";

    controlCh.onopen = () => {
      for (const msg of pendingControl.splice(0)) {
        controlCh!.send(JSON.stringify(msg));
      }
    };

    fileCh.onopen = () => {
      const file = pendingFile;
      pendingFile = null;
      if (file) pumpFile(file.name, file.bytes);
    };

    if (opts.onFile) {
      const reassemble = makeReassembler(opts.onFile);
      fileCh.onmessage = (e: MessageEvent) => reassemble(e.data as Frame);
    }

    scrollCh.onmessage = (e: MessageEvent) => {
      const { r, s } = JSON.parse(e.data) as { r: number; s: number };
      if (s <= lastScrollSeq) return; // stale/out-of-order sample
      lastScrollSeq = s;
      opts.onScroll(r, s);
    };
    controlCh.onmessage = (e: MessageEvent) => {
      opts.onControl(JSON.parse(e.data) as ControlMessage);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) opts.sendSignal({ candidate: e.candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      const negotiating = pc!;
      try {
        makingOffer = true;
        await negotiating.setLocalDescription();
        // close() can land while setLocalDescription is in flight (e.g. the
        // viewer disconnects mid-offer); the connection we started
        // negotiating is then no longer the live one.
        if (pc !== negotiating) return;
        opts.sendSignal({ description: negotiating.localDescription! });
      } catch (err) {
        console.error("negotiation failed", err);
      } finally {
        makingOffer = false;
      }
    };

    if (opts.onStateChange) {
      pc.onconnectionstatechange = () =>
        opts.onStateChange!(pc!.connectionState);
    }
  }

  // Walks the frames of one file onto the channel, pausing whenever the send
  // buffer is full and resuming on "bufferedamountlow". Async rather than a
  // callback chain so the generator's position is just a local — nothing to
  // reset between transfers, and abandoning one is a generation bump.
  async function pumpFile(name: string, bytes: ArrayBuffer) {
    const ch = fileCh;
    if (!ch) return;
    const generation = ++fileGeneration;
    ch.bufferedAmountLowThreshold = FILE_BUFFER_LOW;

    for (const frame of chunkFile(name, bytes)) {
      if (generation !== fileGeneration || ch.readyState !== "open") return;
      if (ch.bufferedAmount > FILE_BUFFER_HIGH) {
        await new Promise<void>((resolve) => {
          ch.addEventListener("bufferedamountlow", () => resolve(), {
            once: true,
          });
        });
        if (generation !== fileGeneration || ch.readyState !== "open") return;
      }
      // The channel can still close between the check and the send (the viewer
      // closes its tab mid-transfer); that throws, and it isn't an error worth
      // propagating out of a fire-and-forget pump.
      try {
        if (typeof frame === "string") ch.send(frame);
        else ch.send(frame);
      } catch {
        return;
      }
    }
  }

  async function onSignal(msg: SignalEnvelope) {
    ensurePeerConnection();
    if (msg.description) {
      const collision = msg.description.type === "offer" &&
        (makingOffer || pc!.signalingState !== "stable");
      ignoreOffer = !opts.polite && collision;
      if (ignoreOffer) return;

      await pc!.setRemoteDescription(msg.description);
      if (msg.description.type === "offer") {
        await pc!.setLocalDescription();
        opts.sendSignal({ description: pc!.localDescription! });
      }
    } else if (msg.candidate) {
      try {
        await pc!.addIceCandidate(msg.candidate);
      } catch (err) {
        if (!ignoreOffer) throw err;
      }
    }
  }

  return {
    ensurePeerConnection,
    onSignal,
    sendScroll(ratio, seq) {
      if (scrollCh?.readyState === "open") {
        scrollCh.send(JSON.stringify({ r: ratio, s: seq }));
      }
    },
    sendControl(msg) {
      // A "pdf" carries an ArrayBuffer, which JSON.stringify flattens to `{}`
      // — the viewer would get a message of the right shape with no document
      // in it and nothing would report an error. Fail loudly instead.
      if (msg.type === "pdf") {
        throw new Error("send a pdf with sendFile, not sendControl");
      }
      if (controlCh?.readyState === "open") {
        controlCh.send(JSON.stringify(msg));
      } else {
        pendingControl.push(msg);
      }
    },
    sendFile(name, bytes) {
      if (fileCh?.readyState === "open") {
        pumpFile(name, bytes);
      } else {
        pendingFile = { name, bytes };
      }
    },
    close() {
      // Abandon any pump in flight before tearing the connection down, so it
      // doesn't wake from its bufferedamountlow wait onto a dead channel.
      fileGeneration++;
      pendingFile = null;
      pc?.close();
      pc = null;
      pendingControl.length = 0;
    },
  };
}

// How long to wait before re-opening a dropped signaling socket. Both roles
// reconnect: a viewer to find its controller again, a controller so it can
// still pick up viewers that join after the socket died.
const RETRY_DELAY_MS = 2000;

// --- Controller: one link per connected viewer ---------------------------

export interface ControllerCallbacks {
  onViewerJoined?(id: string): void;
  onViewerLeft?(id: string): void;
  onViewerControl?(id: string, msg: ControlMessage): void;
  onViewerScroll?(id: string, ratio: number, seq: number): void;
  onViewerState?(id: string, state: RTCPeerConnectionState): void;
  // Signaling-socket status. Existing peer connections keep working while
  // this is down, so without surfacing it the operator has no way to know
  // that new viewers can no longer be picked up.
  onSignalingStatus?(status: "connected" | "disconnected" | "denied"): void;
}

export interface ControllerLink {
  broadcast(msg: ControlMessage): void;
  sendTo(id: string, msg: ControlMessage): void;
  broadcastFile(name: string, bytes: ArrayBuffer): void;
  sendFileTo(id: string, name: string, bytes: ArrayBuffer): void;
  sendScroll(ratio: number): void;
  sendScrollTo(id: string, ratio: number): void;
  viewers(): string[];
  close(): void;
}

export function connectController(
  room: string,
  key: string,
  cb: ControllerCallbacks,
): ControllerLink {
  const links = new Map<string, Link>();
  let ws: WebSocket | null = null;
  let scrollSeq = 0;

  function addViewer(id: string) {
    if (links.has(id)) return;
    const link = makeLink({
      polite: false, // the controller always drives negotiation
      rtcConfig,
      sendSignal: (msg) => ws?.send(JSON.stringify({ ...msg, to: id })),
      onScroll: (r, s) => cb.onViewerScroll?.(id, r, s),
      onControl: (msg) => cb.onViewerControl?.(id, msg),
      onStateChange: (state) => cb.onViewerState?.(id, state),
    });
    links.set(id, link);
    link.ensurePeerConnection();
    cb.onViewerJoined?.(id);
  }

  function removeViewer(id: string) {
    const link = links.get(id);
    if (!link) return;
    link.close();
    links.delete(id);
    cb.onViewerLeft?.(id);
  }

  let rtcConfig: RTCConfiguration = { iceServers: [] };
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // The signaling socket dropping (server restart, sleep, wifi blip) leaves
  // established data channels working but silently stops new viewers from
  // ever being negotiated with, so it has to reconnect on its own.
  function scheduleRetry() {
    if (closed || retryTimer) return;
    cb.onSignalingStatus?.("disconnected");
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, RETRY_DELAY_MS);
  }

  function connect() {
    (async () => {
      rtcConfig = await fetchIceConfig();
      if (closed) return;
      ws = new WebSocket(wsURL(room, "controller", key));
      ws.addEventListener("open", () => cb.onSignalingStatus?.("connected"));
      ws.addEventListener("close", scheduleRetry);
      ws.addEventListener("error", scheduleRetry);
      ws.addEventListener("message", async (e) => {
        const msg = JSON.parse(e.data) as SignalEnvelope;
        switch (msg.kind) {
          case "welcome":
            return;
          case "denied":
            // Someone else holds this room's control key. Retrying would
            // only be refused again, so stop and surface it.
            closed = true;
            cb.onSignalingStatus?.("denied");
            return;
          case "viewer-list":
            (msg.peers ?? []).forEach(addViewer);
            return;
          case "peer-joined":
            if (msg.from) addViewer(msg.from);
            return;
          case "peer-left":
            if (msg.from) removeViewer(msg.from);
            return;
        }
        if (msg.from) await links.get(msg.from)?.onSignal(msg);
      });
    })();
  }

  connect();

  return {
    broadcast(msg) {
      for (const link of links.values()) link.sendControl(msg);
    },
    sendTo(id, msg) {
      links.get(id)?.sendControl(msg);
    },
    broadcastFile(name, bytes) {
      for (const link of links.values()) link.sendFile(name, bytes);
    },
    sendFileTo(id, name, bytes) {
      links.get(id)?.sendFile(name, bytes);
    },
    sendScroll(ratio) {
      scrollSeq++;
      for (const link of links.values()) link.sendScroll(ratio, scrollSeq);
    },
    sendScrollTo(id, ratio) {
      scrollSeq++;
      links.get(id)?.sendScroll(ratio, scrollSeq);
    },
    viewers() {
      return [...links.keys()];
    },
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      for (const link of links.values()) link.close();
      links.clear();
    },
  };
}

// --- Viewer: a single link to the controller, with reconnect -------------

export interface ViewerCallbacks {
  onControl?(msg: ControlMessage): void;
  onScroll?(ratio: number, seq: number): void;
  onFile?(name: string, data: ArrayBuffer): void;
  onStatus?(status: ConnState): void;
}

export interface ViewerLink {
  sendScroll(ratio: number): void;
  sendControl(msg: ControlMessage): void;
  close(): void;
}

export function connectViewer(room: string, cb: ViewerCallbacks): ViewerLink {
  let link: Link | null = null;
  let ws: WebSocket | null = null;
  let controllerID: string | null = null;
  let rtcConfig: RTCConfiguration = { iceServers: [] };
  let scrollSeq = 0;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // makeLink queues control sends once a Link exists but isn't open yet;
  // this queues the earlier gap — e.g. the constructor calling sendControl
  // before any peer-joined has even arrived to create a Link at all.
  const pendingControl: ControlMessage[] = [];

  function scheduleRetry() {
    if (closed || retryTimer) return;
    link?.close();
    link = null;
    controllerID = null;
    cb.onStatus?.("disconnected");
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, RETRY_DELAY_MS);
  }

  function connect() {
    (async () => {
      rtcConfig = await fetchIceConfig();
      if (closed) return;
      ws = new WebSocket(wsURL(room, "viewer"));
      ws.addEventListener("close", scheduleRetry);
      ws.addEventListener("error", scheduleRetry);
      ws.addEventListener("message", async (e) => {
        const msg = JSON.parse(e.data) as SignalEnvelope;
        switch (msg.kind) {
          case "welcome":
            return;
          case "waiting":
            cb.onStatus?.("waiting");
            return;
          case "peer-joined":
            if (!msg.from) return;
            // A controller reconnecting replaces the previous one; drop the
            // old peer connection rather than leaking it and its transports.
            link?.close();
            controllerID = msg.from;
            cb.onStatus?.("connecting");
            link = makeLink({
              polite: true, // the viewer always yields to the controller's offer
              rtcConfig,
              sendSignal: (m) =>
                ws?.send(JSON.stringify({ ...m, to: controllerID })),
              onScroll: (r, s) => cb.onScroll?.(r, s),
              onControl: (m) => cb.onControl?.(m),
              onFile: (n, d) => cb.onFile?.(n, d),
              onStateChange: (state) => {
                if (state === "connected") cb.onStatus?.("connected");
                else if (state === "disconnected" || state === "failed") {
                  cb.onStatus?.("disconnected");
                }
              },
            });
            for (const msg of pendingControl.splice(0)) link.sendControl(msg);
            return;
          case "peer-left":
            // Only act on the departure of the controller we're actually
            // connected to. An evicted controller's peer-left can arrive
            // after its replacement's peer-joined, and tearing down on that
            // would kill the link we just built to the new controller.
            if (msg.from && msg.from !== controllerID) return;
            link?.close();
            link = null;
            controllerID = null;
            cb.onStatus?.("waiting");
            return;
        }
        await link?.onSignal(msg);
      });
    })();
  }

  connect();

  return {
    sendScroll(ratio) {
      scrollSeq++;
      link?.sendScroll(ratio, scrollSeq);
    },
    sendControl(msg) {
      if (link) link.sendControl(msg);
      else pendingControl.push(msg);
    },
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      link?.close();
      pendingControl.length = 0;
    },
  };
}
