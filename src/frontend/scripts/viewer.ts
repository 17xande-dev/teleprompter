import { registerClockComponent, TPClock } from "./clock.ts";
import { connectViewer, type ViewerLink } from "./webrtc.ts";
import { makeScrollSync, type ScrollSync } from "./scrollsync.ts";
import { type PdfView, renderPdf } from "./pdfview.ts";
import type { ControlMessage } from "./protocol.ts";

// CSS imports.
import "@awesome.me/webawesome/dist/styles/themes/shoelace.css";
// Two layers, imported separately rather than chained through an @import so it
// is explicit which one a user theme replaces: viewerThemes.css holds the
// built-in layouts (each @scope'd to its body class, so they simply stop
// matching under a custom one), while viewerBase.css is the floor that always
// applies — its rules are correctness, not looks.
import "../styles/viewerBase.css";
import "../styles/viewerThemes.css";

/**
 * Viewer runs the actual prompter content, in one of two modes from a
 * single codebase (mirroring ~/dev/webrtc-go's viewer.ts):
 *
 * - Embedded (window.parent !== window): this is the control page's own
 *   live preview iframe. It's a passive mirror — same JS process as the
 *   control page, so it talks over postMessage rather than WebRTC, and it
 *   never drives anything (no auto-scroll of its own, no scroll reports).
 * - Standalone: a popped-out window or a remote device. It owns its own WebRTC
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
  #pdf: PdfView | null = null;
  // Guards against two PDFs arriving close together: renderPdf is async, so
  // the slower one could otherwise finish last and win.
  #pdfGeneration = 0;
  #textScale = 1;
  #themeSheet = new CSSStyleSheet();
  // Last position received from the controller. Content arrives *after* the
  // catch-up position does (and a PDF renders asynchronously on top of that),
  // so at the moment it lands there is often nothing to scroll yet — the
  // ratio has to be kept and re-applied once the document has its height.
  #lastRatio = 0;

  constructor() {
    registerClockComponent();
    this.timer = document.querySelector("#timeTimer")!;

    this.#scrollSync = makeScrollSync({
      el: document.scrollingElement!,
      send: (ratio) => {
        // Track our own position as well as remote ones. The pacer is never
        // sent a scroll message (the controller fans its samples out to
        // everyone *else*), so without this its idea of where it is would
        // stay at 0 and #restoreScroll would yank it to the top on the next
        // edit.
        this.#lastRatio = ratio;
        this.#link?.sendScroll(ratio);
      },
    });

    if (globalThis.self !== globalThis.top) {
      this.isPreviewer = true;
      globalThis.addEventListener("message", (e: MessageEvent) => {
        if (e.origin !== location.origin) return;
        this.#handleControl(e.data as ControlMessage);
      });
      // The preview iframe is resized to whichever viewer it is mirroring —
      // which the operator can now change mid-session. Text reflows on its
      // own; a PDF is laid out in pixels and would keep the previous
      // viewer's column width. Deliberately not the full #listenResize: a
      // previewer must never report dims or it would show up as a viewer.
      globalThis.addEventListener("resize", () => {
        this.#pdf?.setWidth(this.#pdfWidth());
      });
      return;
    }

    const room = new URLSearchParams(location.search).get("room");
    if (!room) {
      throw new Error("missing ?room= on standalone viewer page");
    }

    this.#link = connectViewer(room, {
      onControl: (msg) => this.#handleControl(msg),
      onScroll: (ratio) => this.#applyRemoteScroll(ratio),
      // The bytes arrive chunked on their own channel; rebuilding the message
      // here means #handleControl sees the same shape the preview iframe gets
      // straight from postMessage.
      onFile: (name, data) => this.#handleControl({ type: "pdf", name, data }),
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
        // A PDF owns #main for as long as it's loaded. The control page stops
        // broadcasting content in PDF mode, but a message already in flight
        // (or a stale one from a controller that just took over) would
        // otherwise blank the document out from under the operator.
        if (this.#pdf) break;
        this.setContent(msg.html);
        break;
      case "pdf":
        this.setPdf(msg.data);
        break;
      case "pdf-clear":
        this.clearPdf();
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
        if (msg.message !== undefined) this.setMessage(msg.message);
        break;
      case "theme":
        this.setTheme(msg.layout, msg.css);
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
        this.#applyRemoteScroll(msg.r);
        break;
      case "dims":
        // Viewer only ever sends this, never receives it.
        break;
    }
  }

  #applyRemoteScroll(ratio: number) {
    this.#lastRatio = ratio;
    this.#scrollSync.applyRemote(ratio);
  }

  // Put the document back on the line it is supposed to be showing after
  // something changed its height. While the pacer is moving its ~60Hz samples
  // would cover this within a frame, but paused — or at speed 0 — nothing
  // else ever would.
  #restoreScroll() {
    this.#scrollSync.applyRemote(this.#lastRatio);
  }

  #listenResize() {
    if (this.#isResizing) return;
    this.#isResizing = true;
    globalThis.requestAnimationFrame(() => {
      this.#reportDims();
      this.resizeMessage();
      // A PDF is laid out in pixels, not reflowed by CSS, so it has to be
      // told the window changed or it keeps the old column width.
      this.#pdf?.setWidth(this.#pdfWidth());
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

    this.accumulatedScroll += (this.scrollSpeed / 1000) * timeElapsed;

    // Scroll by the whole fractional amount rather than rounding down to a
    // whole pixel. Rounding makes slow speeds visibly step, and — because a
    // frame whose rounded delta is 0 fires no scroll event at all — it also
    // made this viewer emit position samples in irregular bursts, so
    // everyone mirroring it stuttered rather than gliding.
    const before = globalThis.scrollY;
    globalThis.scrollBy(0, this.accumulatedScroll);
    // Carry whatever the browser didn't consume (it may quantise to device
    // pixels) so slow speeds still accumulate instead of being rounded away
    // every frame. Clamped so hitting the end of the document can't build
    // up an unbounded debt that snaps back on the way out.
    const moved = globalThis.scrollY - before;
    this.accumulatedScroll = Math.max(
      -globalThis.innerHeight,
      Math.min(globalThis.innerHeight, this.accumulatedScroll - moved),
    );
    this.lastScrollTime = timestamp;

    requestAnimationFrame(this.smoothScroll.bind(this));
  }

  setSpeed(speed: number) {
    this.scrollSpeed = speed;
  }

  setTextScale(scale: number) {
    this.#textScale = scale;
    this.root.style.setProperty("--textScale", `${scale}rem`);
    // A PDF has no font size to scale, so the same control becomes a zoom.
    this.#pdf?.setWidth(this.#pdfWidth());
  }

  // The rendered column width. textScale of 1 (the Text Scale slider at 10)
  // fits the page to the viewer's width; either side of that zooms. Clamped
  // because the slider's full 0.1..10 range would otherwise ask for a canvas
  // ten times the display width.
  #pdfWidth(): number {
    const main = <HTMLElement> document.querySelector("#main");
    const zoom = Math.min(4, Math.max(0.25, this.#textScale));
    return Math.max(1, main.clientWidth * zoom);
  }

  async setPdf(data: ArrayBuffer) {
    const generation = ++this.#pdfGeneration;
    this.#pdf?.destroy();
    this.#pdf = null;

    const main = <HTMLElement> document.querySelector("#main");
    main.replaceChildren();
    const view = await renderPdf(main, data, this.#pdfWidth());
    // A second PDF (or a pdf-clear) landed while this one was rendering.
    if (generation !== this.#pdfGeneration) {
      view.destroy();
      return;
    }
    this.#pdf = view;
    // A textScale that arrived while renderPdf was still awaiting updated
    // #textScale but had no view to apply it to — and the controller sends
    // exactly that, resetting the zoom to fit-width as it hands over the file.
    // Re-apply the current width now; setWidth is a no-op if nothing changed.
    await view.setWidth(this.#pdfWidth());
    // The catch-up position arrived before there were any pages to scroll.
    this.#restoreScroll();
  }

  clearPdf() {
    this.#pdfGeneration++;
    this.#pdf?.destroy();
    this.#pdf = null;
    const main = <HTMLElement> document.querySelector("#main");
    main.replaceChildren();
  }

  setContent(content: string) {
    const main = <HTMLDivElement> document.querySelector("#main");
    main.innerHTML = content;
    // New content means a new scrollHeight, and the browser keeps scrollTop
    // in pixels — so without this the same document sits on a different line
    // on every viewer after an edit.
    this.#restoreScroll();
  }

  setMessage(content: string) {
    this.spanMessage.innerText = content;
    this.resizeMessage();
  }

  // Wear a layout. The built-ins need nothing but the class: their rules are
  // @scope'd to it in viewerThemes.css, so switching the class is what turns
  // one off and the other on — and a `theme-user-*` class matches neither, so
  // a custom theme replaces the built-in layer for free with no unloading.
  // Only viewerBase.css, which is unscoped, survives underneath.
  //
  // An adopted stylesheet rather than an injected <style>: adopted sheets
  // cascade *after* the document's own <link>/<style>, so a theme rule of
  // equal specificity wins, which is what "replace" has to mean. Reusing the
  // one sheet across switches also stops them piling up.
  setTheme(layout: string, css: string | null) {
    document.body.className = layout;
    if (css === null) {
      document.adoptedStyleSheets = [];
      return;
    }
    try {
      this.#themeSheet.replaceSync(css);
    } catch (err) {
      // Verified in Chrome: replaceSync doesn't throw on bad CSS. It drops
      // what it can't use — an unparseable declaration, or an @import, which
      // an adopted sheet has no base URL to resolve and which it merely warns
      // about. That is the behaviour we want during a service: a partly
      // styled screen beats a blank one. This is the last resort for whatever
      // does throw, and it keeps the sheet already installed rather than
      // leaving the viewer unstyled.
      console.warn("unusable theme CSS, keeping the previous one", err);
      return;
    }
    document.adoptedStyleSheets = [this.#themeSheet];
  }
}
