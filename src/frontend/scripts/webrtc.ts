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

type ConnState = "waiting" | "connecting" | "connected" | "disconnected";

function wsURL(room: string, role: "controller" | "viewer"): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&role=${role}`;
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
  close(): void;
}

interface LinkOptions {
  polite: boolean;
  rtcConfig: RTCConfiguration;
  sendSignal: (msg: SignalEnvelope) => void;
  onScroll: (ratio: number, seq: number) => void;
  onControl: (msg: ControlMessage) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

// makeLink owns exactly one RTCPeerConnection and its two negotiated data
// channels. It's used once per viewer on the controller side, and once
// (for the controller) on a viewer's side.
function makeLink(opts: LinkOptions): Link {
  let pc: RTCPeerConnection | null = null;
  let scrollCh: RTCDataChannel | null = null;
  let controlCh: RTCDataChannel | null = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let lastScrollSeq = 0;
  // A negotiated data channel isn't open the instant it's created — it
  // only opens once SDP/ICE negotiation completes. A caller (e.g. "bring
  // this newcomer up to date") can reasonably send control messages before
  // that finishes, so queue them rather than silently drop them.
  const pendingControl: ControlMessage[] = [];

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

    controlCh.onopen = () => {
      for (const msg of pendingControl.splice(0)) {
        controlCh!.send(JSON.stringify(msg));
      }
    };

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
      try {
        makingOffer = true;
        await pc!.setLocalDescription();
        opts.sendSignal({ description: pc!.localDescription! });
      } finally {
        makingOffer = false;
      }
    };

    if (opts.onStateChange) {
      pc.onconnectionstatechange = () => opts.onStateChange!(pc!.connectionState);
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
      if (controlCh?.readyState === "open") {
        controlCh.send(JSON.stringify(msg));
      } else {
        pendingControl.push(msg);
      }
    },
    close() {
      pc?.close();
      pc = null;
      pendingControl.length = 0;
    },
  };
}

// --- Controller: one link per connected viewer ---------------------------

export interface ControllerCallbacks {
  onViewerJoined?(id: string): void;
  onViewerLeft?(id: string): void;
  onViewerControl?(id: string, msg: ControlMessage): void;
  onViewerScroll?(id: string, ratio: number, seq: number): void;
  onViewerState?(id: string, state: RTCPeerConnectionState): void;
}

export interface ControllerLink {
  broadcast(msg: ControlMessage): void;
  sendTo(id: string, msg: ControlMessage): void;
  sendScroll(ratio: number): void;
  sendScrollTo(id: string, ratio: number): void;
  viewers(): string[];
  close(): void;
}

export function connectController(room: string, cb: ControllerCallbacks): ControllerLink {
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

  (async () => {
    rtcConfig = await fetchIceConfig();
    ws = new WebSocket(wsURL(room, "controller"));
    ws.addEventListener("message", async (e) => {
      const msg = JSON.parse(e.data) as SignalEnvelope;
      switch (msg.kind) {
        case "welcome":
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

  return {
    broadcast(msg) {
      for (const link of links.values()) link.sendControl(msg);
    },
    sendTo(id, msg) {
      links.get(id)?.sendControl(msg);
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
  onStatus?(status: ConnState): void;
}

export interface ViewerLink {
  sendScroll(ratio: number): void;
  sendControl(msg: ControlMessage): void;
  close(): void;
}

const RETRY_DELAY_MS = 2000;

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
            controllerID = msg.from;
            cb.onStatus?.("connecting");
            link = makeLink({
              polite: true, // the viewer always yields to the controller's offer
              rtcConfig,
              sendSignal: (m) => ws?.send(JSON.stringify({ ...m, to: controllerID })),
              onScroll: (r, s) => cb.onScroll?.(r, s),
              onControl: (m) => cb.onControl?.(m),
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
