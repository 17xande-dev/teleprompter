import {
  registerClockComponent,
  registerClockControlComponent,
  ResetEvent,
  TPClockControl,
} from "./clock.ts";

import WaSplitPanel from "@awesome.me/webawesome/dist/components/split-panel/split-panel.js";
import WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import WaIcon from "@awesome.me/webawesome/dist/components/icon/icon.js";
import WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";

// Prevent treeshaking so that these elements are initialised.
// TODO: Find a better way to do this.
const check = WaSplitPanel && WaButton && WaDialog && WaDropdown &&
  WaDropdownItem && WaIcon &&
  WaInput && WaSlider;
console.log(check != undefined);

// CSS imports
import "@awesome.me/webawesome/dist/styles/themes/shoelace.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";

import "../styles/style.css";
import { Doc, DocControls } from "./doc.ts";
import { WaSelectEvent } from "@awesome.me/webawesome";
import { Wordgard } from "wordgard/editor";
import { newEditor, restoreEditor, saveEditor } from "./editor.ts";
import { connectController, type ControllerLink } from "./webrtc.ts";
import type { ControlMessage } from "./protocol.ts";

interface ViewerEntry {
  dims: { width: number; height: number } | null;
  canDrive: boolean;
  state: RTCPeerConnectionState | "new";
}

export class Teleprompter {
  // The preview is rendered at a viewer's real pixel size and scaled down to
  // fit inside this box, so it stays a true miniature of that viewer.
  static readonly MAX_PREVIEW_WIDTH = 300;
  static readonly MAX_PREVIEW_HEIGHT = 450;
  // What the preview falls back to before any viewer has reported its size.
  static readonly DEFAULT_PREVIEW_DIMS = { width: 1920, height: 1080 };

  docControls: DocControls;
  splitPanel: WaSplitPanel;
  btnMessage: WaButton;
  editor: Wordgard;
  rngSpeed: WaSlider;
  rngScale: WaSlider;
  drpLayouts: WaDropdown;
  tpClockControl: TPClockControl;
  ifrmPreview: HTMLIFrameElement;
  divViewers: HTMLDivElement;
  lnkViewerLink: HTMLAnchorElement;
  controls: HTMLDivElement;
  editingName: string;
  btnPop: WaButton;

  roomID: string;
  link: ControllerLink;
  viewers = new Map<string, ViewerEntry>();

  #currentLayout = "theme-default";
  #currentMessage = "";
  #autoScrollRunning = true;

  constructor() {
    // Register web components.
    registerClockComponent();
    registerClockControlComponent();

    // Select elements.
    this.btnPop = document.querySelector("#btnPop")!;
    this.splitPanel = document.querySelector("wa-split-panel")!;
    this.btnMessage = document.querySelector("#btnMessage")!;
    this.rngSpeed = document.querySelector("#rngSpeed")!;
    this.rngScale = document.querySelector("#rngScale")!;
    this.controls = document.querySelector("#controls")!;
    this.tpClockControl = document.querySelector("#tpClockControl")!;
    this.drpLayouts = document.querySelector("#drpLayouts")!;
    this.ifrmPreview = <HTMLIFrameElement> document.querySelector("#ifrmPreview");
    this.divViewers = <HTMLDivElement> document.querySelector("#divViewers");
    this.lnkViewerLink = <HTMLAnchorElement> document.querySelector("#lnkViewerLink");

    this.roomID = this.#ensureRoomID();
    const viewerURL = `${location.origin}/html/pop.html?room=${this.roomID}`;
    this.lnkViewerLink.href = viewerURL;
    this.lnkViewerLink.textContent = viewerURL;
    // The iframe preview is a same-page mirror driven over postMessage, not
    // a WebRTC peer — it joins nothing and never appears in `viewers`.
    this.ifrmPreview.src = "/html/pop.html";

    this.link = connectController(this.roomID, this.#ensureControlKey(this.roomID), {
      onViewerJoined: this.#onViewerJoined.bind(this),
      onViewerLeft: this.#onViewerLeft.bind(this),
      onViewerControl: this.#onViewerControl.bind(this),
      onViewerScroll: this.#onViewerScroll.bind(this),
      onViewerState: this.#onViewerState.bind(this),
      onSignalingStatus: (status) => {
        document.documentElement.dataset.signaling = status;
        if (status === "denied") {
          console.error(
            `another control page already holds room ${this.roomID}`,
          );
        }
      },
    });

    this.editor = newEditor(
      document.querySelector("#editor")!,
      this.saveEditorContent.bind(this),
    );
    this.docControls = new DocControls();

    // Event listeners.
    // TODO: when docControls becomes a WebComponent, listen directly to it.
    this.docControls.drpDocuments.addEventListener(
      "new",
      () =>
        this.editor = newEditor(
          document.querySelector("#editor")!,
          this.saveEditorContent.bind(this),
        ),
    );

    this.docControls.drpDocuments.addEventListener(
      "load",
      (e: CustomEventInit<Doc>) => {
        if (!e.detail) {
          throw new Error("expecting Doc but got undefined?");
        }
        this.editor = restoreEditor(
          this.editor.dom.parentElement!,
          e.detail.content,
          this.saveEditorContent.bind(this),
        );
        this.updateMain();
      },
    );

    this.drpLayouts.addEventListener(
      "wa-select",
      this.listenLayoutSelect.bind(this),
    );

    this.docControls.loadDocument(
      this.docControls.docStorage.getCurrent().name,
    );

    this.btnPop.addEventListener("click", this.listenPop.bind(this));
    this.btnMessage.addEventListener("click", this.listenMessage.bind(this));
    this.rngSpeed.addEventListener("wheel", this.listenSpeedWheel.bind(this), {
      passive: false,
    });
    this.rngScale.addEventListener("wheel", this.listenScaleWheel.bind(this), {
      passive: false,
    });
    this.rngSpeed.addEventListener("input", this.listenRangeSpeed.bind(this));
    this.rngScale.addEventListener("input", this.listenRangeScale.bind(this));

    this.tpClockControl.addEventListener("start", () => this.#pushClock({ type: "clock", action: "start" }));
    this.tpClockControl.addEventListener("stop", () => this.#pushClock({ type: "clock", action: "stop" }));
    this.tpClockControl.addEventListener("reset", (event) => {
      const ev = event as ResetEvent;
      this.#pushClock({ type: "clock", action: "reset", time: ev.detail.time });
    });

    this.editingName = "";

    globalThis.addEventListener("keyup", this.listenKey.bind(this));

    this.ifrmPreview.addEventListener("load", () => {
      this.updateMain();
    });

    this.#applyPreviewScale();
    this.#renderViewers();
  }

  #ensureRoomID(): string {
    const params = new URLSearchParams(location.search);
    let room = params.get("room");
    if (!room) {
      room = crypto.randomUUID().slice(0, 8);
      params.set("room", room);
      history.replaceState(null, "", `${location.pathname}?${params}`);
    }
    return room;
  }

  // The control key never leaves this browser — it isn't in the viewer link,
  // so someone who has that link can join and watch but can't claim control
  // of the room and start pushing their own content to the displays. It
  // lives in localStorage so a refresh (or reopening the same room URL
  // later) reclaims the room rather than being locked out of it.
  #ensureControlKey(room: string): string {
    const storageKey = `teleprompter.controlKey.${room}`;
    let key: string | null = null;
    try {
      key = localStorage.getItem(storageKey);
    } catch {
      // Private mode or blocked storage: fall through to a per-load key.
    }
    if (!key) {
      key = crypto.randomUUID();
      try {
        localStorage.setItem(storageKey, key);
      } catch {
        // Not persistable; this session still controls the room, but a
        // refresh will be refused until the room empties out.
      }
    }
    return key;
  }

  #postToPreview(msg: ControlMessage) {
    this.ifrmPreview.contentWindow?.postMessage(msg, location.origin);
  }

  #pushSettings(patch: Omit<ControlMessage & { type: "settings" }, "type">) {
    const msg: ControlMessage = { type: "settings", ...patch };
    this.link.broadcast(msg);
    this.#postToPreview(msg);
  }

  #pushClock(msg: ControlMessage) {
    this.link.broadcast(msg);
    this.#postToPreview(msg);
  }

  #onViewerJoined(id: string) {
    this.viewers.set(id, { dims: null, canDrive: false, state: "new" });
    // Bring the newcomer up to date rather than leaving it blank until the
    // next edit/setting change.
    this.link.sendTo(id, { type: "content", html: this.editor.contentDOM.innerHTML });
    this.link.sendTo(id, {
      type: "settings",
      speed: -this.rngSpeed.value,
      textScale: this.rngScale.value / 10,
      layout: this.#currentLayout,
      message: this.#currentMessage,
    });
    // A newcomer may be the only viewer (making it the pacer) or one more
    // follower; either way the roles need recomputing.
    this.#applyScrollRoles();
    this.#applyPreviewScale();
    this.#renderViewers();
  }

  #onViewerLeft(id: string) {
    this.viewers.delete(id);
    // This may have been the pacer; whoever is left has to take over.
    this.#applyScrollRoles();
    // The preview may have been mirroring this viewer; re-fit to whoever
    // is left (or the fallback size if that was the last one).
    this.#applyPreviewScale();
    this.#renderViewers();
  }

  #onViewerControl(id: string, msg: ControlMessage) {
    if (msg.type !== "dims") return;
    const entry = this.viewers.get(id);
    if (!entry) return;
    entry.dims = { width: msg.width, height: msg.height };
    this.#applyPreviewScale();
    this.#renderViewers();
  }

  // Which viewer the preview mirrors — geometry and scroll both. A viewer
  // granted drive is the canonical one to show; otherwise just the first
  // one that connected. Viewers can differ in size, so the preview has to
  // pick one rather than pretend they share a shape.
  #previewSourceID(): string | null {
    for (const [id, entry] of this.viewers) {
      if (entry.canDrive) return id;
    }
    return this.viewers.keys().next().value ?? null;
  }

  // Render the iframe at the previewed viewer's real pixel size and scale
  // it down, so text wraps and vi-based sizing match what that viewer is
  // actually showing. Sizing it directly to the small on-screen box instead
  // would reflow the content and make the preview a lie.
  #applyPreviewScale() {
    const source = this.#previewSourceID();
    const dims = (source && this.viewers.get(source)?.dims) ||
      Teleprompter.DEFAULT_PREVIEW_DIMS;

    const scale = Math.min(
      Teleprompter.MAX_PREVIEW_WIDTH / dims.width,
      Teleprompter.MAX_PREVIEW_HEIGHT / dims.height,
    );

    const container = <HTMLDivElement> this.ifrmPreview.parentElement;
    container.style.width = `${dims.width * scale}px`;
    container.style.height = `${dims.height * scale}px`;

    this.ifrmPreview.style.width = `${dims.width}px`;
    this.ifrmPreview.style.height = `${dims.height}px`;
    this.ifrmPreview.style.transform = `scale(${scale})`;
    this.ifrmPreview.style.transformOrigin = "top left";
  }

  // Only the pacing viewer integrates the scroll speed itself; everyone
  // else mirrors the position it reports. Independent auto-scroll loops
  // would each run off their own clock and drift apart within a minute
  // with nothing to pull them back together.
  #applyScrollRoles() {
    const pacer = this.#previewSourceID();
    for (const id of this.link.viewers()) {
      this.link.sendTo(id, {
        type: "settings",
        autoScroll: id === pacer && this.#autoScrollRunning,
      });
    }
  }

  #onViewerScroll(id: string, ratio: number) {
    if (!this.viewers.has(id)) return;
    if (id !== this.#previewSourceID()) return;

    // The pacing viewer's position goes out to everyone else on every
    // sample it sends — ~60 a second, on the unreliable channel, applied
    // instantly at the far end. That high rate is what makes it feel
    // smooth; throttling it or easing between samples only adds lag (this
    // is how webrtc-go does it, and it's why that version feels immediate).
    this.#postToPreview({ type: "scroll", r: ratio, s: 0 });
    for (const otherID of this.link.viewers()) {
      if (otherID !== id) this.link.sendScrollTo(otherID, ratio);
    }
  }

  #onViewerState(id: string, state: RTCPeerConnectionState) {
    const entry = this.viewers.get(id);
    if (!entry) return;
    entry.state = state;
    this.#renderViewers();
  }

  #setDriver(id: string, canDrive: boolean) {
    const entry = this.viewers.get(id);
    if (!entry) return;
    entry.canDrive = canDrive;
    this.link.sendTo(id, { type: "set-driver", canDrive });
    // Granting drive changes which viewer paces the scroll, and which one
    // the preview follows.
    this.#applyScrollRoles();
    this.#applyPreviewScale();
    this.#renderViewers();
  }

  #renderViewers() {
    this.divViewers.innerHTML = "";
    for (const [id, entry] of this.viewers) {
      const row = document.createElement("div");
      row.className = "viewer-row";

      const label = document.createElement("span");
      label.className = "viewer-id";
      const dims = entry.dims ? `${entry.dims.width}×${entry.dims.height}` : "…";
      label.textContent = `${id.slice(0, 6)} (${dims})`;
      row.appendChild(label);

      const state = document.createElement("span");
      state.className = "viewer-state";
      state.textContent = entry.state;
      row.appendChild(state);

      const label2 = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.canDrive;
      checkbox.addEventListener(
        "change",
        () => this.#setDriver(id, checkbox.checked),
      );
      label2.appendChild(checkbox);
      label2.appendChild(document.createTextNode("allow drive"));
      row.appendChild(label2);

      this.divViewers.appendChild(row);
    }
  }

  saveEditorContent(editor: Wordgard) {
    const content = JSON.stringify(saveEditor(editor));
    this.docControls.docStorage.setCurrentContent(content);
    this.docControls.docStorage.save();
    // Content now travels over a live data channel rather than a manual
    // "update" action, so every edit is a good moment to push it.
    this.updateMain();
  }

  async listenPop() {
    const screenDetails = await self.getScreenDetails();
    const secondary = screenDetails.screens.find((s) => !s.isPrimary);
    const dims = secondary
      ? { width: secondary.width, height: secondary.height, x: secondary.left, y: secondary.top }
      : { width: 800, height: 600, x: 100, y: 100 };

    const win = self.open(
      `/html/pop.html?room=${this.roomID}`,
      "pop",
      `popup=true,width=${dims.width},height=${dims.height},screenX=${dims.x},screenY=${dims.y}`,
    );
    if (!win) {
      throw new Error("can't open window");
    }
  }

  listenLayoutSelect(e: WaSelectEvent) {
    const item = e.detail.item as WaDropdownItem;
    this.#currentLayout = item.value;
    this.#pushSettings({ layout: this.#currentLayout });
  }

  listenSpeedWheel(e: WheelEvent) {
    e.preventDefault();
    this.rngSpeed.value += -e.deltaY;
    this.#pushSettings({ speed: -this.rngSpeed.value });
  }

  listenRangeSpeed() {
    this.#pushSettings({ speed: -this.rngSpeed.value });
  }

  listenScaleWheel(e: WheelEvent) {
    e.preventDefault();
    const scale = this.rngScale.value += -e.deltaY / 30;
    this.rngScale.value = scale;
    this.#pushSettings({ textScale: scale / 10 });
  }

  listenRangeScale() {
    this.#pushSettings({ textScale: this.rngScale.value / 10 });
  }

  listenKey(ke: KeyboardEvent) {
    if (this.editor.hasFocus) return;

    switch (ke.code) {
      case "Space":
        ke.preventDefault();
        this.#autoScrollRunning = !this.#autoScrollRunning;
        this.#applyScrollRoles();
        break;
      default:
        // ignore for now
    }
  }

  listenMessage() {
    const txtMessage: WaInput = document.querySelector("#txtMessage")!;
    if (!txtMessage) {
      throw new Error("No Message input found.");
    }
    this.#currentMessage = txtMessage.value || "";
    this.#pushSettings({ message: this.#currentMessage });
  }

  updateMain() {
    const content = this.editor.contentDOM.innerHTML;
    this.link.broadcast({ type: "content", html: content });
    this.#postToPreview({ type: "content", html: content });
  }
}
