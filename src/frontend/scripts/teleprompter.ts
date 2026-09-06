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

    this.link = connectController(this.roomID, {
      onViewerJoined: this.#onViewerJoined.bind(this),
      onViewerLeft: this.#onViewerLeft.bind(this),
      onViewerControl: this.#onViewerControl.bind(this),
      onViewerScroll: this.#onViewerScroll.bind(this),
      onViewerState: this.#onViewerState.bind(this),
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
      autoScroll: this.#autoScrollRunning,
    });
    this.#renderViewers();
  }

  #onViewerLeft(id: string) {
    this.viewers.delete(id);
    this.#renderViewers();
  }

  #onViewerControl(id: string, msg: ControlMessage) {
    if (msg.type !== "dims") return;
    const entry = this.viewers.get(id);
    if (!entry) return;
    entry.dims = { width: msg.width, height: msg.height };
    this.#renderViewers();
  }

  #onViewerScroll(id: string, ratio: number) {
    const entry = this.viewers.get(id);
    if (!entry?.canDrive) return;
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
        this.#pushSettings({ autoScroll: this.#autoScrollRunning });
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
    this.#pushSettings({ message: txtMessage.value || "" });
  }

  updateMain() {
    const content = this.editor.contentDOM.innerHTML;
    this.link.broadcast({ type: "content", html: content });
    this.#postToPreview({ type: "content", html: content });
  }
}
