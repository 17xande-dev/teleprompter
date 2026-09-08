// Deno has no DOM, so these tests exercise makeScrollSync against a small
// fake element rather than a real one. The fake models the two browser
// behaviors the echo-suppression logic depends on: a native "scroll" event
// fires (asynchronously) both for a user scroll and for a programmatic
// scrollTo(), and requestAnimationFrame runs after that.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  carryRemainder,
  makeScrollSync,
  pendingScroll,
  ratioOf,
  scrollQuantum,
  type ScrollSync,
  setRatio,
} from "./scrollsync.ts";

function installRAFPolyfill() {
  const raf = (cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0);
    return 0;
  };
  (globalThis as unknown as { requestAnimationFrame: unknown })
    .requestAnimationFrame = raf;
}

function flush(): Promise<void> {
  // Long enough to clear both the fake's queueMicrotask scroll dispatch and
  // the setTimeout-based requestAnimationFrame polyfill above.
  return new Promise((resolve) => setTimeout(resolve, 10));
}

interface FakeElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  addEventListener(type: string, cb: () => void): void;
  scrollTo(opts: { top: number }): void;
  fireUserScroll(top: number): void;
}

function makeFakeElement(
  init: { scrollTop: number; scrollHeight: number; clientHeight: number },
): FakeElement {
  const listeners: Array<() => void> = [];
  const el: FakeElement = {
    ...init,
    addEventListener(_type, cb) {
      listeners.push(cb);
    },
    scrollTo(opts) {
      el.scrollTop = opts.top;
      // Real browsers dispatch "scroll" asynchronously after scrollTo();
      // a microtask fires before our setTimeout-based rAF polyfill does,
      // which is the ordering the echo-suppression guard relies on.
      queueMicrotask(() => listeners.forEach((cb) => cb()));
    },
    fireUserScroll(top) {
      el.scrollTop = top;
      listeners.forEach((cb) => cb());
    },
  };
  return el;
}

// Each test drives one sync over a fresh element. makeScrollSync runs a
// permanent per-frame pump, so it has to be stopped or Deno's sanitizer
// sees a timer still scheduled once the test returns.
async function withSync(
  el: FakeElement,
  body: (
    sync: ScrollSync,
    sent: Array<{ r: number; s: number }>,
  ) => Promise<void>,
) {
  installRAFPolyfill();
  const sent: Array<{ r: number; s: number }> = [];
  const sync = makeScrollSync({
    el: el as unknown as Element,
    send: (r, s) => sent.push({ r, s }),
  });
  try {
    await body(sync, sent);
  } finally {
    sync.stop();
    await flush();
  }
}

Deno.test("converts scrollTop to a 0..1 ratio and coalesces to one send per frame", async () => {
  // max scroll = 1000 - 200 = 800
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
  });
  await withSync(el, async (_sync, sent) => {
    el.fireUserScroll(400); // ratio 0.5
    el.fireUserScroll(600); // ratio 0.75 — coalesces with the above
    await flush();

    assertEquals(sent, [{ r: 0.75, s: 1 }]);
  });
});

Deno.test("applyRemote suppresses the echo from its own scrollTo", async () => {
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
  });
  await withSync(el, async (sync, sent) => {
    sync.applyRemote(0.5);
    await flush();

    assertEquals(el.scrollTop, 400);
    assertEquals(
      sent,
      [],
      "a position we applied ourselves must not be sent back",
    );
  });
});

Deno.test("a real scroll after the echo-suppression window closes is reported normally", async () => {
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
  });
  await withSync(el, async (sync, sent) => {
    sync.applyRemote(0.5);
    await flush();
    el.fireUserScroll(800); // ratio 1.0, a genuine local scroll
    await flush();

    assertEquals(sent, [{ r: 1, s: 1 }]);
  });
});

Deno.test("send sequence numbers increase across separate frames", async () => {
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
  });
  await withSync(el, async (_sync, sent) => {
    el.fireUserScroll(100);
    await flush();
    el.fireUserScroll(200);
    await flush();

    assertEquals(sent.map((m) => m.s), [1, 2]);
  });
});

Deno.test("a zero-height page reports ratio 0 rather than dividing by zero", async () => {
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 200,
    clientHeight: 200,
  });
  await withSync(el, async (_sync, sent) => {
    el.fireUserScroll(0);
    await flush();

    assertEquals(sent, [{ r: 0, s: 1 }]);
  });
});

Deno.test("re-applying a stored ratio re-anchors after the content changes height", async () => {
  // The mechanism behind viewer.ts's #restoreScroll. Replacing the content —
  // an edit, a PDF finishing its layout, a zoom — changes scrollHeight while
  // the browser keeps scrollTop in pixels, so the same position now means a
  // different line. While the pacer is moving its ~60Hz samples hide this;
  // paused, nothing else ever corrects it.
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
  });
  await withSync(el, async (sync) => {
    sync.applyRemote(0.5);
    assertEquals(el.scrollTop, 400); // half of (1000 - 200)
    await flush();

    // Content grows; scrollTop stays where it was and now means ratio 0.1.
    el.scrollHeight = 4200;
    assertEquals(el.scrollTop / (el.scrollHeight - el.clientHeight), 0.1);

    sync.applyRemote(0.5);
    assertEquals(el.scrollTop, 2000); // half of (4200 - 200)
  });
});

// ratioOf/setRatio are exported because the control page moves its own panes
// by an explicit action rather than by syncing — it needs the ratio maths
// without makeScrollSync's per-frame pump and scroll listener. pdfview.ts had
// grown its own private copy of both before they were shared.

Deno.test("a ratio is the fraction of the scrollable range, not of the height", () => {
  // 1000 tall in a 400 box leaves 600 scrollable, so 150 down is a quarter.
  const el = makeFakeElement({
    scrollTop: 150,
    scrollHeight: 1000,
    clientHeight: 400,
  });
  assertEquals(ratioOf(el as unknown as Element), 0.25);
});

Deno.test("an element with nothing to scroll sits at 0 rather than dividing by zero", () => {
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 400,
  });
  assertEquals(ratioOf(el as unknown as Element), 0);
  // And moving it is a no-op that leaves a number, not a NaN, behind.
  setRatio(el as unknown as Element, 0.5);
  assertEquals(el.scrollTop, 0);
});

Deno.test("the ends of the range are exactly 0 and 1", () => {
  const el = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
  });
  setRatio(el as unknown as Element, 1);
  // The bottom is scrollHeight - clientHeight, never scrollHeight.
  assertEquals(el.scrollTop, 600);
  assertEquals(ratioOf(el as unknown as Element), 1);
  setRatio(el as unknown as Element, 0);
  assertEquals(el.scrollTop, 0);
});

Deno.test("a ratio survives a round trip through a differently sized element", () => {
  // The point of ratios: the same position in a document that is a different
  // number of pixels tall on another screen.
  const tall = makeFakeElement({
    scrollTop: 900,
    scrollHeight: 3000,
    clientHeight: 500,
  });
  const short = makeFakeElement({
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 300,
  });
  setRatio(short as unknown as Element, ratioOf(tall as unknown as Element));
  assertEquals(
    ratioOf(short as unknown as Element),
    ratioOf(tall as unknown as Element),
  );
  assertEquals(short.scrollTop, 324); // 0.36 of 900
});

// The carry. Pure arithmetic, so no fake element and no rAF — but it is where
// the two reasons a viewport moves less than asked have to be told apart, and
// getting that wrong pinned a viewer to one end of its script.

Deno.test("sub-pixel movement is carried instead of being rounded away", () => {
  // At a slow speed a frame asks for a fraction of a pixel and the viewport
  // moves nothing. Dropping that outright means slow speeds never move at all.
  assertEquals(carryRemainder(0.3, 0, 1), 0.3);
  assertAlmostEquals(carryRemainder(1.3, 1, 1), 0.3);
  assertEquals(carryRemainder(1, 1, 1), 0);
});

Deno.test("movement the viewport refused is dropped, not banked", () => {
  // The regression. Held against the end of a document, a frame asks for a
  // whole pixel or more and moves nothing — and that movement is never going
  // to happen. Banking it built a debt of up to a screen height which the
  // viewer then re-applied every frame *after* the speed was back at zero, so
  // any position sent to it was undone on the next frame and "Send my
  // position" silently did nothing.
  assertEquals(carryRemainder(-500, 0, 1), -1);
  assertEquals(carryRemainder(500, 0, 1), 1);
  // Partly consumed at the end of the document: the rest is refusal too.
  assertEquals(carryRemainder(-500, -20, 1), -1);
});

Deno.test("the carry never exceeds one quantum in either direction", () => {
  // What makes the debt self-limiting rather than merely bounded: at most one
  // quantum survives a frame, so the next frame spends it and it is gone.
  for (const wanted of [-1e6, -3, -1.5, 0, 1.5, 3, 1e6]) {
    const carry = carryRemainder(wanted, 0, 1);
    assertEquals(Math.abs(carry) <= 1, true, `${wanted} carried ${carry}`);
  }
});

Deno.test("the quantum never drops below a CSS pixel, but grows past one", () => {
  // A dense display's grid is finer than a CSS pixel, so there is less to
  // carry — but the cap stays at one whole CSS pixel there, as slack for a
  // browser that quantises to CSS pixels regardless. Below 1x the grid really
  // is coarser, and then the cap has to grow with it or a slow scroll on a
  // zoomed-out page would never accumulate enough to move.
  const dpr = (value: number) => {
    (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio =
      value;
    return scrollQuantum();
  };
  assertEquals(dpr(3), 1);
  assertEquals(dpr(2), 1);
  assertEquals(dpr(1), 1);
  assertEquals(dpr(0.5), 2);
  assertEquals(dpr(0.25), 4);
  // Absent, as in Deno, it must not produce NaN or Infinity.
  delete (globalThis as unknown as { devicePixelRatio?: number })
    .devicePixelRatio;
  assertEquals(scrollQuantum(), 1);
});

Deno.test("the quantum is the default, so callers need not know it", () => {
  // viewer.ts and gamepadControls.ts both call this with two arguments; a
  // default that computed to NaN would silently poison every accumulator.
  const carry = carryRemainder(0.25, 0);
  assertEquals(Number.isFinite(carry), true);
  assertEquals(carry, 0.25);
});

Deno.test("a stopped viewer asks for nothing, whatever it was owed", () => {
  // The iOS creep: WebKit performs a sub-pixel scrollBy and then reports that
  // it moved 0, so carryRemainder re-banks the whole remainder every frame. At
  // speed 0 that debt has nothing to drain it — measured at 0.84px a frame,
  // about 50px/s, on a viewer whose speed the operator had just zeroed.
  assertEquals(pendingScroll(0, 16, 0.84), 0);
  assertEquals(pendingScroll(0, 16, -0.84), 0);
  assertEquals(pendingScroll(0, 0, 0), 0);
});

Deno.test("a moving viewer still carries its sub-pixel remainder", () => {
  // The other half of the rule: at 6px/s a frame asks for a tenth of a pixel,
  // which moves nothing, and dropping that outright means slow speeds never
  // move at all.
  assertEquals(pendingScroll(6, 16, 0), 0.096);
  assertAlmostEquals(pendingScroll(6, 16, 0.096), 0.192, 1e-12);
  // Reverse is symmetric, and the carry is signed.
  assertEquals(pendingScroll(-6, 16, 0), -0.096);
  // A frame that took no time asks only for what was already owed.
  assertEquals(pendingScroll(60, 0, 0.5), 0.5);
});
