import {
  registerClockComponent,
  registerClockControlComponent,
  ResetEvent,
  TPClockControl,
} from "./clock.ts";

import WaSplitPanel from "@awesome.me/webawesome/dist/components/split-panel/split-panel.js";
import WaBadge from "@awesome.me/webawesome/dist/components/badge/badge.js";
import WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import WaButtonGroup from "@awesome.me/webawesome/dist/components/button-group/button-group.js";
import WaCallout from "@awesome.me/webawesome/dist/components/callout/callout.js";
import WaCard from "@awesome.me/webawesome/dist/components/card/card.js";
import WaCopyButton from "@awesome.me/webawesome/dist/components/copy-button/copy-button.js";
import WaDetails from "@awesome.me/webawesome/dist/components/details/details.js";
import WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import WaDivider from "@awesome.me/webawesome/dist/components/divider/divider.js";
import WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import WaIcon from "@awesome.me/webawesome/dist/components/icon/icon.js";
import WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import WaQrCode from "@awesome.me/webawesome/dist/components/qr-code/qr-code.js";
import WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import WaTag from "@awesome.me/webawesome/dist/components/tag/tag.js";

// Prevent treeshaking so that these elements are initialised. `void` rather
// than the console.log this used to end in, which printed "true" into the
// operator's console on every page load; referencing the bindings is the part
// that does the work.
// TODO: Find a better way to do this.
void (WaSplitPanel && WaBadge && WaButton && WaButtonGroup && WaCallout &&
  WaCard && WaCopyButton && WaDetails && WaDialog && WaDivider &&
  WaDropdown && WaDropdownItem && WaIcon && WaInput && WaQrCode && WaSlider &&
  WaSwitch && WaTag);

// CSS imports
import "@awesome.me/webawesome/dist/styles/themes/shoelace.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";

import "../styles/style.css";
import type { Doc } from "./doc.ts";
import { DocControls } from "./docControls.ts";
import { Wordgard } from "wordgard/editor";
import { newEditor, restoreEditor, saveEditor } from "./editor.ts";
import {
  buildCommands,
  documentCommands,
  layoutCommands,
} from "./controlCommands.ts";
import { PaletteControls } from "./paletteControls.ts";
import { SettingsControls } from "./settingsControls.ts";
import { GamepadControls } from "./gamepadControls.ts";
import { connectController, type ControllerLink } from "./webrtc.ts";
import { type PdfView, renderPdf } from "./pdfview.ts";
import { ratioOf, setRatio } from "./scrollsync.ts";
import {
  clampTextScale,
  matchedEditorFontPx,
  matchedViewerTextScale,
  pxToTenths,
  tenthsToRem,
} from "./textscale.ts";
import { LOCAL_CHANNEL } from "./protocol.ts";
import type { ControlMessage, ThemeMessage } from "./protocol.ts";
import { wheelStep } from "./settings.ts";
import { ThemeControls } from "./themeControls.ts";

interface ViewerEntry {
  dims: { width: number; height: number } | null;
  state: RTCPeerConnectionState | "new";
  // Whether this display is on this machine. Null until its first dims
  // report, the same "not known yet" the dimensions themselves start at.
  local: boolean | null;
}

export class Teleprompter {
  // What the preview falls back to when its box cannot be measured — before
  // first layout, or if the sidebar is collapsed to nothing. The real limits
  // are #divPreviewBox's own size, which is what lets the preview grow with
  // the sidebar rather than sitting at whatever looked right once.
  static readonly MAX_PREVIEW_WIDTH = 300;
  static readonly MAX_PREVIEW_HEIGHT = 450;
  // What the preview falls back to before any viewer has reported its size.
  static readonly DEFAULT_PREVIEW_DIMS = { width: 1920, height: 1080 };
  // Where the operator's own reading size is remembered between sessions.
  static readonly EDITOR_SCALE_KEY = "teleprompter.editorScale";
  // Text Scale slider position that means "fit the PDF to the viewer's width"
  // — the slider reports tenths, and viewer.ts reads a textScale of 1 as fit.
  static readonly PDF_FIT_SCALE = 10;

  docControls: DocControls;
  splitPanel: WaSplitPanel;
  btnMessage: WaButton;
  editor: Wordgard;
  rngSpeed: WaSlider;
  rngScale: WaSlider;
  rngEditor: WaSlider;
  themeControls: ThemeControls;
  tpClockControl: TPClockControl;
  ifrmPreview: HTMLIFrameElement;
  divViewers: HTMLDivElement;
  lnkViewerLink: HTMLAnchorElement;
  controls: HTMLDivElement;
  btnPop: WaButton;
  btnGoToViewers: WaButton;
  btnSendPosition: WaButton;
  btnMatchScale: WaButton;
  btnSendScale: WaButton;
  btnPushContent: WaButton;
  palette: PaletteControls;
  padControls: GamepadControls;
  settings: SettingsControls;

  roomID: string;
  link: ControllerLink;
  viewers = new Map<string, ViewerEntry>();

  #currentMessage = "";
  #autoScrollRunning = true;
  // What the displays are actually showing, as opposed to what is in the
  // editor. The two are the same thing while live editing is on and have to
  // be told apart while it is off — a display that reloads mid-service must
  // come back showing what the others show, not the operator's draft.
  #publishedHtml = "";
  // Whether the editor has run ahead of #publishedHtml. Only ever true while
  // live editing is off, and the only reason the operator can see that there
  // is something to push.
  #draftHeld = false;
  // Whether anything has been published this session. See updateMain.
  #everPublished = false;
  // The one spelling of the URL a display joins on. The anchor, the copy
  // button, the QR code and the local screen window all read this field.
  #viewerURL = "";
  // The local screen this page opened, while it is open. A handle rather than
  // a boolean because the button closes it as well as opening it — and it is
  // deliberately *not* derived from "some local viewer exists": that is the
  // same thing in practice, but only this is something the page can close.
  #popWin: Window | null = null;
  // Closing a popup fires nothing in the opener, so the only way to notice is
  // to ask. Cleared with the window it was watching.
  #popWatch: ReturnType<typeof setInterval> | undefined;
  // The pacer's most recent position. Viewers only learn where everyone is
  // from the pacer's next sample, and while the scroll is paused (or the
  // speed is 0) there isn't one — so a viewer that joins or reconnects would
  // sit at the top of the document until someone started scrolling again.
  #lastRatio = 0;
  // The operator's explicit pick of which viewer the preview mirrors. Null
  // means "no preference" — fall back to whoever connected first, which is
  // what a single-viewer setup wants and never needs to think about.
  #chosenPreviewID: string | null = null;
  // And which viewer may be scrolled by hand, in the same shape. Null means
  // "no preference" — the first to connect drives, which is what a
  // single-viewer setup wants and never has to think about.
  #chosenDriverID: string | null = null;

  // A dropped PDF takes over from the editor for the rest of the session. It
  // is held in memory only — deliberately never written to DocStorage, whose
  // localStorage backing has a ~5MB quota that a PDF would blow straight
  // through, taking the operator's text documents with it.
  #pdfName: string | null = null;
  #pdfBytes: ArrayBuffer | null = null;
  #pdfView: PdfView | null = null;
  #pdfResize: ResizeObserver | null = null;
  #previewBox: HTMLElement;
  #swLiveEditing: WaSwitch;
  #icnHeld: HTMLElement;
  // Where the divider sits when not in the mobile one-pane-at-a-time layout,
  // which overwrites `position` with 0 or 100. Seeded in #wirePaneToggle.
  #desktopSplit = 0;
  // The app bar's status half. All four are display-only — nothing reads back
  // out of them — so they are looked up once and written to.
  #bdgSignaling: WaBadge;
  // Half of what the status badge shows; the other half is viewers.size.
  // Starts "disconnected" because that is true until the socket opens.
  #signaling: "connected" | "disconnected" | "denied" = "disconnected";
  #spnViewerNum: HTMLElement;
  #outSpeed: HTMLOutputElement;
  #outScale: HTMLOutputElement;
  #outEditor: HTMLOutputElement;
  // Where each slider goes back to on a right-click. Read out of the markup
  // once, in the constructor, so the HTML stays the single source of the
  // defaults — and captured *before* the stored editor size is applied, or
  // "reset" would return to whatever the operator last dragged to.
  #sliderDefaults = new Map<WaSlider, number>();
  #pdfPane: HTMLDivElement;
  #pdfPages: HTMLElement;
  #btnClosePdf: WaButton;

  constructor() {
    // Register web components.
    registerClockComponent();
    registerClockControlComponent();

    // Select elements.
    this.btnPop = document.querySelector("#btnPop")!;
    this.btnGoToViewers = document.querySelector("#btnGoToViewers")!;
    this.btnSendPosition = document.querySelector("#btnSendPosition")!;
    this.btnMatchScale = document.querySelector("#btnMatchScale")!;
    this.btnSendScale = document.querySelector("#btnSendScale")!;
    this.btnPushContent = document.querySelector("#btnPushContent")!;
    this.#swLiveEditing = document.querySelector("#swLiveEditing")!;
    this.#icnHeld = document.querySelector("#icnHeld")!;
    this.splitPanel = document.querySelector("wa-split-panel")!;
    this.btnMessage = document.querySelector("#btnMessage")!;
    this.rngSpeed = document.querySelector("#rngSpeed")!;
    this.rngScale = document.querySelector("#rngScale")!;
    this.rngEditor = document.querySelector("#rngEditor")!;
    this.controls = document.querySelector("#controls")!;
    this.tpClockControl = document.querySelector("#tpClockControl")!;
    this.#pdfPane = <HTMLDivElement> document.querySelector("#pdfPane");
    this.#pdfPages = <HTMLElement> document.querySelector("#pdfPages");
    this.#btnClosePdf = document.querySelector("#btnClosePdf")!;
    this.ifrmPreview = <HTMLIFrameElement> document.querySelector(
      "#ifrmPreview",
    );
    this.#previewBox = <HTMLElement> document.querySelector("#divPreviewBox");
    this.divViewers = <HTMLDivElement> document.querySelector("#divViewers");
    this.lnkViewerLink = <HTMLAnchorElement> document.querySelector(
      "#lnkViewerLink",
    );
    this.#bdgSignaling = document.querySelector("#bdgSignaling")!;
    this.#spnViewerNum = <HTMLElement> document.querySelector("#spnViewerNum");
    this.#outSpeed = <HTMLOutputElement> document.querySelector("#outSpeed");
    this.#outScale = <HTMLOutputElement> document.querySelector("#outScale");
    this.#outEditor = <HTMLOutputElement> document.querySelector("#outEditor");

    for (const slider of [this.rngSpeed, this.rngScale, this.rngEditor]) {
      this.#sliderDefaults.set(slider, slider.value);
    }
    this.#restoreEditorScale();

    this.roomID = this.#ensureRoomID();
    document.querySelector("#tagRoom")!.textContent = this.roomID;
    this.#viewerURL = `${location.origin}/html/viewer.html?room=${this.roomID}`;
    this.lnkViewerLink.href = this.#viewerURL;
    this.lnkViewerLink.textContent = this.#viewerURL;
    // The copy button, the QR code and the local screen window are all handed
    // this one string rather than building their own, so none of the four can
    // disagree about which room a display would be joining.
    (<WaCopyButton> document.querySelector("#btnCopyLink")).value =
      this.#viewerURL;
    (<WaQrCode> document.querySelector("#qrViewerLink")).value =
      this.#viewerURL;
    // The iframe preview is a same-page mirror driven over postMessage, not
    // a WebRTC peer — it joins nothing and never appears in `viewers`.
    this.ifrmPreview.src = "/html/viewer.html";

    this.link = connectController(
      this.roomID,
      this.#ensureControlKey(this.roomID),
      {
        onViewerJoined: this.#onViewerJoined.bind(this),
        onViewerLeft: this.#onViewerLeft.bind(this),
        onViewerControl: this.#onViewerControl.bind(this),
        onViewerScroll: this.#onViewerScroll.bind(this),
        onViewerState: this.#onViewerState.bind(this),
        onSignalingStatus: (status) => {
          document.documentElement.dataset.signaling = status;
          this.#signaling = status;
          this.#renderStatus();
          if (status === "denied") {
            console.error(
              `another control page already holds room ${this.roomID}`,
            );
          }
        },
      },
    );

    this.editor = newEditor(
      document.querySelector("#editor")!,
      this.saveEditorContent.bind(this),
    );
    this.docControls = new DocControls();
    // Before the commands are built, which take it on the host — and before
    // any wheel event, which asks it which way to move a thumb.
    this.settings = new SettingsControls();

    // Event listeners.
    // TODO: when docControls becomes a WebComponent, listen directly to it.
    this.docControls.drpDocuments.addEventListener(
      "new",
      () => {
        this.editor = newEditor(
          document.querySelector("#editor")!,
          this.saveEditorContent.bind(this),
        );
        // As the "load" handler below does. Without this a new document left
        // the displays on the previous script until the first keystroke, so
        // "New document" mid-service showed the talent the wrong page and
        // nothing said why.
        this.updateMain();
      },
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

    // ThemeControls owns the layout dropdown and its dialogs, and reports the
    // resulting layout as one message — including while the operator is typing
    // CSS, which is what makes the preview a live feedback loop.
    this.themeControls = new ThemeControls();
    this.themeControls.drpLayouts.addEventListener("theme", (e) => {
      this.#pushTheme((<CustomEvent<ThemeMessage>> e).detail);
    });

    this.docControls.loadCurrent();

    this.btnPop.addEventListener("click", this.listenPop.bind(this));
    // How a local screen this page did not open — because the page has since
    // reloaded — gets picked back up. See #listenPopHello.
    self.addEventListener("message", this.#listenPopHello.bind(this));
    this.#answerLocalProbes();
    this.btnMessage.addEventListener("click", this.listenMessage.bind(this));
    this.btnGoToViewers.addEventListener(
      "click",
      () => this.goToViewerPosition(),
    );
    this.btnSendPosition.addEventListener("click", () => this.sendMyPosition());
    this.btnMatchScale.addEventListener(
      "click",
      () => this.matchTextScaleFromViewers(),
    );
    this.btnSendScale.addEventListener("click", () => this.sendMyTextScale());
    this.btnPushContent.addEventListener("click", () => this.pushContent());
    // The switch reports the operator's intent; toggleLiveEditing owns what
    // that means, so the palette command and this click cannot diverge.
    this.#swLiveEditing.addEventListener("change", () => {
      if (this.#swLiveEditing.checked !== this.settings.liveEditing) {
        this.toggleLiveEditing();
      }
    });
    this.rngSpeed.addEventListener("wheel", this.listenSpeedWheel.bind(this), {
      passive: false,
    });
    this.rngScale.addEventListener("wheel", this.listenScaleWheel.bind(this), {
      passive: false,
    });
    this.rngEditor.addEventListener(
      "wheel",
      this.listenEditorWheel.bind(this),
      { passive: false },
    );
    this.rngSpeed.addEventListener("input", this.listenRangeSpeed.bind(this));
    this.rngScale.addEventListener("input", this.listenRangeScale.bind(this));
    this.rngEditor.addEventListener("input", () => this.#applyEditorScale());
    // Right-click resets a slider. There is nothing else a context menu on a
    // slider could usefully offer, and the palette's "Reset sliders" covers
    // the operator who never thinks to try it.
    for (const slider of this.#sliderDefaults.keys()) {
      slider.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.resetSlider(slider);
      });
    }

    this.tpClockControl.addEventListener(
      "start",
      () => this.#pushClock({ type: "clock", action: "start" }),
    );
    this.tpClockControl.addEventListener(
      "stop",
      () => this.#pushClock({ type: "clock", action: "stop" }),
    );
    this.tpClockControl.addEventListener("reset", (event) => {
      const ev = event as ResetEvent;
      this.#pushClock({ type: "clock", action: "reset", time: ev.detail.time });
    });

    this.#wirePdfDrop();
    this.#btnClosePdf.addEventListener("click", () => this.closePdf());

    // Last, deliberately: the commands press the controls above, so every
    // seam they reach for has to exist by now. The palette also installs the
    // key bindings, which is why there is no keyup listener here any more.
    const commands = buildCommands(this);
    this.palette = new PaletteControls(commands, {
      isEditorFocused: () => this.editor.hasFocus,
      providers: [
        () => documentCommands(this.docControls),
        () => layoutCommands(this.themeControls),
      ],
    });

    // Handed the *same* bound list the palette got, so a controller button and
    // the palette row and the keyboard shortcut all run one function.
    this.padControls = new GamepadControls(commands, this, {
      indicator: document.querySelector<WaIcon>("#icnGamepad") ?? undefined,
    });

    this.ifrmPreview.addEventListener("load", () => {
      // The iframe starts on the built-in default in its own markup, so a
      // persisted custom layout has to be pushed to it the same way a real
      // viewer gets it on join.
      this.#postToPreview(this.themeControls.themeMessage());
      // And the same for the text scale, for the same reason. Without it the
      // preview never receives a textScale at all, so its `font-size:
      // var(--textScale)` is invalid at computed-value time and inherits 16px
      // while every real viewer sits at whatever the slider says — the preview
      // was lying about the one thing it exists to show.
      this.#postToPreview({
        type: "settings",
        textScale: this.rngScale.value / 10,
      });
      // The published script, not the editor's: the preview is a mirror of
      // what the displays show, which is the one thing it exists for.
      this.#pushPublished();
    });

    // The preview fits the box it is given, so it has to be refitted whenever
    // that box changes size — dragging the split panel, resizing the window,
    // or the sidebar reflowing as viewer rows come and go. A ResizeObserver
    // catches all three; a window resize listener would catch only one. It
    // cannot loop: the box's size is CSS's, and #applyPreviewScale only ever
    // writes to the container inside it.
    new ResizeObserver(() => this.#applyPreviewScale()).observe(
      this.#previewBox,
    );

    // Same entry point Ctrl+K uses (see controlCommands.ts), so the bar button
    // and the shortcut cannot open different things. Wired after the palette
    // is constructed, for the same reason the commands read through the host.
    document.querySelector("#btnPalette")!.addEventListener(
      "click",
      () => this.palette.open("all"),
    );

    this.#trackAppBarHeight();
    this.#wirePaneToggle();

    this.#applyPreviewScale();
    this.#renderViewers();
    this.#renderTransport();
    this.#renderPop();
    this.#renderLive();
  }

  /**
   * Publish the app bar's measured height as --app-bar-height.
   *
   * Both panes are sized as the viewport minus that (--pane-height), so the
   * number has to be the bar's *real* height rather than the one it was
   * designed to be. The bar wraps rather than clipping when it runs short of
   * width, and a viewer's larger default font or browser zoom can push it over
   * too — in either case the panes have to give up the row it gained, or they
   * hang off the bottom of the viewport.
   *
   * It cannot loop: the bar's own height comes from its content and a constant
   * floor in CSS, never from the property written here. (Same discipline as
   * #applyPreviewScale, which measures the box it never writes to.)
   */
  #trackAppBarHeight() {
    const bar = <HTMLElement> document.querySelector("#appBar");
    const publish = () => {
      document.documentElement.style.setProperty(
        "--app-bar-height",
        `${bar.getBoundingClientRect().height}px`,
      );
    };
    new ResizeObserver(publish).observe(bar);
    publish();
  }

  /**
   * The mobile layout's pane toggle: below 48rem the two panes are shown one at
   * a time instead of side by side.
   *
   * The split panel is *asked* for that rather than overridden. It writes its
   * grid columns as an inline style computed from `position`, so a stylesheet
   * could only beat it with !important — but setting `position` to 0 or 100 is
   * the component's own way of giving one pane everything, and needs no fight.
   * CSS then hides the other pane's content (see the mobile section of
   * style.css); the attribute on <html> is what those rules key off.
   *
   * The desktop position is saved on the way into mobile and put back on the
   * way out, so a divider the operator had dragged survives a rotation — and,
   * more to the point, returning from mobile can't leave the script pane at
   * zero width with no divider left on screen to drag it back.
   */
  #wirePaneToggle() {
    const script = document.querySelector<WaButton>("#btnPaneScript")!;
    const controls = document.querySelector<WaButton>("#btnPaneControls")!;
    // Kept in step with the breakpoint in style.css's mobile section.
    const mobile = matchMedia("(width < 48rem)");

    // Read off the attribute rather than the property: this runs at the end of
    // the constructor, where the component may not have upgraded and parsed one
    // into the other yet. Taken from the markup either way, so the starting
    // split is written down once — 50 is wa-split-panel's own default, for the
    // case where the attribute is dropped.
    this.#desktopSplit = Number(
      this.splitPanel.getAttribute("position") ?? 50,
    );

    const apply = () => {
      const pane = document.documentElement.dataset.pane === "script"
        ? "script"
        : "controls";
      // Filled *and* branded: outlined-blue against outlined-grey is a
      // difference an operator has to look for, and a neutral fill reads as
      // disabled. This is the control that says which half of the app they are
      // in, so it gets the loudest state the theme has.
      for (
        const [btn, on] of [[script, pane === "script"], [
          controls,
          pane === "controls",
        ]] as const
      ) {
        btn.appearance = on ? "accent" : "outlined";
        btn.variant = on ? "brand" : "neutral";
        btn.setAttribute("aria-pressed", String(on));
      }
      this.splitPanel.position = mobile.matches
        ? (pane === "script" ? 100 : 0)
        : this.#desktopSplit;
    };

    const show = (pane: "script" | "controls") => {
      document.documentElement.dataset.pane = pane;
      apply();
    };

    script.addEventListener("click", () => show("script"));
    controls.addEventListener("click", () => show("controls"));
    mobile.addEventListener("change", (e) => {
      // Read before apply() overwrites it with an all-or-nothing position.
      if (e.matches) this.#desktopSplit = this.splitPanel.position;
      apply();
    });

    // Takes the starting pane from the markup rather than choosing one here, so
    // the attribute and this cannot disagree about which comes up first.
    apply();
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

  // Drop is wired on the whole editor pane rather than the editor element: in
  // PDF mode the editor is hidden, and the operator still needs somewhere to
  // drop a replacement.
  #wirePdfDrop() {
    const pane = <HTMLElement> document.querySelector("#mainEditor");

    pane.addEventListener("dragover", (e: DragEvent) => {
      if (!this.#pdfInTransfer(e.dataTransfer)) return;
      // Without preventDefault on *dragover* the drop never fires and the
      // browser navigates to the file instead.
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      pane.classList.add("drop-target");
    });

    const clear = () => pane.classList.remove("drop-target");
    pane.addEventListener("dragleave", clear);
    pane.addEventListener("drop", async (e: DragEvent) => {
      clear();
      const file = [...(e.dataTransfer?.files ?? [])].find(
        (f) => f.type === "application/pdf",
      );
      if (!file) return;
      e.preventDefault();
      await this.openPdf(file.name, await file.arrayBuffer());
    });
  }

  #pdfInTransfer(dt: DataTransfer | null): boolean {
    // During a drag the file list is empty for security reasons; only the
    // item *types* are readable.
    return [...(dt?.items ?? [])].some((i) => i.type === "application/pdf");
  }

  async openPdf(name: string, bytes: ArrayBuffer) {
    this.#pdfName = name;
    this.#pdfBytes = bytes;

    // Text Scale becomes a PDF zoom, where 1 is fit-to-width. Whatever the
    // slider was set to for text is meaningless here and would typically land
    // the document at 25% of the display, so reset the control and the
    // viewers together rather than letting them disagree.
    this.rngScale.value = Teleprompter.PDF_FIT_SCALE;
    this.#pushSettings({ textScale: Teleprompter.PDF_FIT_SCALE / 10 });

    this.link.broadcastFile(name, bytes);
    // The preview is same-origin and same-process, so it takes the bytes
    // whole — postMessage structured-clones an ArrayBuffer.
    this.#postToPreview({ type: "pdf", name, data: bytes });

    document.querySelector("#editor")!.classList.add("hidden");
    this.#pdfPane.hidden = false;
    document.querySelector("#pdfName")!.textContent = name;

    this.#pdfView?.destroy();
    const pages = this.#pdfPages;
    this.#pdfView = await renderPdf(pages, bytes, pages.clientWidth);

    // The operator's pane always fits the width — it isn't scroll-synced, so
    // there's nothing for the zoom control to keep in step here. Dragging the
    // split panel would otherwise leave the pages at their old size.
    this.#pdfResize ??= new ResizeObserver(() => {
      this.#pdfView?.setWidth(pages.clientWidth);
    });
    this.#pdfResize.observe(pages);
  }

  closePdf() {
    this.#pdfName = null;
    this.#pdfBytes = null;
    this.#pdfResize?.disconnect();
    this.#pdfView?.destroy();
    this.#pdfView = null;

    this.#pdfPane.hidden = true;
    document.querySelector("#editor")!.classList.remove("hidden");

    this.link.broadcast({ type: "pdf-clear" });
    this.#postToPreview({ type: "pdf-clear" });
    // Viewers cleared their #main along with the PDF, so they need the script
    // pushed again rather than waiting for the next keystroke. Not through
    // updateMain: with live editing off that would send nothing and leave
    // every display blank, which is worse than showing a slightly old script.
    this.#pushPublished();
  }

  #postToPreview(msg: ControlMessage) {
    this.ifrmPreview.contentWindow?.postMessage(msg, location.origin);
  }

  // Dragging a slider fires "input" far faster than once a frame, and every
  // send goes to every viewer on the *reliable* channel — which shares an
  // SCTP association with the scroll channel, so flooding it makes scroll
  // samples queue up behind settings and the motion stutters. Merging to at
  // most one message per frame (last value wins, they're absolute settings)
  // keeps the channel clear and still lands the change within ~16ms.
  #pendingSettings: Record<string, unknown> | null = null;
  #settingsFrame = 0;

  #pushSettings(patch: Omit<ControlMessage & { type: "settings" }, "type">) {
    // Hooked here rather than onto the sliders' `input` event because this is
    // the one funnel every path to a new speed or scale already reaches: the
    // input listeners (and so the commands and the gamepad, which dispatch
    // one), both wheel handlers, "match viewers' size" and the PDF's
    // fit-to-width. It reads the sliders, so the numbers cannot disagree with
    // the thumbs whichever way the value arrived.
    this.#renderTransport();
    this.#pendingSettings = { ...this.#pendingSettings, ...patch };
    if (this.#settingsFrame) return;

    this.#settingsFrame = requestAnimationFrame(() => {
      this.#settingsFrame = 0;
      const msg = {
        type: "settings",
        ...this.#pendingSettings,
      } as ControlMessage;
      this.#pendingSettings = null;
      this.link.broadcast(msg);
      this.#postToPreview(msg);
    });
  }

  #pushClock(msg: ControlMessage) {
    this.link.broadcast(msg);
    this.#postToPreview(msg);
  }

  // Sent directly rather than through #pushSettings: a theme carries a whole
  // stylesheet, which has no business being merged frame-by-frame with slider
  // values, and its class name has to land in the same message as its CSS so
  // the two can't be applied out of order. ThemeControls already debounces the
  // keystroke case.
  #pushTheme(msg: ThemeMessage) {
    this.link.broadcast(msg);
    this.#postToPreview(msg);
  }

  #onViewerJoined(id: string) {
    this.viewers.set(id, { dims: null, state: "new", local: null });
    // Bring the newcomer up to date rather than leaving it blank until the
    // next edit/setting change. In PDF mode that means re-sending the whole
    // file — the channel isn't open yet at this point, so this relies on the
    // pending-file slot in webrtc.ts.
    if (this.#pdfBytes) {
      this.link.sendFileTo(id, this.#pdfName ?? "document.pdf", this.#pdfBytes);
    } else {
      // #publishedHtml, not the editor: while live editing is off the editor
      // holds a draft nobody is meant to see, and a display that reloads
      // mid-service has to come back agreeing with the others.
      this.link.sendTo(id, { type: "content", html: this.#publishedHtml });
    }
    this.link.sendTo(id, {
      type: "settings",
      speed: -this.rngSpeed.value,
      textScale: this.rngScale.value / 10,
      message: this.#currentMessage,
    });
    // The only route by which a viewer ever learns its theme — a custom one's
    // CSS exists nowhere but this browser, so a viewer that reloads mid-service
    // comes back unstyled unless this is here.
    this.link.sendTo(id, this.themeControls.themeMessage());
    // Where everyone currently is. Sent on the *control* channel, not the
    // scroll one: control queues until the channel opens, and an unreliable
    // channel that isn't open yet would simply drop this.
    this.link.sendTo(id, { type: "scroll", r: this.#lastRatio, s: 0 });
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
    entry.local = msg.local;
    this.#applyPreviewScale();
    this.#renderViewers();
  }

  // Which viewer drives the scroll: the operator's pick, else whoever
  // connected first. Exactly one, always — two viewers each integrating the
  // speed off their own clock drift apart with nothing to pull them back, and
  // two viewers scrolled by hand would fight.
  //
  // Deliberately the same shape as #previewID(): an explicit choice that only
  // holds while that viewer is connected, over a first-connected fallback.
  // Holding the choice here rather than a flag per viewer is what makes "only
  // one driver" structural instead of something the UI has to keep true.
  #driverID(): string | null {
    if (this.#chosenDriverID && this.viewers.has(this.#chosenDriverID)) {
      return this.#chosenDriverID;
    }
    return this.viewers.keys().next().value ?? null;
  }

  // Which viewer the preview is shaped like. Separate from the pacer on
  // purpose: viewers can have completely different sizes and aspect ratios,
  // and the preview renders at one viewer's *real* pixel size to be a true
  // miniature of it, so the operator has to be able to say which. Scroll is
  // not part of this choice — every viewer sits at the same ratio, so the
  // pacer's position is correct to show in a box shaped like any of them.
  #previewID(): string | null {
    // An explicit choice only holds while that viewer is still connected.
    if (this.#chosenPreviewID && this.viewers.has(this.#chosenPreviewID)) {
      return this.#chosenPreviewID;
    }
    return this.viewers.keys().next().value ?? null;
  }

  // Render the iframe at the previewed viewer's real pixel size and scale
  // it down, so text wraps and vi-based sizing match what that viewer is
  // actually showing. Sizing it directly to the small on-screen box instead
  // would reflow the content and make the preview a lie.
  #applyPreviewScale() {
    const source = this.#previewID();
    const dims = (source && this.viewers.get(source)?.dims) ||
      Teleprompter.DEFAULT_PREVIEW_DIMS;

    // Fit inside the box CSS gave us rather than a fixed maximum, so the
    // preview is as large as the sidebar can afford. Both axes are honoured
    // and the smaller factor wins, which is what keeps the aspect ratio the
    // previewed viewer's — the whole point of rendering at its real size.
    // A box that measures 0 hasn't been laid out yet; fall back rather than
    // scaling the preview out of existence.
    const box = this.#previewBox.getBoundingClientRect();
    const maxWidth = box.width || Teleprompter.MAX_PREVIEW_WIDTH;
    const maxHeight = box.height || Teleprompter.MAX_PREVIEW_HEIGHT;

    const scale = Math.min(maxWidth / dims.width, maxHeight / dims.height);

    const container = <HTMLDivElement> this.ifrmPreview.parentElement;
    container.style.width = `${dims.width * scale}px`;
    container.style.height = `${dims.height * scale}px`;

    this.ifrmPreview.style.width = `${dims.width}px`;
    this.ifrmPreview.style.height = `${dims.height}px`;
    this.ifrmPreview.style.transform = `scale(${scale})`;
    this.ifrmPreview.style.transformOrigin = "top left";
  }

  // Only the driving viewer integrates the scroll speed itself; everyone
  // else mirrors the position it reports. Independent auto-scroll loops
  // would each run off their own clock and drift apart within a minute
  // with nothing to pull them back together.
  //
  // Both halves of the role go out from here — who auto-scrolls and who may
  // be scrolled by hand — because they are the same decision. Sending the
  // drive grant only from #setDriver was a bug: the *derived* driver (the
  // first viewer to connect, before the operator picks anyone) was never told,
  // so the default driver couldn't be scrolled.
  #applyScrollRoles() {
    const driver = this.#driverID();
    for (const id of this.link.viewers()) {
      this.link.sendTo(id, { type: "set-driver", canDrive: id === driver });
      this.link.sendTo(id, {
        type: "settings",
        autoScroll: id === driver && this.#autoScrollRunning,
      });
    }
  }

  #onViewerScroll(id: string, ratio: number) {
    if (!this.viewers.has(id)) return;
    // Only the driver's samples are authoritative. Every viewer reports its
    // own position unconditionally; the rest are echoes of this one.
    if (id !== this.#driverID()) return;

    this.#lastRatio = ratio;

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

  #setDriver(id: string) {
    if (!this.viewers.has(id)) return;
    this.#chosenDriverID = id;
    // The grant itself goes out from #applyScrollRoles, which tells every
    // viewer where it stands — including the one losing drive.
    // Granting drive changes which viewer paces the scroll. It no longer
    // changes what the preview is shaped like — that's the operator's own
    // choice now, since the viewer worth driving from and the viewer worth
    // looking at need not be the same shape or the same device.
    this.#applyScrollRoles();
    this.#renderViewers();
  }

  #setPreview(id: string) {
    if (!this.viewers.has(id)) return;
    this.#chosenPreviewID = id;
    this.#applyPreviewScale();
    this.#renderViewers();
  }

  /**
   * The app bar's status badge.
   *
   * "Live" means *a display is showing this*, which is the question an operator
   * is actually asking — not "the signaling socket is up", which is what this
   * reported at first and which reads as on-air with nothing connected. So it
   * takes both facts, and the two callers that learn them (the signaling
   * callback and #renderViewers) both come through here.
   *
   * The wording is deliberately about what the operator can do rather than
   * about transport state: "denied" means another control page holds the room,
   * so this one will never drive anything, and that is a different problem from
   * a dropped socket already reconnecting on its own.
   */
  /**
   * The viewer count, split by where the displays are.
   *
   * A bare total reads identically whether three people are watching on three
   * devices or three windows are stacked on this one laptop, and those are
   * very different things to be looking at before a service. Falls back to
   * the total while nothing has reported yet — a count that flickered between
   * shapes as displays connected would be worse than one that waits.
   */
  #viewerCountText(): string {
    let local = 0;
    let remote = 0;
    for (const entry of this.viewers.values()) {
      if (entry.local === null) continue;
      entry.local ? local++ : remote++;
    }
    if (local + remote === 0) return `${this.viewers.size}`;
    const parts: string[] = [];
    if (local) parts.push(`${local} local`);
    if (remote) parts.push(`${remote} remote`);
    // Any display still to report is counted here but named in neither part,
    // so say so rather than letting the parts quietly fail to add up.
    const pending = this.viewers.size - local - remote;
    if (pending) parts.push(`${pending}…`);
    return parts.join(" · ");
  }

  #renderStatus() {
    const shown = this.#signaling === "denied"
      ? { variant: "danger", text: "No control", attention: "none" }
      : this.#signaling === "disconnected"
      ? { variant: "warning", text: "Reconnecting", attention: "none" }
      : this.viewers.size === 0
      ? { variant: "neutral", text: "No viewers", attention: "none" }
      : { variant: "success", text: "Live", attention: "pulse" };
    this.#bdgSignaling.variant = <WaBadge["variant"]> shown.variant;
    this.#bdgSignaling.attention = <WaBadge["attention"]> shown.attention;
    this.#bdgSignaling.textContent = shown.text;
  }

  /**
   * The numeric readouts above the two sliders.
   *
   * Speed is shown as the number that goes on the wire — `-rngSpeed.value`,
   * where positive is forward — and not as the slider's own value, whose sign
   * is inverted for the geometric reason documented on `listenSpeedWheel`.
   * Showing the raw slider value would put a minus sign in front of forward.
   */
  #renderTransport() {
    const speed = -this.rngSpeed.value;
    this.#outSpeed.textContent = `${Math.round(speed)}`;
    this.#outScale.textContent = (this.rngScale.value / 10).toFixed(1);
    this.#outEditor.textContent = tenthsToRem(this.rngEditor.value).toFixed(1);
  }

  #renderViewers() {
    this.#spnViewerNum.textContent = this.#viewerCountText();
    // The badge reads the viewer count, so it is stale until this runs.
    this.#renderStatus();
    this.divViewers.innerHTML = "";
    const previewID = this.#previewID();
    const driverID = this.#driverID();

    for (const [id, entry] of this.viewers) {
      const row = document.createElement("div");
      row.className = "viewer-row";

      const label = document.createElement("span");
      label.className = "viewer-id";
      const dims = entry.dims
        ? `${entry.dims.width}×${entry.dims.height}`
        : "…";
      label.textContent = `${id.slice(0, 6)} (${dims})`;
      row.appendChild(label);

      // Which machine this display is on. Not cosmetic: a row that says
      // Remote is someone else's screen, and closing the operator's own
      // window will not turn it off.
      const where = document.createElement("span");
      where.className = "viewer-where";
      where.textContent = entry.local === null
        ? "…"
        : entry.local
        ? "Local"
        : "Remote";
      row.appendChild(where);

      const state = document.createElement("span");
      state.className = "viewer-state";
      state.textContent = entry.state;
      row.appendChild(state);

      // Radio, not a checkbox: the preview can only be shaped like one
      // viewer at a time. Sharing a `name` lets the browser enforce that.
      const previewLabel = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "previewSource";
      radio.checked = id === previewID;
      radio.addEventListener("change", () => this.#setPreview(id));
      previewLabel.appendChild(radio);
      previewLabel.appendChild(document.createTextNode("preview"));
      row.appendChild(previewLabel);

      // Also a radio, and for a stronger reason than the preview's: exactly
      // one viewer drives, so a checkbox per viewer could express states the
      // app has no meaning for. It was a checkbox, and ticking a second
      // viewer silently did nothing because only the first grant was read.
      // Checked on the derived driver too, so the operator can see that the
      // first viewer to connect is already the one driving.
      const driveLabel = document.createElement("label");
      const driveRadio = document.createElement("input");
      driveRadio.type = "radio";
      driveRadio.name = "driveSource";
      driveRadio.checked = id === driverID;
      driveRadio.addEventListener("change", () => this.#setDriver(id));
      driveLabel.appendChild(driveRadio);
      driveLabel.appendChild(document.createTextNode("drive"));
      row.appendChild(driveLabel);

      // No separate "pacing" badge any more: the driver *is* the pacer, and
      // the radio above already says which one that is.
      this.divViewers.appendChild(row);
    }
  }

  saveEditorContent(editor: Wordgard) {
    const content = JSON.stringify(saveEditor(editor));
    this.docControls.setContent(content);
    // Content now travels over a live data channel rather than a manual
    // "update" action, so every edit is a good moment to push it.
    this.updateMain();
  }

  /**
   * Open the local screen, or close the one that is open.
   *
   * "Local" is the whole scope of this button: the window *this page* owns, on
   * this machine. A display on another device arrives by itself through the
   * viewer link, and nothing here can or should close it.
   */
  async listenPop() {
    if (this.#popWin && !this.#popWin.closed) {
      this.#popWin.close();
      this.#forgetPop();
      return;
    }

    const dims = await this.#screenForPop();
    // `fullscreen` alongside `popup` is Chrome's Fullscreen Companion Window:
    // with the Window Management permission — which #screenForPop has just
    // asked for — one user activation covers both placing the window and
    // taking it fullscreen, so the talent never sees browser chrome. Browsers
    // that don't know the feature ignore it and viewer.ts asks for fullscreen
    // itself.
    const win = self.open(
      this.#viewerURL,
      "pop",
      `popup=true,fullscreen=true,width=${dims.width},height=${dims.height},screenX=${dims.x},screenY=${dims.y}`,
    );
    if (!win) {
      // A blocked popup is the operator's browser telling them something, not
      // a bug to crash the page over — the viewer link is still right there.
      console.warn("the browser blocked the local screen window");
      return;
    }
    this.#adoptPop(win);
  }

  /**
   * Where to put the local screen: the first non-primary display, else a
   * modest window on this one.
   *
   * The Window Management API is Chromium-only, and `getScreenDetails` both
   * throws where it is missing and rejects when the permission is refused.
   * Unguarded — as this was — the rejection escapes an `async` click listener
   * as an unhandled promise and the window simply never opens, with the
   * failure visible nowhere but the console.
   */
  async #screenForPop() {
    const fallback = { width: 800, height: 600, x: 100, y: 100 };
    try {
      const screenDetails = await self.getScreenDetails();
      const secondary = screenDetails.screens.find((s) => !s.isPrimary);
      if (!secondary) return fallback;
      return {
        width: secondary.width,
        height: secondary.height,
        x: secondary.left,
        y: secondary.top,
      };
    } catch {
      return fallback;
    }
  }

  /** Take ownership of a local screen window and start watching it. */
  #adoptPop(win: Window) {
    if (this.#popWin === win) return;
    this.#popWin = win;
    clearInterval(this.#popWatch);
    // Polling, because closing a popup notifies nobody: there is no event on
    // the opener, and the popup's own `pagehide` cannot be relied on to run
    // before it goes. Half a second is well under the time it takes an
    // operator to look up at the button.
    this.#popWatch = setInterval(() => {
      if (this.#popWin?.closed) this.#forgetPop();
    }, 500);
    this.#renderPop();
  }

  /** The local screen is gone. */
  #forgetPop() {
    this.#popWin = null;
    clearInterval(this.#popWatch);
    this.#popWatch = undefined;
    this.#renderPop();
  }

  /**
   * A local screen announcing itself to its opener.
   *
   * This is what makes the button survive an operator's refresh. The popup's
   * `opener` still points at this window after it navigates, so the display
   * keeps saying hello; a fresh control page hears it and adopts the window it
   * did not open. Without this the button would read "closed" for the rest of
   * a session that still has a display running, and a button that lies about
   * what is on the screen is worse than no button.
   */
  #listenPopHello(e: MessageEvent) {
    if (e.origin !== location.origin) return;
    if ((<{ type?: string }> e.data)?.type !== "pop-hello") return;
    const win = <Window | null> e.source;
    if (!win || win.closed) return;
    this.#adoptPop(win);
  }

  /**
   * Tell any display in this browser that the control page is right here.
   *
   * This is the whole mechanism behind the Local badge for a display the
   * operator opened by hand: a BroadcastChannel carries only to pages of this
   * origin in this browser profile, so the fact that an answer arrives at all
   * is the evidence. Answering rather than announcing, because a display can
   * start at any time and there is no moment at which announcing once would
   * reach all of them.
   */
  #answerLocalProbes() {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(LOCAL_CHANNEL);
    } catch {
      // No BroadcastChannel, or storage blocked. Displays this page opened
      // still identify themselves by `opener`; the rest read as remote.
      return;
    }
    channel.addEventListener("message", (e: MessageEvent) => {
      if ((<{ type?: string }> e.data)?.type !== "who") return;
      channel.postMessage({ type: "here" });
    });
  }

  /**
   * Say whether a local screen is open.
   *
   * Filled *and* branded when it is, the same loudest-state-the-theme-has that
   * #wirePaneToggle uses: outlined-blue against outlined-grey is a difference
   * an operator has to look for, and this button answers "is there a screen
   * showing this?" at a glance.
   */
  #renderPop() {
    const on = !!this.#popWin && !this.#popWin.closed;
    this.btnPop.appearance = on ? "accent" : "outlined";
    this.btnPop.variant = on ? "brand" : "neutral";
    this.btnPop.setAttribute("aria-pressed", String(on));
    this.btnPop.title = on
      ? "Close the local screen"
      : "Open a screen on this device";
  }

  /**
   * The wheel over a slider. All three go through `wheelStep`, so which way a
   * scroll moves a thumb is one answer for the whole page — and one the
   * operator can flip in Settings, because whether a scroll away from them
   * arrives as a positive or a negative deltaY is decided by their pointing
   * device and their "natural scrolling" setting, neither of which this page
   * can see.
   */
  listenSpeedWheel(e: WheelEvent) {
    e.preventDefault();
    this.rngSpeed.value += wheelStep(e.deltaY, this.settings.invertWheel);
    this.#pushSettings({ speed: -this.rngSpeed.value });
  }

  listenRangeSpeed() {
    this.#pushSettings({ speed: -this.rngSpeed.value });
  }

  listenScaleWheel(e: WheelEvent) {
    e.preventDefault();
    const scale = this.rngScale.value +=
      wheelStep(e.deltaY, this.settings.invertWheel) / 30;
    this.rngScale.value = scale;
    this.#pushSettings({ textScale: scale / 10 });
  }

  listenRangeScale() {
    this.#pushSettings({ textScale: this.rngScale.value / 10 });
  }

  listenEditorWheel(e: WheelEvent) {
    e.preventDefault();
    this.rngEditor.value += wheelStep(e.deltaY, this.settings.invertWheel) / 30;
    this.#applyEditorScale();
  }

  /**
   * The editor's own reading size, which goes nowhere near the wire.
   *
   * The one funnel for this slider, the way #pushSettings is the funnel for the
   * other two — but deliberately *not* that one: this changes what the operator
   * sees and nothing a viewer does. Sending it would resize every display when
   * someone leaned into their own screen.
   *
   * The size is applied as a custom property rather than an inline font-size so
   * style.css's rule stays the one place the editor's font is declared, and its
   * 2rem fallback still holds before this ever runs.
   */
  #applyEditorScale() {
    const tenths = this.rngEditor.value;
    (<HTMLElement> document.querySelector("#editor")).style.setProperty(
      "--editor-scale",
      `${tenthsToRem(tenths)}rem`,
    );
    try {
      localStorage.setItem(Teleprompter.EDITOR_SCALE_KEY, `${tenths}`);
    } catch {
      // Private mode or blocked storage: the size holds for this session and
      // comes back at the default next load. Nothing else depends on it.
    }
    this.#renderTransport();
  }

  // How big the operator had their own text last time. An ergonomics
  // preference rather than show state, so it is remembered across a reload the
  // way the control key is — and validated against the slider's own range,
  // because a hand-edited or stale value must not collapse the script pane.
  #restoreEditorScale() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(Teleprompter.EDITOR_SCALE_KEY);
    } catch {
      // Nothing to restore; the markup default stands.
    }
    const tenths = Number(stored);
    if (
      stored && Number.isFinite(tenths) &&
      tenths >= this.rngEditor.min && tenths <= this.rngEditor.max
    ) {
      this.rngEditor.value = tenths;
    }
    this.#applyEditorScale();
  }

  /**
   * Put one slider back where the markup had it.
   *
   * Through a synthetic "input" event, like controlCommands.ts's `nudge`: a
   * reset then lands in the same handler as a drag, so it cannot forget to
   * tell the viewers (or, for the editor slider, to persist).
   */
  resetSlider(slider: WaSlider) {
    const value = this.#sliderDefaults.get(slider);
    if (value === undefined) return;
    slider.value = value;
    slider.dispatchEvent(new Event("input"));
  }

  /** The palette's "Reset sliders to defaults" — all three at once. */
  resetSliders() {
    for (const slider of this.#sliderDefaults.keys()) {
      this.resetSlider(slider);
    }
  }

  /** The Space-bar action, and the palette's "Start / stop scrolling". */
  toggleAutoScroll() {
    this.#autoScrollRunning = !this.#autoScrollRunning;
    this.#applyScrollRoles();
  }

  /**
   * The pane the operator is reading — the PDF column or the editor.
   *
   * Resolved on every call, never cached: `editor` is replaced wholesale each
   * time a document loads, and a PDF can arrive or close at any point.
   */
  #ownScroller(): Element {
    return this.#pdfBytes ? this.#pdfPages : this.editor.scrollDOM;
  }

  /**
   * Scroll the operator's own pane, returning the pixels it actually moved.
   *
   * Deliberately silent. The operator's pane is not scroll-synced — that is
   * what lets them read ahead of the viewers — so moving it must not report a
   * position, and the two Sync buttons stay the only way to close the gap.
   *
   * The return value is what it moved, not what was asked for: the browser
   * quantises scrolling and the ends of the document clamp it, and a
   * continuous input needs to know so it can carry the remainder rather than
   * have slow drift rounded away every frame.
   */
  scrollOwnPane(px: number): number {
    const el = this.#ownScroller();
    const before = el.scrollTop;
    el.scrollTop = before + px;
    return el.scrollTop - before;
  }

  /**
   * Jump this page to where the viewers are.
   *
   * `#lastRatio` is the pacer's latest sample, and every viewer sits at that
   * same ratio — the controller relays one position to all of them — so it is
   * also the position of whichever viewer the preview is mirroring.
   */
  goToViewerPosition() {
    setRatio(this.#ownScroller(), this.#lastRatio);
  }

  /**
   * Move every viewer to where this page is.
   *
   * Audience-visible, and the only coherent reading of "put the viewers where
   * I am": the preview is a passive mirror of the pacer, so a position set on
   * it alone is overwritten by the pacer's next sample within a frame.
   *
   * The pacer applies this like any other remote scroll — its echo guard
   * swallows the resulting event — and then carries on from the new position,
   * so this works while the scroll is running.
   */
  sendMyPosition() {
    const ratio = ratioOf(this.#ownScroller());
    // Cached so a viewer joining later is caught up to here by #onViewerJoined,
    // which is otherwise only ever fed by the pacer.
    this.#lastRatio = ratio;
    this.link.sendScroll(ratio);
    this.#postToPreview({ type: "scroll", r: ratio, s: 0 });
  }

  /**
   * The editor's text column width, which is what a font size has to be
   * measured against — not the pane, which includes the scrollbar and the
   * content element's own padding.
   */
  #editorTextWidth(): number {
    const content = this.editor.contentDOM;
    const style = getComputedStyle(content);
    const padding = parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight);
    return content.clientWidth - padding;
  }

  /**
   * The width of the viewer the preview is mirroring, read the same way
   * #applyPreviewScale reads it so both agree on which viewer is being matched.
   */
  #previewedViewerWidth(): number {
    const dims = this.viewers.get(this.#previewID() ?? "")?.dims;
    return (dims ?? Teleprompter.DEFAULT_PREVIEW_DIMS).width;
  }

  /**
   * Resize the editor's text to read like the viewers' does.
   *
   * Equal characters per line rather than equal pixels — see textscale.ts.
   * Applied through the Editor Text slider rather than straight onto the
   * element, so that slider stays the single answer to how big the script is:
   * the thumb and the readout follow, and the match is remembered like any
   * other size the operator chose. The slider's step is what pxToTenths rounds
   * to.
   */
  matchTextScaleFromViewers() {
    const px = matchedEditorFontPx(
      this.rngScale.value / 10,
      this.#editorTextWidth(),
      this.#previewedViewerWidth(),
    );
    // 0 means a width wasn't known yet; leave the text as it is rather than
    // collapsing it.
    if (px <= 0) return;
    // Clamping is the component's, as it is for the wheel handlers and the
    // slider commands.
    this.rngEditor.value = pxToTenths(px);
    this.rngEditor.dispatchEvent(new Event("input"));
  }

  /**
   * Push the operator's reading size out to the viewers.
   *
   * Through the slider rather than straight to #pushSettings, so this and a
   * slider drag remain one code path — and so the slider goes on showing what
   * the viewers were actually told.
   */
  sendMyTextScale() {
    const fontPx = parseFloat(
      getComputedStyle(this.editor.contentDOM).fontSize,
    );
    const scale = matchedViewerTextScale(
      fontPx,
      this.#editorTextWidth(),
      this.#previewedViewerWidth(),
    );
    if (scale <= 0) return;
    this.rngScale.value = clampTextScale(scale) * 10;
    this.rngScale.dispatchEvent(new Event("input"));
  }

  listenMessage() {
    const txtMessage: WaInput = document.querySelector("#txtMessage")!;
    if (!txtMessage) {
      throw new Error("No Message input found.");
    }
    this.#currentMessage = txtMessage.value || "";
    this.#pushSettings({ message: this.#currentMessage });
  }

  /**
   * The editor has new content. Publish it, if the operator wants that.
   *
   * Every path to a changed script comes through here: a keystroke, opening
   * another document, creating one. With live editing off it goes no further
   * than remembering that there is something to send — which is the whole
   * point of the switch, and why the alternative (letting it through and
   * hoping) would be no feature at all.
   */
  updateMain() {
    // Editing while a PDF is showing is legitimate — the operator can prepare
    // the next script — but it must not push that text at the displays.
    if (this.#pdfBytes) return;
    // The first content of a session goes out whatever the switch says.
    // Nothing has been published yet, so there is no earlier script for the
    // displays to be showing instead — holding it back would send them the
    // empty string and blank every screen, which is the opposite of what the
    // switch is for.
    if (!this.settings.liveEditing && this.#everPublished) {
      this.#draftHeld = true;
      this.#renderLive();
      return;
    }
    this.pushContent();
  }

  /**
   * Send the editor's content to the displays and remember it as theirs.
   *
   * The only writer of #publishedHtml, so "what the audience is showing" has
   * exactly one answer however the content got there — the switch, the
   * button, the palette, or a keystroke while live.
   */
  pushContent() {
    if (this.#pdfBytes) return;
    this.#publishedHtml = this.editor.contentDOM.innerHTML;
    this.#everPublished = true;
    this.#draftHeld = false;
    this.#pushPublished();
    this.#renderLive();
  }

  /** Send whatever the displays are supposed to be showing, unconditionally. */
  #pushPublished() {
    const msg: ControlMessage = {
      type: "content",
      html: this.#publishedHtml,
    };
    this.link.broadcast(msg);
    this.#postToPreview(msg);
  }

  /**
   * Turn live editing on or off.
   *
   * Turning it on publishes at once. "Go live" has to mean the displays now
   * show what the operator is looking at — leaving them a keystroke behind
   * would be the same trap the switch exists to avoid, in the other
   * direction.
   */
  toggleLiveEditing() {
    const on = !this.settings.liveEditing;
    this.settings.liveEditing = on;
    if (on) this.pushContent();
    else this.#renderLive();
  }

  /**
   * Say whether the displays are tracking the editor.
   *
   * The switch is remembered across reloads, so this indicator is what keeps
   * that from being a trap: the app bar says so whenever they are not, and
   * the push button goes loud once there is something held to send. Without
   * it an operator could type for minutes into a screen showing something
   * else.
   */
  #renderLive() {
    const on = this.settings.liveEditing;
    this.#swLiveEditing.checked = on;
    this.#icnHeld.hidden = on;
    this.btnPushContent.appearance = this.#draftHeld ? "accent" : "outlined";
    this.btnPushContent.title = this.#draftHeld
      ? "The displays are behind the editor — send the script now"
      : "Send the script to the displays";
  }
}
