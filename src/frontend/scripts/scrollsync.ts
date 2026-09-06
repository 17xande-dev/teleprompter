// scrollsync.ts — keep a scrollable element in sync with a remote peer.
//
// Ported from ~/dev/webrtc-go, whose sync feels smooth precisely because it
// does the simple thing at a high rate rather than anything clever:
//   * Convert scrollTop to/from a 0..1 ratio, so windows of different sizes
//     (a phone, a 4K display, the control page's scaled-down preview) stay
//     aligned on the same line.
//   * Coalesce local scroll events to one send per animation frame (~60Hz)
//     instead of the 100+/sec the browser fires.
//   * Apply a remote position *instantly*. Smoothness comes from receiving
//     ~60 samples a second, not from interpolating between them — easing
//     here would only add lag.
//   * Suppress the echo: applying a remote position must not bounce back.
//
// Transport-agnostic: `send` is just a callback, so the same code runs over
// a WebRTC data channel or postMessage.

export interface ScrollSync {
  applyRemote(ratio: number): void;
  // Stops the per-frame pump. Only needed by tests and teardown; a page
  // that syncs for its whole lifetime never calls it.
  stop(): void;
}

export interface ScrollSyncOptions {
  el: Element;
  send: (ratio: number, seq: number) => void;
}

export function makeScrollSync({ el, send }: ScrollSyncOptions): ScrollSync {
  // Scroll events for the document's scrolling element are dispatched at
  // the window, not at the element itself.
  const isDocument = typeof document !== "undefined" &&
    el === document.scrollingElement;
  const target: EventTarget = isDocument ? globalThis : el;

  let seq = 0;
  let applyingRemote = false;
  let pending: number | null = null;
  let running = true;

  const maxScroll = () => Math.max(0, el.scrollHeight - el.clientHeight);
  const currentRatio = () => {
    const max = maxScroll();
    return max ? el.scrollTop / max : 0;
  };

  target.addEventListener("scroll", () => {
    if (applyingRemote) return; // don't re-broadcast a position we just applied
    pending = currentRatio();
  }, { passive: true });

  (function frame() {
    if (!running) return;
    if (pending !== null) {
      send(pending, ++seq);
      pending = null;
    }
    requestAnimationFrame(frame);
  })();

  return {
    applyRemote(ratio: number) {
      applyingRemote = true;
      el.scrollTo({ top: ratio * maxScroll(), behavior: "instant" });
      // Release after the resulting scroll event has been dispatched.
      requestAnimationFrame(() => {
        applyingRemote = false;
      });
    },
    stop() {
      running = false;
    },
  };
}
