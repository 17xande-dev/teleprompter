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

/**
 * How far down its scrollable range an element sits, 0..1.
 *
 * A ratio rather than a pixel offset is the whole basis of the sync: viewers
 * are different sizes and the same document is a different number of pixels
 * tall on each. Recomputed from scratch every time, never cached — a PDF
 * relayout or a font change moves the denominator.
 *
 * 0 when nothing overflows, which is also what stops the division by zero.
 */
export function ratioOf(el: Element): number {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  return max ? el.scrollTop / max : 0;
}

/** Put an element at a ratio of its scrollable range. */
export function setRatio(el: Element, ratio: number) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  // Instant, never smooth: a smooth scroll would still be animating when the
  // next sample arrives, so the far end would lag further behind with every
  // update instead of tracking.
  el.scrollTo({ top: ratio * max, behavior: "instant" });
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

  target.addEventListener("scroll", () => {
    if (applyingRemote) return; // don't re-broadcast a position we just applied
    pending = ratioOf(el);
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
      setRatio(el, ratio);
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
