import { assertEquals, assertNotEquals } from "@std/assert";

import { catchUpMessages, isPreviewScroll, isTextScale } from "./protocol.ts";

/** A plausible mid-service show, so each assertion can name what it expects. */
function show(over: Partial<Parameters<typeof catchUpMessages>[0]> = {}) {
  return {
    stage: { width: 1920, height: 1080 },
    theme: { type: "theme" as const, layout: "theme-user-abc", css: ".x{}" },
    speed: 120,
    textScale: 3.2,
    message: "two minutes",
    html: "<p>Line one</p>",
    clock: { running: true, remainingMs: 90_000 },
    ratio: 0.42,
    ...over,
  };
}

Deno.test("a joining display is told everything it needs, and nothing is dropped", () => {
  const types = catchUpMessages(show()).map((m) => m.type);
  // The whole point of the shared builder. A display that misses any one of
  // these comes back mid-service disagreeing with the others: unstyled, at the
  // wrong text size, blank, with a frozen countdown, or at the top of the
  // script. Each has happened.
  assertEquals(types, [
    "stage",
    "theme",
    "settings",
    "content",
    "clock",
    "scroll",
  ]);
});

Deno.test("the two height-changing messages arrive before the content", () => {
  const types = catchUpMessages(show()).map((m) => m.type);
  // setContent re-anchors the scroll position against the height it finds, so
  // a theme or text scale arriving afterwards would re-anchor it against a
  // height that is about to change.
  const content = types.indexOf("content");
  assertEquals(types.indexOf("stage") < content, true);
  assertEquals(types.indexOf("theme") < content, true);
  assertEquals(types.indexOf("settings") < content, true);
});

Deno.test("the show's own values travel, not defaults", () => {
  const msgs = catchUpMessages(show());
  assertEquals(msgs[0], { type: "stage", width: 1920, height: 1080 });
  assertEquals(msgs[1], {
    type: "theme",
    layout: "theme-user-abc",
    css: ".x{}",
  });
  assertEquals(msgs[2], {
    type: "settings",
    speed: 120,
    textScale: 3.2,
    message: "two minutes",
  });
  assertEquals(msgs[3], { type: "content", html: "<p>Line one</p>" });
  assertEquals(msgs[4], { type: "clock", running: true, remainingMs: 90_000 });
  assertEquals(msgs[5], { type: "scroll", r: 0.42, s: 0 });
});

Deno.test("speed is carried as given, so the wire's sign convention is the caller's", () => {
  // Forward is positive on the wire and negative on the slider; the negation
  // belongs at the one call site that reads the slider, not in here, or it
  // would be applied twice.
  const [, , settings] = catchUpMessages(show({ speed: -45 }));
  assertEquals(settings, {
    type: "settings",
    speed: -45,
    textScale: 3.2,
    message: "two minutes",
  });
});

Deno.test("a stopped countdown at zero is still sent, rather than being omitted as falsy", () => {
  const msgs = catchUpMessages(
    show({ clock: { running: false, remainingMs: 0 } }),
  );
  assertEquals(msgs[4], { type: "clock", running: false, remainingMs: 0 });
});

Deno.test("an empty script and an empty message are sent, not skipped", () => {
  // The first content of a session is the empty string, and a display left
  // showing a previous script because the empty one was treated as nothing to
  // send is worse than a blank one.
  const msgs = catchUpMessages(show({ html: "", message: "" }));
  assertEquals(msgs[2], {
    type: "settings",
    speed: 120,
    textScale: 3.2,
    message: "",
  });
  assertEquals(msgs[3], { type: "content", html: "" });
});

Deno.test("each call is a fresh list, so a caller cannot mutate the next display's", () => {
  const first = catchUpMessages(show());
  first.pop();
  assertNotEquals(catchUpMessages(show()).length, first.length);
  assertEquals(catchUpMessages(show()).length, 6);
});

Deno.test("isPreviewScroll accepts a real report and refuses everything else", () => {
  assertEquals(isPreviewScroll({ type: "preview-scroll", r: 0.5 }), true);
  assertEquals(isPreviewScroll({ type: "preview-scroll", r: 0 }), true);
  // postMessage carries `unknown`, and a malformed payload reaching sendScroll
  // as a `number` that isn't one is the failure this guard exists to stop.
  assertEquals(isPreviewScroll({ type: "preview-scroll", r: NaN }), false);
  assertEquals(isPreviewScroll({ type: "preview-scroll", r: Infinity }), false);
  assertEquals(isPreviewScroll({ type: "preview-scroll", r: "0.5" }), false);
  assertEquals(isPreviewScroll({ type: "preview-scroll" }), false);
  assertEquals(isPreviewScroll({ type: "pop-hello", r: 0.5 }), false);
  assertEquals(isPreviewScroll(null), false);
  assertEquals(isPreviewScroll(undefined), false);
  assertEquals(isPreviewScroll("preview-scroll"), false);
  assertEquals(isPreviewScroll(0.5), false);
});

Deno.test("isTextScale accepts a driver's request and refuses everything else", () => {
  assertEquals(isTextScale({ type: "text-scale", scale: 3.2 }), true);
  // Out of range is still well-formed; clamping is the controller's job and
  // this guard must not quietly become a second, disagreeing range check.
  assertEquals(isTextScale({ type: "text-scale", scale: 1e9 }), true);
  assertEquals(isTextScale({ type: "text-scale", scale: -1 }), true);
  // These are the ones that reach a font-size and make the script vanish.
  assertEquals(isTextScale({ type: "text-scale", scale: NaN }), false);
  assertEquals(isTextScale({ type: "text-scale", scale: Infinity }), false);
  assertEquals(isTextScale({ type: "text-scale", scale: "3.2" }), false);
  assertEquals(isTextScale({ type: "text-scale" }), false);
  assertEquals(isTextScale({ type: "dims", scale: 3.2 }), false);
  assertEquals(isTextScale(null), false);
  assertEquals(isTextScale(undefined), false);
  assertEquals(isTextScale(3.2), false);
});
