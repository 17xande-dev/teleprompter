import { registerClockComponent, TPClock } from "./clock.ts";
import { connectViewer, type ViewerLink } from "./webrtc.ts";
import {
  carryRemainder,
  fractionIntoBlock,
  makeScrollSync,
  pendingScroll,
  ratioOf,
  type ScrollSync,
  scrollTopIntoBlock,
  wheelPixels,
} from "./scrollsync.ts";
import { scaleFromPinch, scaleFromWheel } from "./textscale.ts";
import { type PdfView, renderPdf } from "./pdfview.ts";
import { LOCAL_CHANNEL } from "./protocol.ts";
import type { ControlMessage, PreviewScrollMessage } from "./protocol.ts";

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
 *   live preview iframe. Same JS process as the control page, so it talks over
 *   postMessage rather than WebRTC, and it runs no auto-scroll loop of its own
 *   — its motion is entirely the controller's. It is not quite the passive
 *   mirror it used to be: it reports its scroll ratio upward, because the
 *   operator can scrub the show from it. It is still never scrolled *by hand*
 *   and never a driver; the gesture lands on the control page, which forwards
 *   it here as `scroll-by` (see that message, and #handleControl's case).
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

  /**
   * The box the script is laid out in, and the scroller.
   *
   * Sized to the *reference* display rather than to this screen, so every
   * display lays out identically and one shared scroll ratio lands on the same
   * line everywhere — see StageMessage. Until one arrives it is this screen's
   * own size at scale 1, which is how a lone display behaves exactly as it did
   * before the stage existed.
   */
  #stage: HTMLElement;
  #scrollSync: ScrollSync;
  #link: ViewerLink | null = null;
  #isResizing = false;
  #pdf: PdfView | null = null;
  // Guards against two PDFs arriving close together: renderPdf is async, so
  // the slower one could otherwise finish last and win.
  #pdfGeneration = 0;
  #textScale = 1;
  // The reference display's box, in its own pixels. Zero until the controller
  // says otherwise, which leaves the CSS default of this screen's own size.
  #stageWidth = 0;
  #stageHeight = 0;
  #themeSheet = new CSSStyleSheet();
  // The size the pinch started from, frozen for the length of the gesture. The
  // controller echoes each new size back as it arrives, so compounding a
  // cumulative ratio onto a base that has already moved runs away
  // exponentially — the gesture would multiply with its own echo.
  #gestureBase = 1;
  // How far apart the two fingers were when the pinch began. Zero means no
  // pinch is in flight.
  #gestureSpread = 0;
  #scaleFrame = 0;
  // Last position received from the controller. Content arrives *after* the
  // catch-up position does (and a PDF renders asynchronously on top of that),
  // so at the moment it lands there is often nothing to scroll yet — the
  // ratio has to be kept and re-applied once the document has its height.
  #lastRatio = 0;

  constructor() {
    registerClockComponent();
    this.timer = document.querySelector("#timeTimer")!;

    this.#stage = <HTMLElement> document.querySelector("#stage");
    this.#scrollSync = makeScrollSync({
      // The stage, not the viewport. The viewport is clipped and never scrolls
      // (viewerBase.css), because the stage's box is allowed to be larger than
      // the screen — the scale transform is what makes it fit, and scrollTop
      // therefore stays in the reference display's pixel space, identical on
      // every screen.
      el: this.#stage,
      send: (ratio) => {
        // Track our own position as well as remote ones. The pacer is never
        // sent a scroll message (the controller fans its samples out to
        // everyone *else*), so without this its idea of where it is would
        // stay at 0 and #restoreScroll would yank it to the top on the next
        // edit.
        this.#lastRatio = ratio;
        if (this.isPreviewer) {
          // Where the operator just put us, offered to the control page —
          // which ignores it unless it is expecting one. It has to be offered
          // unconditionally because this fires for a layout clamp as well as
          // for a gesture, and only the control page knows which it asked
          // for. Same-origin, and the parent checks the source.
          //
          // Typed rather than sent as a bare literal: this is the one message
          // with no compile-time tie to its receiver — postMessage takes
          // `unknown` and the control page has to re-validate whatever
          // arrives — so annotating it here is the only thing that makes
          // renaming `r` a type error instead of a scrub that silently stops
          // working.
          const report: PreviewScrollMessage = {
            type: "preview-scroll",
            r: ratio,
          };
          globalThis.parent.postMessage(report, location.origin);
          return;
        }
        this.#link?.sendScroll(ratio);
      },
    });

    // Being framed was never what made this the preview pane — having no room
    // to join was. The two used to be the same thing, so the cheaper test
    // stood in for the real one, and it stopped being true the moment
    // something else framed this page: the marketing site's live demo puts
    // /viewer?room=<id> in an iframe and got a viewer that rendered nothing
    // and connected to nothing, silently, because this branch claimed it.
    //
    // The control page's own preview is still `/viewer` with no query, so it
    // still lands here and the contract between the two is unchanged.
    const room = new URLSearchParams(location.search).get("room");
    if (!room) {
      if (globalThis.self === globalThis.top) {
        throw new Error("missing ?room= on standalone viewer page");
      }
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
        this.#fitStage();
        this.#pdf?.setWidth(this.#pdfWidth());
        // Relaying out a PDF changes scrollHeight while scrollTop stays in
        // pixels, so the ratio this is showing drifts every time the operator
        // drags a divider. The real viewers' #listenResize already restores;
        // this branch was the one that didn't.
        this.#restoreScroll();
      });
      return;
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
    this.#listenZoomGestures();
    this.#detectLocal();
    // The manual way in and out, for a display reached by link or QR code —
    // and the fallback for a local screen whose browser ignored the
    // `fullscreen` window feature. Caught, not awaited: a rejected
    // requestFullscreen (no activation, or a browser that refuses) is a
    // non-event here, and uncaught it was an unhandled promise on every
    // double-click that missed.
    self.addEventListener("dblclick", () => {
      document.documentElement.requestFullscreen().catch(() => {});
    });
    this.#greetOpener();
    this.#goFullscreen();

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
        // Caught, because setPdf clears #main *before* it awaits renderPdf: a
        // PDF pdf.js cannot read (corrupt, encrypted, truncated in transit)
        // left the display blank with the rejection going nowhere, and a blank
        // display in front of the talent is indistinguishable from a dead
        // link. The message says which file and why, in the console the
        // operator opens when a screen misbehaves.
        this.setPdf(msg.data).catch((err) => {
          console.error(`could not render ${msg.name}`, err);
        });
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
      case "stage":
        this.setStage(msg.width, msg.height);
        break;
      case "theme":
        this.setTheme(msg.layout, msg.css);
        break;
      case "clock":
        // One assignment for what used to be three commands. The controller
        // is authoritative about the countdown and says what it *is*, so a
        // display that just reloaded lands on the right value instead of on
        // whichever commands it happened to be present for.
        this.timer.setState(msg);
        break;
      case "set-driver":
        this.setCanDrive(msg.canDrive);
        break;
      case "scroll":
        this.#applyRemoteScroll(msg.r);
        break;
      case "scroll-by":
        // The operator scrubbing the preview. Deliberately *not* routed
        // through #applyRemoteScroll: that arms the echo guard, and the whole
        // point here is that the resulting scroll event must be sampled and
        // reported back so the displays follow. This is the same bare
        // scrollBy the auto-scroll loop uses to produce the driver's samples,
        // for the same reason.
        if (!this.isPreviewer) break;
        this.#stage.scrollBy(0, msg.px);
        break;
      case "dims":
      case "text-scale":
        // Viewer only ever sends these, never receives them. The controller's
        // answer to a text-scale is a settings message, so the size arrives
        // back through the same path it does for every other display.
        break;
      default: {
        // Exhaustiveness, checked by the compiler: `msg` is only assignable to
        // `never` here while every ControlMessage variant above is handled.
        // Add a variant to the protocol and forget it, and this stops
        // compiling — which is the only thing that would have caught it. A
        // switch that merely fell through was silent, and "the display ignores
        // one kind of message" looks exactly like a network fault from the
        // control page.
        const unhandled: never = msg;
        void unhandled;
        break;
      }
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
      // The screen changed size, so the stage's fit has to be recomputed —
      // its own box has not changed, only how much room there is to show it
      // in. Before resizeMessage, which measures against the laid-out result.
      this.#fitStage();
      this.resizeMessage();
      // A PDF is laid out in pixels, not reflowed by CSS, so it has to be
      // told the window changed or it keeps the old column width.
      this.#pdf?.setWidth(this.#pdfWidth());
      this.#isResizing = false;
    });
  }

  /**
   * Fill the screen, if this window was opened to be a screen.
   *
   * Gated on `opener` because it must only apply to a window the control page
   * opened for the talent — grabbing the screen out from under someone who
   * followed a link would be hostile.
   *
   * The attempt on load is expected to fail and is made anyway, for the case
   * where a browser hands the popup an activation: `window.open` *consumes*
   * the opener's, so this document normally has none and Chrome refuses the
   * request. Measured, not assumed — a click-opened display comes up with
   * `document.fullscreenElement === null` every time. The control page's
   * `fullscreen` window feature is the zero-click path where it applies
   * (Chromium, with the Window Management permission, placing a companion
   * window on a second display); everywhere else the only thing that will do
   * it is a gesture in this window, so #fsPrompt asks for one and takes any
   * click on the page. It hides itself the moment the screen is filled,
   * however that happened.
   */
  #goFullscreen() {
    if (!globalThis.opener) return;

    // Worth trying only when there is an activation to spend. window.open
    // consumes the opener's, so normally there is none — and calling anyway
    // does not merely fail quietly, it puts "API can only be initiated by a
    // user gesture" in the operator's console on every single open, which a
    // catch cannot suppress because Chrome logs it itself. Skipped rather
    // than swallowed. `isActive` is Chromium-only; where it is missing the
    // call is still worth making.
    if (
      !document.fullscreenElement &&
      navigator.userActivation?.isActive !== false
    ) {
      document.documentElement.requestFullscreen().catch(() => {});
    }

    // Fill the screen without asking anyone for anything. A window this page
    // opened may be resized and moved by script with no user activation —
    // unlike fullscreen — and a `popup=true` window carries no tab bar or
    // bookmarks, so what is left above the script is a thin URL strip. Not as
    // good as fullscreen and it needs no gesture at all, which on a
    // single-screen setup is the difference between the talent seeing the
    // script and the talent seeing an instruction to click.
    // After `load`, not now: this runs while the window is still being placed,
    // and a resize asked for then is undone by the placement that follows —
    // measured, the same call landing 1518px wide on load and 3072 a moment
    // later. A window manager that owns geometry (a tiling one) overrides it
    // whenever it is asked; a click still gets true fullscreen there.
    const fill = () => {
      try {
        // availLeft/availTop are non-standard (and untyped) but are the only
        // way to land on the right screen in a multi-monitor setup, where the
        // available area of the display this window is on does not start at 0.
        const area = <{
          availLeft?: number;
          availTop?: number;
        }> <unknown> screen;
        globalThis.moveTo(area.availLeft ?? 0, area.availTop ?? 0);
        globalThis.resizeTo(screen.availWidth, screen.availHeight);
      } catch {
        // Some browsers refuse either call. The window is then whatever size
        // it was given, which still shows the script.
      }
    };
    if (document.readyState === "complete") fill();
    else self.addEventListener("load", fill);

    // And a click anywhere takes the strip away too. No prompt for it: this
    // display is pointed at the talent, and a message that has to be clicked
    // away is worse than a strip of browser chrome. The operator who wants
    // true fullscreen knows to click, and the double-click handler in the
    // caller is the way back out.
    self.addEventListener("click", () => {
      if (document.fullscreenElement) return;
      document.documentElement.requestFullscreen().catch(() => {});
    });
  }

  /**
   * Tell the control page that opened this window that it is still here.
   *
   * Repeated rather than said once, because the *listener* is the thing that
   * comes and goes: an operator refreshing the control page loses its handle
   * on this window, while `opener` here still points at it. The next hello
   * lets the fresh page adopt this display and show its Screen button pressed
   * again. Only meaningful for a window the control page opened — a display
   * reached by link or QR code has no opener and says nothing.
   */
  #greetOpener() {
    const opener = globalThis.opener as Window | null;
    if (!opener) return;
    const hello = () => {
      try {
        opener.postMessage({ type: "pop-hello" }, location.origin);
      } catch {
        // The opener is gone for good (closed, or navigated cross-origin).
        // Nothing to recover: this display keeps working on its own.
      }
    };
    hello();
    setInterval(hello, 2000);
  }

  #reportDims() {
    // The *layout* viewport, not innerWidth/innerHeight, and the difference is
    // load-bearing rather than pedantic. These dimensions exist to shape the
    // control page's preview iframe, and the scroll ratio everyone shares is
    // computed against `document.scrollingElement` — the same element
    // makeScrollSync is bound to above. A ratio maps to
    // `r * (scrollHeight - clientHeight)`, so if the preview's layout viewport
    // is a different height from this display's, the same ratio lands on a
    // different line, by `r * Δheight`.
    //
    // innerHeight reads more natural and is what someone will change this back
    // to, so: on a phone or tablet acting as a display it tracks the *visual*
    // viewport and shrinks as the URL bar collapses, while
    // scrollingElement.clientHeight is the layout viewport and stays put. The
    // two differ by 60-110 CSS px on mobile Chrome and Safari, which is
    // exactly the "off by about a clock strip" the operator sees. Same story
    // for a display with classic scrollbars.
    const el = document.scrollingElement!;
    this.#link?.sendControl({
      type: "dims",
      width: el.clientWidth,
      height: el.clientHeight,
      local: this.#isLocal,
    });
  }

  /**
   * Whether this display is on the same machine as the control page.
   *
   * Worth telling the operator, because otherwise "3 displays" reads the same
   * whether three people are watching or three windows are stacked on one
   * laptop, and those are very different situations to be in ten seconds
   * before a service.
   *
   * Two signals, both same-origin. `opener` catches a screen the control page
   * opened. A BroadcastChannel catches the rest: the channel only reaches
   * other pages of this origin in this browser profile, so a control page
   * answering means it is running right here. That second signal is what
   * covers a display the operator opened on a second monitor by hand — the
   * viewer link carries rel="noopener", so such a window has no opener to go
   * on.
   *
   * The honest limit is "same browser profile on this machine", so a display
   * in a *different* browser on the same desk reports as remote. Nothing is
   * granted on the strength of this, so being wrong is cosmetic.
   */
  #isLocal = !!globalThis.opener;

  #detectLocal() {
    if (this.#isLocal) return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(LOCAL_CHANNEL);
    } catch {
      // No BroadcastChannel (or blocked storage): fall back to `opener`
      // alone, which is already in #isLocal.
      return;
    }
    channel.addEventListener("message", (e: MessageEvent) => {
      if ((<{ type?: string }> e.data)?.type !== "here") return;
      if (this.#isLocal) return;
      this.#isLocal = true;
      // The controller has already been told `false`, on connect. Nothing
      // else will correct that until the next resize, so say so now.
      this.#reportDims();
    });
    channel.postMessage({ type: "who" });
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
    // The frame clock, taken once and advanced before any branch below can
    // return. It used to be advanced at the bottom of each exit path, and the
    // "at the end of the script" branch was the one that forgot — so the time
    // a viewer sat parked at the end accumulated, and the next frame that did
    // scroll measured `timeElapsed` as that whole parked duration and asked
    // for it all at once. Sent back up the script after 30s at the end at
    // 100px/s, it asked for 3000px and snapped straight back. Hoisting it here
    // makes forgetting structurally impossible rather than a thing to
    // remember in three places.
    if (this.lastScrollTime === 0) this.lastScrollTime = timestamp;
    const timeElapsed = timestamp - this.lastScrollTime;
    this.lastScrollTime = timestamp;

    // Measured on the scroller itself, which is also a fix: this used to
    // compare `innerHeight + scrollY` against `document.body.offsetHeight`
    // while the scrollable range came from `scrollHeight`, so a display parked
    // tens of pixels short of its real end — and never auto-scrolled at all
    // when the document was shorter than the viewport, because the comparison
    // was permanently true. Both quantities now come from the same element.
    const stage = this.#stage;
    const atEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight;
    if (this.scrollSpeed > 0 && atEnd) {
      // if we're at the bottom of the page, don't continue scrolling.
      requestAnimationFrame(this.smoothScroll.bind(this));
      return;
    }

    this.accumulatedScroll = pendingScroll(
      this.scrollSpeed,
      timeElapsed,
      this.accumulatedScroll,
    );

    // Stopped means stopped: don't touch the viewport at all. See
    // pendingScroll — a sub-pixel carry that outlived its speed is what made
    // an iPhone go on creeping after the operator zeroed the slider.
    if (this.accumulatedScroll === 0) {
      requestAnimationFrame(this.smoothScroll.bind(this));
      return;
    }

    // Scroll by the whole fractional amount rather than rounding down to a
    // whole pixel. Rounding makes slow speeds visibly step, and — because a
    // frame whose rounded delta is 0 fires no scroll event at all — it also
    // made this viewer emit position samples in irregular bursts, so
    // everyone mirroring it stuttered rather than gliding.
    const before = stage.scrollTop;
    const wanted = this.accumulatedScroll;
    stage.scrollBy(0, wanted);
    // Carry only what the browser rounded away, never what it refused: see
    // carryRemainder, which is where the difference is spelled out and why
    // banking a blocked scroll used to pin a viewer to one end of its script.
    const moved = stage.scrollTop - before;
    this.accumulatedScroll = carryRemainder(wanted, moved);

    requestAnimationFrame(this.smoothScroll.bind(this));
  }

  setSpeed(speed: number) {
    this.scrollSpeed = speed;
  }

  /**
   * Whether this viewer may be scrolled by hand.
   *
   * The grant has to reach CSS, not just this field: the viewport's overflow
   * is taken from the body element (`html` is `visible`), and viewerBase.css
   * locks it so a stray wheel or touch can't move a display. Without lifting
   * that lock the grant meant nothing — the field was set and never read, so
   * "allow drive" looked like it did something and didn't.
   *
   * Nothing gates the *reporting* of a position: the viewer sends its scroll
   * unconditionally and the controller ignores everyone but the driver, so
   * revoking drive can't leave a stale sender fighting the new one.
   */
  setCanDrive(canDrive: boolean) {
    const changed = this.canDrive !== canDrive;
    this.canDrive = canDrive;
    document.documentElement.classList.toggle("can-drive", canDrive);
    // Granting drive swaps body's overflow from hidden to auto, which on a
    // desktop with classic scrollbars *shrinks the layout viewport* — measured
    // at 15px in both axes in Chromium. That is the quantity `dims` reports and
    // the quantity the shared scroll ratio is computed against, so it is now
    // stale: the controller goes on sizing its preview to the pre-scrollbar
    // figure, and the same ratio then lands the preview and this display
    // r * 15px apart. No resize event fires for it, because the window has not
    // changed size — only the space inside it. So re-report.
    if (changed) this.#reportDims();
  }

  /**
   * Lay this display out in the reference display's box.
   *
   * Everything that decides where a line falls — the wrapping width, the
   * theme's container units, the PDF column — is measured from the stage, so
   * giving every display the same one is what makes a single scroll ratio mean
   * the same line on all of them. The transform that fits it to this screen is
   * visual only and changes none of those.
   */
  setStage(width: number, height: number) {
    if (!(width > 0) || !(height > 0)) return;
    if (width === this.#stageWidth && height === this.#stageHeight) return;
    this.#stageWidth = width;
    this.#stageHeight = height;
    this.root.style.setProperty("--stage-width", `${width}px`);
    this.root.style.setProperty("--stage-height", `${height}px`);
    this.#fitStage();
    // The column width changed with the stage, and a PDF is laid out in pixels
    // rather than reflowing.
    this.#pdf?.setWidth(this.#pdfWidth());
    // A new box is a new scrollHeight while scrollTop stays in pixels, so the
    // position this is showing has to be re-anchored — the same reason
    // setContent and the resize handler do it.
    this.#restoreScroll();
  }

  /**
   * Scale the stage to fit this screen, keeping its shape.
   *
   * The smaller factor wins and the rest of the screen is letterboxed, which is
   * the deliberate trade: a display of a different shape gives up some area in
   * exchange for showing exactly what every other display shows. Measured
   * against the layout viewport rather than `innerHeight`, for the reason
   * #reportDims gives.
   */
  #fitStage() {
    if (!this.#stageWidth || !this.#stageHeight) return;
    const el = document.documentElement;
    // Not laid out yet; the resize that follows will do this properly. Zero
    // would otherwise be written as the scale and the screen would go blank.
    if (!el.clientWidth || !el.clientHeight) return;
    const scale = Math.min(
      el.clientWidth / this.#stageWidth,
      el.clientHeight / this.#stageHeight,
    );
    if (!Number.isFinite(scale) || scale <= 0) return;
    this.root.style.setProperty("--stage-scale", `${scale}`);
  }

  setTextScale(scale: number) {
    // A bigger font wraps the script differently, so the line being read moves
    // — and it moves by a different amount on a long paragraph than on a short
    // one, which is why the position cannot simply be kept as a fraction. Every
    // display re-anchors on the block it was showing, independently and with no
    // message from anyone: they all lay out in the same reference box (see
    // StageMessage), so they land on the same block without a scroll message
    // having to race the settings message that caused this. In a PDF there is
    // nothing to re-wrap and PdfView.setWidth does its own ratio re-anchor, so
    // a second one here would only fight it.
    const anchor = this.#pdf ? null : this.#topBlockAnchor();
    this.#textScale = scale;
    this.root.style.setProperty("--textScale", `${scale}rem`);
    // A PDF has no font size to scale, so the same control becomes a zoom.
    this.#pdf?.setWidth(this.#pdfWidth());
    this.#restoreBlockAnchor(anchor);
  }

  /**
   * Pinch, or Ctrl+wheel, to resize the script from the display itself.
   *
   * The Text Scale slider is on the control page, so the only person who can
   * resize the script is the operator at the desk — while the person who can
   * see it is wrong is standing at the screen. This gives that person the
   * control, on the one display that is allowed to move the room: the driver.
   *
   * **Only the driver**, checked here *and* on the controller. Same rule as
   * hand-scrolling and the same reason — two displays resizing at once would
   * fight with nothing to settle it — and the preview iframe is excluded by
   * name rather than by circumstance. It is excluded today only because the
   * controller never posts it a `set-driver` and the iframe takes no pointer
   * events, and CLAUDE.md is flat that the preview must never become an
   * exception to the drive rule; leaving that to two coincidences elsewhere is
   * a trap for whoever next touches #applyScrollRoles.
   *
   * There is no "zoom event" to listen for. What the platform offers is three
   * things, two of which are used here:
   *
   * - `wheel` with `ctrlKey`, which is both a trackpad pinch and Ctrl+scroll on
   *   an ordinary mouse. One handler, every non-touch device, and it is the
   *   gesture the browser itself would have zoomed with.
   * - A two-finger pinch on a touchscreen, which produces no `wheel` event at
   *   all. WebKit has its own `gesturechange`, whose `scale` is already the
   *   ratio from the start of the gesture; everywhere else it is two pointers.
   *   Feature-detected, so the two can never both fire.
   * - `visualViewport` resize, i.e. the *browser* zooming the page. That one is
   *   to be prevented rather than consumed: browser zoom moves the visual
   *   viewport while #reportDims reports the layout viewport, so a
   *   pinch-zoomed display would quietly stop matching the box every other
   *   display lays out in. `touch-action: pan-y` on the stage and
   *   `preventDefault` on the wheel are what withhold it.
   */
  #listenZoomGestures() {
    const stage = this.#stage;
    stage.addEventListener("wheel", (e: WheelEvent) => {
      if (!e.ctrlKey || !this.#canZoom()) return;
      // Non-passive, and this is what stops the browser zooming the page
      // instead — see above for why that would desync this display.
      e.preventDefault();
      const pixels = wheelPixels(e.deltaY, e.deltaMode, stage.clientHeight);
      this.#requestTextScale(scaleFromWheel(this.#textScale, pixels));
    }, { passive: false });

    // Safari's own pinch events. `e.scale` is cumulative from gesturestart,
    // which is exactly the ratio scaleFromPinch wants.
    if ("ongesturechange" in globalThis) {
      const start = (e: Event) => {
        if (!this.#canZoom()) return;
        e.preventDefault();
        this.#gestureBase = this.#textScale;
      };
      stage.addEventListener("gesturestart", start);
      stage.addEventListener("gesturechange", (e: Event) => {
        if (!this.#canZoom()) return;
        e.preventDefault();
        const scale = (<{ scale?: number }> <unknown> e).scale ?? 1;
        this.#requestTextScale(scaleFromPinch(this.#gestureBase, scale));
      });
      return;
    }

    // Two pointers, the distance between them, and the ratio to where they
    // started. Pointer Events rather than Touch Events: it is what the
    // control page's scrub drag already uses, and `pointercancel` is the
    // signal we want — with `touch-action: pan-y` the browser claims a
    // one-finger vertical drag once it passes its slop threshold, so a second
    // finger arriving late degrades into a scroll rather than into half a
    // pinch that never ends.
    const points = new Map<number, { x: number; y: number }>();
    const spread = () => {
      const [a, b] = [...points.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const drop = (e: PointerEvent) => {
      points.delete(e.pointerId);
      if (points.size < 2) this.#gestureSpread = 0;
    };
    stage.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !this.#canZoom()) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size === 2) {
        this.#gestureSpread = spread();
        this.#gestureBase = this.#textScale;
      }
    });
    stage.addEventListener("pointermove", (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size !== 2 || !this.#gestureSpread || !this.#canZoom()) return;
      this.#requestTextScale(
        scaleFromPinch(this.#gestureBase, spread() / this.#gestureSpread),
      );
    });
    stage.addEventListener("pointerup", drop);
    stage.addEventListener("pointercancel", drop);
  }

  /** Whether this display may resize the room. */
  #canZoom(): boolean {
    return !this.isPreviewer && this.canDrive;
  }

  /**
   * Apply a gesture's size here, and ask the controller for it everywhere.
   *
   * Applied locally first so the gesture tracks the fingers rather than a round
   * trip, and the controller's answer arrives as an ordinary `settings` — the
   * same message every other display gets, which is what stops this display
   * ending up a step out from the rest.
   *
   * Coalesced to one request per frame. A pinch fires as fast as the touch
   * hardware reports, and each request costs every *other* display a full
   * relayout of the script; the rounding to tenths already drops most of them.
   */
  #requestTextScale(scale: number) {
    if (scale === this.#textScale) return;
    // In a PDF the "text scale" is a zoom that #pdfWidth clamps to 0.25..4, so
    // past that the gesture would go on moving the room's shared number — and
    // the operator's slider with it — while nothing on any screen changed.
    if (this.#pdf && (scale > 4 || scale < 0.25)) return;
    this.setTextScale(scale);
    if (this.#scaleFrame) return;
    this.#scaleFrame = requestAnimationFrame(() => {
      this.#scaleFrame = 0;
      this.#link?.sendControl({ type: "text-scale", scale: this.#textScale });
    });
  }

  /**
   * The block at the top of the visible area, and how far into it we are.
   *
   * Held as the *element* rather than as an index into an offsets array: after
   * a relayout its new position is one `offsetTop` read away, where rebuilding
   * the array would walk every block on a script that can run to hundreds.
   *
   * Measured by walking `offsetParent`, not by `getBoundingClientRect`. On a
   * display the stage carries `transform: scale()`, and rects are in the
   * transformed space while `scrollTop` is not — mixing them would scale every
   * offset by the letterboxing factor. (The control page's own `#blockMetrics`
   * reaches the opposite conclusion, for the opposite reason: nothing there is
   * scaled, and the editor's scroller is not positioned, so it is not in the
   * offsetParent chain at all. Both are the correct answer to their own case.)
   */
  #topBlockAnchor(): { el: HTMLElement; fraction: number } | null {
    const main = document.querySelector("#main");
    if (!main) return null;
    const fold = this.#stage.scrollTop + this.#foldOffset();
    for (const child of main.children) {
      const el = <HTMLElement> child;
      const elTop = this.#offsetInStage(el);
      const height = el.offsetHeight;
      if (elTop + height <= fold) continue;
      return { el, fraction: fractionIntoBlock(fold, elTop, height) };
    }
    return null;
  }

  /**
   * How far below the top of the scroller the first *readable* line sits.
   *
   * The clock strip is sticky with a background of its own, so it covers the
   * script rather than scrolling away with it: the line the talent is reading
   * at the top of the screen is the one at `scrollTop + this`, not at
   * `scrollTop`. Anchoring without it put every re-anchored block underneath
   * the strip — measured at 118px, about two lines, and at the very top of the
   * script it turned a scrollTop of 0 into 118, so a resize nudged a display
   * off the first line it was showing.
   *
   * Read rather than assumed, because a user theme may not make the strip
   * sticky, or may not have one at all.
   */
  #foldOffset(): number {
    const header = <HTMLElement | null> document.querySelector("#header");
    if (!header) return 0;
    const position = getComputedStyle(header).position;
    if (position !== "sticky" && position !== "fixed") return 0;
    return header.offsetHeight;
  }

  /** Put the anchored block back at the first readable line, after the relayout. */
  #restoreBlockAnchor(anchor: { el: HTMLElement; fraction: number } | null) {
    // A theme or a fresh document can replace the element out from under an
    // anchor taken moments earlier; there is nothing to restore to then, and
    // #restoreScroll's ratio is the fallback it has always been.
    if (!anchor || !anchor.el.isConnected) return;
    const move = () => {
      this.#stage.scrollTop = scrollTopIntoBlock(
        this.#offsetInStage(anchor.el),
        anchor.el.offsetHeight,
        anchor.fraction,
      ) - this.#foldOffset();
    };
    // Silent on a real display, and deliberately *not* silent in the preview.
    // A display's re-anchor is its own answer to a size change and every other
    // display is working the same one out — sending it is how the driver's new
    // geometry ends up being applied to a document that has not been rescaled
    // yet. The preview's report is the control page's only way to learn where
    // the room has ended up (#lastRatio, which feeds catchUpMessages), and it
    // is accepted there without being fanned out.
    if (this.isPreviewer) move();
    else this.#scrollSync.applySilently(move);
    // The ratio moved, and it is what #restoreScroll would otherwise yank this
    // back to on the next edit — and what this display reports as its position.
    this.#lastRatio = ratioOf(this.#stage);
  }

  /** How far an element sits down the stage's scroll, in stage pixels. */
  #offsetInStage(el: HTMLElement): number {
    let top = 0;
    let node: HTMLElement | null = el;
    // #stage is positioned, so it is an offsetParent and the walk stops there
    // rather than sailing past it. The loop also covers a block nested one
    // level deeper than #main, which a theme is free to do.
    while (node && node !== this.#stage) {
      top += node.offsetTop;
      node = <HTMLElement | null> node.offsetParent;
    }
    return top;
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
    // Before #pdfWidth() is asked anything: the class takes the script's side
    // gutter off, and #pdfWidth measures clientWidth, which includes padding.
    // Asked with the gutter still on, every page renders a gutter too wide for
    // the box it has to fit in.
    main.classList.add("pdf");
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
    // Back to a script, so the side gutter comes back with it.
    main.classList.remove("pdf");
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
