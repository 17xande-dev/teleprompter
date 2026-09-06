import { registerClockComponent, TPClock } from "./clock.ts";
import { connectViewer, type ViewerLink } from "./webrtc.ts";
import { makeScrollSync, type ScrollSync } from "./scrollsync.ts";
import type { ControlMessage } from "./protocol.ts";

// CSS imports.
import "@awesome.me/webawesome/dist/styles/themes/shoelace.css";
import "../styles/popThemesDefault.css";

/**
 * Viewer runs the actual prompter content, in one of two modes from a
 * single codebase (mirroring ~/dev/webrtc-go's viewer.ts):
 *
 * - Embedded (window.parent !== window): this is the control page's own
 *   live preview iframe. It's a passive mirror — same JS process as the
 *   control page, so it talks over postMessage rather than WebRTC, and it
 *   never drives anything (no auto-scroll of its own, no scroll reports).
 * - Standalone: a real popup or a remote device. It owns its own WebRTC
 *   link to the controller (?room= in the URL), runs the auto-scroll loop,
 *   and always reports its own scroll position — whether the controller
 *   acts on it depends on the "canDrive" permission the controller grants.
 */
export class Viewer {
  root = <HTMLHtmlElement> document.querySelector(":root")!;
  spanMessage = <HTMLSpanElement> document.querySelector("#message")!;
  timer: TPClock;
  messageMin = 10;
  messageMax = 75;
  scroll = false;
  scrollSpeed = 0;
  lastScrollTime = 0;
  accumulatedScroll = 0;
  isPreviewer = false;
  canDrive = false;

  #scrollSync: ScrollSync;
  #link: ViewerLink | null = null;
  #isResizing = false;

  constructor() {
    registerClockComponent();
    this.timer = document.querySelector("#timeTimer")!;

    this.#scrollSync = makeScrollSync({
      el: document.scrollingElement!,
      send: (ratio) => this.#link?.sendScroll(ratio),
    });

    if (globalThis.self !== globalThis.top) {
      this.isPreviewer = true;
      globalThis.addEventListener("message", (e: MessageEvent) => {
        if (e.origin !== location.origin) return;
        this.#handleControl(e.data as ControlMessage);
      });
      return;
    }

    const room = new URLSearchParams(location.search).get("room");
    if (!room) {
      throw new Error("missing ?room= on standalone viewer page");
    }

    this.#link = connectViewer(room, {
      onControl: (msg) => this.#handleControl(msg),
      onScroll: (ratio) => this.#scrollSync.applyRemote(ratio),
      onStatus: (status) => {
        document.documentElement.dataset.rtcStatus = status;
        // Re-report on every (re)connect, not just at startup: a reconnect
        // builds a fresh link the controller knows nothing about, so
        // without this its viewer list shows this viewer as dimensionless
        // for the rest of the session.
        if (status === "connected") this.#reportDims();
      },
    });

    self.addEventListener("resize", this.#listenResize.bind(this));
    self.addEventListener("dblclick", () => {
      document.documentElement.requestFullscreen();
    });

    this.#reportDims();
    this.startSmoothScroll();
  }

  #handleControl(msg: ControlMessage) {
    switch (msg.type) {
      case "content":
        this.setContent(msg.html);
        break;
      case "settings":
        // The preview iframe mirrors scroll via broadcast ratios, not its
        // own auto-scroll loop, so it ignores speed changes.
        if (!this.isPreviewer) {
          if (msg.speed !== undefined) this.setSpeed(msg.speed);
          if (msg.autoScroll !== undefined) {
            msg.autoScroll ? this.startSmoothScroll() : this.stopSmoothScroll();
          }
        }
        if (msg.textScale !== undefined) this.setTextScale(msg.textScale);
        if (msg.layout !== undefined) document.body.className = msg.layout;
        if (msg.message !== undefined) this.setMessage(msg.message);
        break;
      case "clock":
        switch (msg.action) {
          case "start":
            this.timer.start();
            break;
          case "stop":
            this.timer.stop();
            break;
          case "reset":
            this.timer.reset(msg.time);
            break;
        }
        break;
      case "set-driver":
        this.canDrive = msg.canDrive;
        break;
      case "scroll":
        this.#scrollSync.applyRemote(msg.r);
        break;
      case "dims":
        // Viewer only ever sends this, never receives it.
        break;
    }
  }

  #listenResize() {
    if (this.#isResizing) return;
    this.#isResizing = true;
    globalThis.requestAnimationFrame(() => {
      this.#reportDims();
      this.resizeMessage();
      this.#isResizing = false;
    });
  }

  #reportDims() {
    this.#link?.sendControl({
      type: "dims",
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    });
  }

  resizeMessage() {
    // Reset to min first so we measure full size.
    let fontSize = this.messageMin;
    this.spanMessage.style.fontSize = fontSize + "px";
    const parentHeight = this.spanMessage.parentElement?.clientHeight ?? 0;
    // Shrink until it fits or hits minSize
    while (
      this.spanMessage.clientHeight < parentHeight &&
      fontSize < this.messageMax
    ) {
      fontSize += 1;
      this.spanMessage.style.fontSize = fontSize + "px";
    }

    fontSize -= 1;
    this.spanMessage.style.fontSize = fontSize + "px";
  }

  startSmoothScroll() {
    // The loop re-arms itself every frame, so starting it twice (the
    // constructor, then the controller's on-join settings{autoScroll})
    // would leave two self-perpetuating chains running for the page's life.
    if (this.scroll) return;
    this.lastScrollTime = 0;
    this.accumulatedScroll = 0;
    this.scroll = true;
    requestAnimationFrame(this.smoothScroll.bind(this));
  }

  stopSmoothScroll() {
    this.scroll = false;
  }

  smoothScroll(timestamp: DOMHighResTimeStamp) {
    if (!this.scroll) {
      return;
    }
    const windowHeight = globalThis.innerHeight + globalThis.scrollY;
    if (this.scrollSpeed > 0 && windowHeight > document.body.offsetHeight) {
      // if we're at the bottom of the page, don't continue scrolling.
      requestAnimationFrame(this.smoothScroll.bind(this));
      return;
    }
    if (this.lastScrollTime === 0) this.lastScrollTime = timestamp;
    const timeElapsed = timestamp - this.lastScrollTime;

    const pixelsToScroll = (this.scrollSpeed / 1000) * timeElapsed;
    this.accumulatedScroll += pixelsToScroll;

    const pixelsToScrollNow = Math.floor(this.accumulatedScroll);
    globalThis.scrollBy(0, pixelsToScrollNow);

    this.accumulatedScroll -= pixelsToScrollNow;
    this.lastScrollTime = timestamp;

    requestAnimationFrame(this.smoothScroll.bind(this));
  }

  setSpeed(speed: number) {
    this.scrollSpeed = speed;
  }

  setTextScale(scale: number) {
    this.root.style.setProperty("--textScale", `${scale}rem`);
  }

  setContent(content: string) {
    const popMain = <HTMLDivElement> document.querySelector("#main");
    popMain.innerHTML = content;
  }

  setMessage(content: string) {
    this.spanMessage.innerText = content;
    this.resizeMessage();
  }
}
