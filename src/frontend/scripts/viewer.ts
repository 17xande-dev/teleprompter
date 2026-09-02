import { registerClockComponent, TPClock, TPClockControl } from "./clock.ts";
import { Teleprompter } from "./teleprompter.ts";

// CSS imports.
import "@awesome.me/webawesome/dist/styles/themes/shoelace.css";
import "../styles/popThemesDefault.css";

export class Viewer {
  controller: Teleprompter | null = null;
  lastScrollTime: number = 0;
  accumulatedScroll: number = 0;
  scrollSpeed: number = 0;
  root = <HTMLHtmlElement> document.querySelector(":root");
  spanMessage = <HTMLSpanElement> document.querySelector("#message");
  timer: TPClock;
  messageMin = 10;
  messageMax = 75;
  scroll = false;
  isPreviewer = false;
  isScrolling = false;
  isResizing = false;
  scrollY = 0;
  scrollTop = 0;
  height = 0;
  width = 0;
  x = 0;
  y = 0;

  constructor() {
    registerClockComponent();
    this.root = document.querySelector(":root")!;
    this.timer = document.querySelector("#timeTimer")!;

    // TODO: move this to own function.
    globalThis.addEventListener("load", () => {
      let controllerWindow = globalThis.opener;
      // Detect if it's an iframe
      if (globalThis.self !== globalThis.top) {
        controllerWindow = globalThis.parent;
        this.isPreviewer = true;
      }
      this.controller = controllerWindow.teleprompter;
      this.controller?.updateMain();

      const tpPopClock = <TPClock> document.querySelector(
        "#timeTimer",
      );

      const tpClockControl = <TPClockControl> controllerWindow.document
        .querySelector("#tpClockControl");

      if (!tpPopClock) {
        throw new Error("tp-clock not found on popup");
      }

      if (!tpClockControl) {
        throw new Error("tp-clock-control not found on main");
      }

      // TODO: remove this, we should use events to do things.
      tpClockControl.popCountdown = tpPopClock;
      if (this.controller) {
        globalThis.scroll(0, this.controller.viewerScrollY);
      }

      this.startSmoothScroll();
    });

    if (!this.isPreviewer) {
      self.addEventListener("scroll", this.listenScroll.bind(this));
      self.addEventListener("resize", this.listenResize.bind(this));
      self.addEventListener("dblclick", () => {
        document.documentElement.requestFullscreen();
      });
    }
  }

  listenResize() {
    if (this.isResizing) return;
    globalThis.requestAnimationFrame(() => {
      this.saveDimensions();
      this.resizeMessage();
      this.isResizing = false;
    });
    this.isResizing = true;
  }

  listenScroll() {
    if (this.isScrolling) return;
    globalThis.requestAnimationFrame(() => {
      this.scrollY = globalThis.scrollY;
      this.scrollTop = globalThis.pageYOffset ||
        document.documentElement.scrollTop;
      if (this.controller) {
        // TODO: set this in the controller.listenscroll. Best not to change variables directly = side effects
        this.controller.viewerScrollY = globalThis.scrollY;
        this.controller.listenScroll(this.scrollTop);
      }
      this.isScrolling = false;
    });
    this.isScrolling = true;
  }

  saveDimensions() {
    this.height = globalThis.outerHeight;
    this.width = globalThis.outerWidth;
    this.x = globalThis.screenX;
    this.y = globalThis.screenY;
    if (!this.controller) return;
    this.controller.popDimensions.height = this.height;
    this.controller.popDimensions.width = this.width;
    this.controller.popDimensions.x = this.x;
    this.controller.popDimensions.y = this.y;
    // TODO: send all thse values in the listeResize, no side effects is a better strategy
    this.controller.listenResize(globalThis.innerWidth, globalThis.innerHeight);
  }

  resizeMessage() {
    // Rerset to min first so we measure full size.
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
    this.lastScrollTime = 0; // Reset last scroll time
    this.accumulatedScroll = 0; // Reset accumulated scroll
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
    // Calculate the time difference since the last scroll
    if (this.lastScrollTime === 0) this.lastScrollTime = timestamp;
    const timeElapsed = timestamp - this.lastScrollTime;

    // Calculate how many pixels we need to scroll based on the speed
    const pixelsToScroll = (this.scrollSpeed / 1000) * timeElapsed; // Pixels per millisecond
    this.accumulatedScroll += pixelsToScroll; // Accumulate fractional scroll

    // Scroll the page by the integer part of this.accumulatedScroll
    const pixelsToScrollNow = Math.floor(this.accumulatedScroll);
    globalThis.scrollBy(0, pixelsToScrollNow);

    // Keep the fractional part for the next frame
    this.accumulatedScroll -= pixelsToScrollNow;
    this.lastScrollTime = timestamp;

    // Continue the animation.
    requestAnimationFrame(this.smoothScroll.bind(this));
  }

  setSpeed(speed: number) {
    this.scrollSpeed = speed; // Update speed in pixels per second
  }

  setTextScale(scale: number) {
    this.root.style.setProperty("--textScale", `${scale}rem`);
  }

  setContent(content: string) {
    // TODO: store this selector/element in the constructor
    const popMain = <HTMLDivElement> document.querySelector(
      "#main",
    );
    popMain.innerHTML = content;
  }

  setMessage(content: string) {
    // TODO: store this selector/element in the constructor
    const spanMessage = <HTMLSpanElement> document.querySelector("#message");
    spanMessage.innerText = content;
    this.resizeMessage();
  }
}

// const displayMediaOptions: DisplayMediaStreamOptions = {
// 	monitorTypeSurfaces: "exclude",
// 	preferCurrentTab: true,
// 	selfBrowserSurface: "include",
// 	surfaceSwitching: "exclude",
// 	systemAudio: "exclude",
// 	monitorTypeSurface: "exclude",
// }

// async function startCapture() {
//   const captureStream = await navigator.mediaDevices.getDisplayMedia().catch(
//     (e) => console.error(e)
//   );
//   if (!captureStream) return;
//   let peerConnection = new RTCPeerConnection();
//
//   // Add the captured stream to the WebRTC connection.
//   captureStream.getTracks().forEach((track) =>
//     peerConnection.addTrack(track, captureStream)
//   );
//
//   // Create and send the offer to the receiver.
//   const offer = await peerConnection.createOffer();
//   await peerConnection.setLocalDescription(offer);
//   const offerSDP = peerConnection.localDescription;
//
//   // Send to offer to the receiver.
//   const msg = {
//     event: "displayCaptureStream",
//     offer: "",
//   };
//   sourceWindow.postMessage("");
// }
