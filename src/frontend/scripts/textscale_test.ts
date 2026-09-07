// No DOM and no fakes: the whole point of splitting textscale.ts out of
// teleprompter.ts is that the arithmetic behind "make these two read the same"
// can be checked without a browser.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  clampTextScale,
  matchedEditorFontPx,
  matchedViewerTextScale,
  pxToTenths,
  REM_PX,
  tenthsToRem,
  viewerFontPx,
} from "./textscale.ts";

Deno.test("a textScale is a rem length, so 3 is 48px", () => {
  assertEquals(viewerFontPx(3), 48);
  assertEquals(viewerFontPx(1), REM_PX);
});

Deno.test("matching narrows the font in proportion to the narrower pane", () => {
  // The editor is three quarters the width, so it gets three quarters the
  // font — that is what keeps characters per line equal.
  assertEquals(matchedEditorFontPx(3, 1440, 1920), 36);
  assertEquals(matchedEditorFontPx(3, 960, 1920), 24);
});

Deno.test("equal widths mean the editor simply matches the viewer's pixels", () => {
  assertEquals(matchedEditorFontPx(3, 1920, 1920), viewerFontPx(3));
});

Deno.test("a wider pane than the viewer scales the font up, not down", () => {
  // Nothing about the maths assumes the editor is the smaller of the two.
  assertEquals(matchedEditorFontPx(2, 2560, 1280), 64);
});

Deno.test("the two directions are inverses of each other", () => {
  const editorWidth = 1395;
  const viewerWidth = 1896;
  for (const scale of [0.5, 1, 3, 7.5]) {
    const px = matchedEditorFontPx(scale, editorWidth, viewerWidth);
    assertAlmostEquals(
      matchedViewerTextScale(px, editorWidth, viewerWidth),
      scale,
      1e-9,
    );
  }
});

Deno.test("pushing the editor's own size outwards widens it for a wider viewer", () => {
  // 32px in a 1440 pane is the same reading size as 4rem on a 1920 screen.
  assertEquals(matchedViewerTextScale(32, 1440, 1920), 8 / 3);
});

Deno.test("a width that isn't known yet leaves the size alone", () => {
  // A viewer that hasn't reported its dimensions, or a pane measured before
  // layout: 0 rather than Infinity or NaN, so the caller can skip the change
  // instead of collapsing the text to nothing.
  assertEquals(matchedEditorFontPx(3, 1440, 0), 0);
  assertEquals(matchedEditorFontPx(3, 0, 1920), 0);
  assertEquals(matchedViewerTextScale(32, 0, 1920), 0);
  assertEquals(matchedViewerTextScale(32, 1440, 0), 0);
  assert(!Number.isNaN(matchedEditorFontPx(3, NaN, 1920)));
});

Deno.test("a computed scale is clamped to a position the slider can hold", () => {
  // The slider runs 1..100 in tenths, so 0.1..10 on the wire. An enormous
  // editor font in a narrow pane can compute past that.
  assertEquals(clampTextScale(40), 10);
  assertEquals(clampTextScale(0.01), 0.1);
  assertEquals(clampTextScale(3), 3);
});

Deno.test("the editor slider counts in tenths of a rem, like the viewers' one", () => {
  assertEquals(tenthsToRem(20), 2);
  assertEquals(pxToTenths(32), 20);
  assertEquals(pxToTenths(REM_PX), 10);
});

Deno.test("a slider position round-trips through pixels", () => {
  for (const tenths of [5, 11, 20, 47, 80]) {
    assertEquals(pxToTenths(tenthsToRem(tenths) * REM_PX), tenths);
  }
});

Deno.test("a matched font size lands on a position the slider has", () => {
  // What "Match viewers' text size" now does: a px size from the widths, then
  // the slider position that stands for it. step="1", so it must be an integer.
  const px = matchedEditorFontPx(3, 1395, 1896);
  const tenths = pxToTenths(px);
  assertEquals(tenths, Math.trunc(tenths));
  // And it is still the same reading size, to within the slider's own grid.
  assertAlmostEquals(tenthsToRem(tenths) * REM_PX, px, REM_PX / 20);
});
