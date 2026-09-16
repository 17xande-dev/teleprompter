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

/**
 * The most a viewport can plausibly round away in one step, in CSS pixels.
 *
 * Scroll offsets are quantised to the physical pixel grid, so a fraction of a
 * pixel moves nothing and has to be carried. On a dense display that grid is
 * *finer* than a CSS pixel and there is less to carry — but this stays at one
 * whole CSS pixel there rather than going below it, as slack for a browser
 * that quantises to CSS pixels regardless. Below 1x the grid really is coarser
 * than a CSS pixel, and then the quantum has to grow with it.
 */
export function scrollQuantum(): number {
  return Math.max(1, 1 / (globalThis.devicePixelRatio || 1));
}

/**
 * What to carry forward when a viewport moved less than it was asked to.
 *
 * Continuous scrolling has to accumulate: at 30px/s a frame asks for half a
 * pixel, which moves nothing, and dropping that outright means slow speeds
 * never move at all. So the shortfall is carried into the next frame.
 *
 * **But only ever a sub-pixel shortfall.** There are two reasons a viewport
 * moves less than asked, and they need opposite treatment: quantising to the
 * device pixel grid (carry it — it will be spent next frame) and running out
 * of document (drop it — that movement is never going to happen). Banking the
 * second is what used to pin a viewer to the top of its script: holding
 * reverse against the top built a debt of up to a screen height, and since a
 * blocked frame consumes none of it, the viewer went on asking to scroll by
 * that debt every frame *after the speed was back at zero* — undoing any
 * position sent to it on the very next frame, so "Send my position" silently
 * did nothing until the debt happened to clear.
 */
export function carryRemainder(
  wanted: number,
  moved: number,
  quantum = scrollQuantum(),
): number {
  return Math.max(-quantum, Math.min(quantum, wanted - moved));
}

/**
 * How far to ask the viewport to move this frame, carry included.
 *
 * **A stopped viewer asks for nothing at all**, remainder or no remainder.
 * That is not an optimisation: `carryRemainder` decides what to bank by
 * comparing what was asked with what `scrollY` reports back, and WebKit
 * reports back a *whole* pixel — an iPhone asked to scroll by 0.84px does move,
 * and then says it moved 0. So the carry is re-banked in full every frame and,
 * once the speed reaches zero, never drains: measured on iOS 18.7, a viewer at
 * speed 0 went on creeping at 0.84px a frame, about 50px/s, and no amount of
 * zeroing the speed stopped it. Under a pixel of owed movement is nothing to
 * defend; a display that ignores "stop" is.
 *
 * Kept here rather than in viewer.ts's frame loop because this and
 * `carryRemainder` are two halves of one rule about a debt that must not
 * outlive its reason, and only one of the two was testable.
 */
export function pendingScroll(
  speed: number,
  elapsedMs: number,
  carried: number,
): number {
  if (speed === 0) return 0;
  return carried + (speed / 1000) * elapsedMs;
}

/**
 * How much of an unspent scrub gesture to spend this frame.
 *
 * A wheel notch over the preview arrives as one large `deltaY`, and forwarding
 * it whole moves every display in one jump. Spending a fraction of what is left
 * each frame turns that into a glide: the step shrinks as the debt does, which
 * is an ease-out, and it settles in about ten frames at the default fraction.
 *
 * **This is not the easing the sync path forbids, and the difference is which
 * end of the wire it is on.** The rule above — never throttle or interpolate
 * the fan-out — is about the pacer's ~60Hz samples, which describe where a
 * display *is* and must be applied the instant they land. This is about a
 * gesture, on the control page, before anything has been sent: it turns one
 * coarse sample into a stream of fine ones, so viewers receive *more*
 * positions, not fewer, and each is still applied immediately. Easing the
 * fan-out adds lag to someone else's motion; easing a gesture adds
 * intermediate frames to your own.
 *
 * Two floors, both earned. Under a pixel of debt is spent outright rather than
 * chased across more frames — the tail of an exponential never reaches zero,
 * and a frame loop kept alive to move a hundredth of a pixel is a loop that
 * also keeps refreshing the scrub's authority over the position (see
 * SCRUB_HOLD_MS). And a step is never smaller than a whole pixel, or the last
 * fifth of a long fling crawls for another forty frames after the motion has
 * visibly stopped.
 */
export const SCRUB_EASE = 0.11;

/**
 * The most a scrub may move in one frame, in the reference display's pixels.
 *
 * A fraction of the debt alone is not enough: spin a chunky wheel and several
 * hundred pixels of debt arrive within a few frames, and 11% of *that* is a
 * visible jump — the exact thing the easing exists to remove. 80px a frame is
 * about 4800px/s, fast enough that a long scrub does not crawl and slow enough
 * that a single frame is a tenth of a 800-tall screen rather than a teleport.
 *
 * It only bites on a fling. A single notch never reaches it, so ordinary
 * scrolling is governed by the fraction above and feels the same as before.
 */
export const SCRUB_MAX_STEP = 80;

export function scrubStep(
  debt: number,
  fraction = SCRUB_EASE,
  maxStep = SCRUB_MAX_STEP,
): number {
  if (!Number.isFinite(debt) || debt === 0) return 0;
  if (Math.abs(debt) <= 1) return debt;
  const eased = debt * fraction;
  const capped = Math.sign(debt) * Math.min(Math.abs(eased), maxStep);
  return Math.abs(capped) < 1 ? Math.sign(debt) : capped;
}

/**
 * A wheel event's delta in pixels, whatever unit the browser chose to send.
 *
 * `deltaY` is only pixels when `deltaMode` says so, and browsers disagree: on
 * Windows, Chrome reports pixels (about 100 per notch) while Firefox reports
 * *lines* — `deltaY: 3` for one notch. Read as pixels, that notch moves the
 * show three pixels, so the scrub silently does almost nothing on one browser
 * and works on another. Nothing errors; it just feels broken.
 *
 * A line is normalised to a constant rather than to the script's own line
 * height, deliberately. The script's line height changes with the Text Scale
 * slider, so tying a notch to it would make the same gesture travel a different
 * distance at every venue — and the operator's muscle memory is in notches.
 * 40px is chosen to land a three-line notch near the ~120px Chrome sends, so
 * the gesture feels the same in both browsers.
 */
export const WHEEL_LINE_PIXELS = 40;

export function wheelPixels(
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
  linePixels = WHEEL_LINE_PIXELS,
): number {
  if (!Number.isFinite(deltaY)) return 0;
  // DOM_DELTA_LINE
  if (deltaMode === 1) return deltaY * linePixels;
  // DOM_DELTA_PAGE — a notch means a screenful, so it is worth honouring
  // rather than clamping: it is what the operator asked for.
  if (deltaMode === 2) {
    return deltaY *
      (Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : linePixels);
  }
  // DOM_DELTA_PIXEL, and anything a future browser invents: taking it at face
  // value is the conservative answer.
  return deltaY;
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
