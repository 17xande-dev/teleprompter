// Deno has no DOM, so these tests exercise makeScrollSync against a small
// fake element rather than a real one. The fake models exactly the two
// browser behaviors the echo-suppression logic depends on: a native
// "scroll" event fires (asynchronously) both for a user scroll and for a
// programmatic scrollTo(), and requestAnimationFrame runs after that.
import { assertEquals } from "jsr:@std/assert";
import { makeScrollSync } from "./scrollsync.ts";

function installRAFPolyfill() {
  const raf = (cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0);
    return 0;
  };
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = raf;
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

Deno.test("converts scrollTop to a 0..1 ratio and coalesces to one send per frame", async () => {
  installRAFPolyfill();
  const sent: Array<{ r: number; s: number }> = [];
  const el = makeFakeElement({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }); // max scroll = 800
  makeScrollSync({ el: el as unknown as HTMLElement, send: (r, s) => sent.push({ r, s }) });

  el.fireUserScroll(400); // ratio 0.5
  el.fireUserScroll(600); // ratio 0.75 — should coalesce with the above into one send
  await flush();

  assertEquals(sent, [{ r: 0.75, s: 1 }]);
});

Deno.test("applyRemote suppresses the echo from its own scrollTo", async () => {
  installRAFPolyfill();
  const sent: Array<{ r: number; s: number }> = [];
  const el = makeFakeElement({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
  const sync = makeScrollSync({ el: el as unknown as HTMLElement, send: (r, s) => sent.push({ r, s }) });

  sync.applyRemote(0.5);
  await flush();

  assertEquals(el.scrollTop, 400);
  assertEquals(sent, [], "the scroll caused by applyRemote must not be reported back");
});

Deno.test("a real scroll after the echo-suppression window closes is reported normally", async () => {
  installRAFPolyfill();
  const sent: Array<{ r: number; s: number }> = [];
  const el = makeFakeElement({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
  const sync = makeScrollSync({ el: el as unknown as HTMLElement, send: (r, s) => sent.push({ r, s }) });

  sync.applyRemote(0.5);
  await flush();
  el.fireUserScroll(800); // ratio 1.0, a genuine local scroll
  await flush();

  assertEquals(sent, [{ r: 1, s: 1 }]);
});

Deno.test("send sequence numbers increase across separate frames", async () => {
  installRAFPolyfill();
  const sent: Array<{ r: number; s: number }> = [];
  const el = makeFakeElement({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
  makeScrollSync({ el: el as unknown as HTMLElement, send: (r, s) => sent.push({ r, s }) });

  el.fireUserScroll(100);
  await flush();
  el.fireUserScroll(200);
  await flush();

  assertEquals(sent.map((m) => m.s), [1, 2]);
});
