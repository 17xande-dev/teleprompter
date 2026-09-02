import {
  registerClockComponent,
  registerClockControlComponent,
  ResetEvent,
  TPClockControl,
} from "./clock.ts";

import { Viewer } from "./viewer.ts";
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
// import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/styles/themes/shoelace.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
// import "@awesome.me/webawesome/dist/styles/themes/default.css";
// import "@awesome.me/webawesome/dist/styles/themes/awesome.css";

import "../styles/style.css";
import { Doc, DocControls } from "./doc.ts";
import { WaSelectEvent } from "@awesome.me/webawesome";
import { Wordgard } from "wordgard/editor";
import { newEditor, restoreEditor, saveEditor } from "./editor.ts";

type PopupDimensions = {
  width: number;
  height: number;
  x: number;
  y: number;
};

export class Teleprompter {
  static readonly MAX_PREVIEW_WIDTH = 300;
  static readonly MAX_PREVIEW_HEIGHT = 450;
  docControls: DocControls;
  splitPanel: WaSplitPanel;
  btnMessage: WaButton;
  editor: Wordgard;
  rngSpeed: WaSlider;
  rngScale: WaSlider;
  drpLayouts: WaDropdown;
  tpClockControl: TPClockControl;
  viewerWindow: Window | null = null;
  viewer: Viewer | null = null;
  previewer: Viewer | null = null;
  ifrmPreview: HTMLIFrameElement;
  viewerScrollY = 0;
  popDimensions: PopupDimensions;
  controls: HTMLDivElement;
  editingName: string;
  btnPop: WaButton;

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

    this.ifrmPreview = <HTMLIFrameElement> document.querySelector(
      "#ifrmPreview",
    );

    this.popDimensions = {
      width: 200,
      height: 150,
      x: 100,
      y: 100,
    };

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

    this.tpClockControl.addEventListener("start", () => {
      this.previewer?.timer.start();
      this.viewer?.timer.start();
    });

    this.tpClockControl.addEventListener("stop", () => {
      this.previewer?.timer.stop();
      this.viewer?.timer.stop();
    });

    this.tpClockControl.addEventListener(
      "reset",
      (event) => {
        const ev = event as ResetEvent;
        this.previewer?.timer.reset(ev.detail.time);
        this.viewer?.timer.reset(ev.detail.time);
      },
    );

    this.editingName = "";

    globalThis.addEventListener("keyup", this.listenKey.bind(this));

    this.ifrmPreview.addEventListener("load", () => {
      if (!this.ifrmPreview.contentWindow?.viewer) {
        throw new Error("no viewer on preview.");
      }
      this.previewer = this.ifrmPreview.contentWindow?.viewer;
      if (!this.ifrmPreview.contentDocument) {
        throw new Error("no iframe content document");
      }
      // TODO: should this be in the constructor of the viewer?
      this.ifrmPreview.contentDocument.body.style.overflow = "hidden";
      this.updateMain();
    });
  }

  saveEditorContent(editor: Wordgard) {
    const content = JSON.stringify(saveEditor(editor));
    this.docControls.docStorage.setCurrentContent(content);
    this.docControls.docStorage.save();
  }

  async listenPop() {
    const screenDetails = await self.getScreenDetails();
    const secondary = screenDetails.screens.find((s) => !s.isPrimary);
    // TODO: This is not correct. saved option should prioritise this, but this is a good POC for now.
    if (secondary) {
      this.popDimensions.width = secondary.width;
      this.popDimensions.height = secondary.height;
      this.popDimensions.x = secondary.left;
      this.popDimensions.y = secondary.top;
    }
    const win = self.open(
      "/html/pop.html",
      "pop",
      `popup=true,width=${this.popDimensions.width},height=${this.popDimensions.height},screenX=${this.popDimensions.x},screenY=${this.popDimensions.y}`,
    );
    if (!win) {
      throw new Error("can't open window");
    }

    this.viewerWindow = win;
  }

  listenLayoutSelect(e: WaSelectEvent) {
    const item = e.detail.item as WaDropdownItem;
    const layout = item.value;
    if (this.ifrmPreview.contentDocument) {
      this.ifrmPreview.contentDocument.body.className = layout;
    }
    if (this.viewerWindow) {
      this.viewerWindow.document.body.className = layout;
    }
  }

  listenSpeedWheel(e: WheelEvent) {
    e.preventDefault();

    this.rngSpeed.value += -e.deltaY;
    this.viewerWindow?.viewer.setSpeed(-this.rngSpeed.value);
  }

  listenRangeSpeed() {
    this.viewerWindow?.viewer.setSpeed(-this.rngSpeed.value);
  }

  listenScaleWheel(e: WheelEvent) {
    e.preventDefault();
    const scale = this.rngScale.value += -e.deltaY / 30;

    this.rngScale.value = scale;
    this.viewerWindow?.viewer.setTextScale(scale / 10);
    this.previewer?.setTextScale(scale / 10);
  }

  listenRangeScale() {
    const scale = this.rngScale.value / 10;
    this.viewerWindow?.viewer.setTextScale(scale);
    this.previewer?.setTextScale(scale);
  }

  listenKey(ke: KeyboardEvent) {
    if (this.editor.hasFocus) return;

    switch (ke.code) {
      case "Space":
        ke.preventDefault();
        if (this.viewer?.scroll) {
          this.viewer?.stopSmoothScroll();
        } else {
          this.viewer?.startSmoothScroll();
        }
        break;
      default:
        // ignore for now
    }
  }

  listenMessage() {
    // TODO: make this check in the constructor or something? Otherwise I have to keep checking this.
    if (!this.viewerWindow) return;
    const txtMessage: WaInput = document.querySelector("#txtMessage")!;
    if (!txtMessage) {
      throw new Error("No Message input found.");
    }
    this.viewerWindow.viewer.setMessage(txtMessage.value || "");
    this.previewer?.setMessage(txtMessage.value || "");
  }

  updateMain() {
    const content = this.editor.contentDOM.innerHTML;
    if (!this.previewer) return;
    this.previewer.setContent(content);
    if (!this.viewerWindow) return;
    this.viewer = this.viewerWindow.viewer;
    this.viewer.setContent(content);
  }

  listenResize(innerWidth: number, innerHeight: number) {
    // Calculate scale factor to fit within max preview size while maintaining aspect ratio.
    const scaleX = Teleprompter.MAX_PREVIEW_WIDTH / this.popDimensions.width;
    const scaleY = Teleprompter.MAX_PREVIEW_HEIGHT / this.popDimensions.height;
    const scale = Math.min(scaleX, scaleY);

    // Calculate preview container dimensions.
    const previewWidth = this.popDimensions.width * scale;
    const previewHeigh = this.popDimensions.height * scale;

    const previewContainer = <HTMLDivElement> this.ifrmPreview.parentElement;

    previewContainer.style.width = previewWidth + "px";
    previewContainer.style.height = previewHeigh + "px";

    this.ifrmPreview.style.width = innerWidth + "px";
    this.ifrmPreview.style.height = innerHeight + "px";
    this.ifrmPreview.style.transform = `scale(${scale})`;
    this.ifrmPreview.style.transformOrigin = "top left";
  }

  listenScroll(scrollTop: number) {
    this.ifrmPreview.contentWindow?.scrollTo(0, scrollTop);
  }

  // listenIFrameScale(scale: number) {
  //   this.ifrmPreview.contentWindow?.viewer.setTextScale(scale);
  // }
}
