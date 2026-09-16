import { assertEquals } from "@std/assert";

import {
  clampMultiplier,
  cssFontSize,
  formatMultiplier,
  parseFontSize,
  SECTION_SIZE_DEFAULT,
  SECTION_SIZE_MAX,
  SECTION_SIZE_MIN,
  SECTION_SIZES,
} from "./sectionsize.ts";

Deno.test("a section's size is relative, never an absolute length", () => {
  // The hard constraint of the whole feature, asserted rather than assumed: an
  // absolute unit here would override the Text Scale slider, so a section
  // would stop responding to the one control the operator changes per venue.
  for (const m of SECTION_SIZES) {
    const css = cssFontSize(m);
    if (css === null) continue;
    assertEquals(/^[\d.]+em$/.test(css), true, `${m} rendered as ${css}`);
  }
  assertEquals(cssFontSize(1.5), "1.5em");
  assertEquals(cssFontSize(0.75), "0.75em");
  assertEquals(cssFontSize(2), "2em");
});

Deno.test("the default size emits no declaration at all", () => {
  // Wordgard drops a null attribute value, so a run at the default size
  // serialises as bare text instead of a span wrapping a line to say nothing —
  // and the published HTML goes out whole on every keystroke.
  assertEquals(cssFontSize(SECTION_SIZE_DEFAULT), null);
  assertEquals(cssFontSize(1), null);
});

Deno.test("a size that cannot be rendered cannot make the script vanish", () => {
  // A NaN reaching a custom property or a font-size computes 0, and the
  // section disappears with nothing in any console — the same failure
  // clampEditorScale exists to stop.
  assertEquals(clampMultiplier(NaN), SECTION_SIZE_DEFAULT);
  assertEquals(clampMultiplier(Infinity), SECTION_SIZE_DEFAULT);
  assertEquals(clampMultiplier(-Infinity), SECTION_SIZE_DEFAULT);
  assertEquals(cssFontSize(NaN), null);
  // And an absurd one lands on the bound rather than being sent as-is.
  assertEquals(clampMultiplier(0), SECTION_SIZE_MIN);
  assertEquals(clampMultiplier(-1), SECTION_SIZE_MIN);
  assertEquals(clampMultiplier(1e6), SECTION_SIZE_MAX);
  assertEquals(cssFontSize(1e6), `${SECTION_SIZE_MAX}em`);
});

Deno.test("a size survives being written out and read back", () => {
  // The renderer and the parse rule agreeing is what keeps a reloaded document
  // — and a copy-paste within the editor — at the sizes the operator set.
  for (const m of SECTION_SIZES) {
    if (m === SECTION_SIZE_DEFAULT) continue;
    assertEquals(parseFontSize(cssFontSize(m)!), m, `round trip of ${m}`);
  }
});

Deno.test("an absolute size from a pasted document is refused, not honoured", () => {
  // Word and Docs emit pt and px. Accepting them would pin a section to a size
  // the Text Scale slider can no longer move, so they are dropped and the text
  // inherits the script's size instead.
  for (const css of ["24px", "14pt", "2rem", "18Q", "1.5cm", "12"]) {
    assertEquals(parseFontSize(css), null, css);
  }
  // Keywords and anything else unreadable, likewise — never a guess.
  for (const css of ["larger", "smaller", "inherit", "initial", "medium", ""]) {
    assertEquals(parseFontSize(css), null, css);
  }
  assertEquals(parseFontSize("var(--textScale)"), null);
  assertEquals(parseFontSize("calc(1em * 2)"), null);
});

Deno.test("a percentage means the same thing as em", () => {
  // Some sources emit one for the identical intent, and both are relative to
  // the parent, so there is nothing to lose by accepting it.
  assertEquals(parseFontSize("150%"), 1.5);
  assertEquals(parseFontSize("100%"), 1);
  assertEquals(parseFontSize("75%"), 0.75);
});

Deno.test("whitespace and case in a style attribute do not defeat the parse", () => {
  // These come off real markup, where the value has been through a CSS
  // serialiser or somebody's hand.
  assertEquals(parseFontSize("  1.5em  "), 1.5);
  assertEquals(parseFontSize("1.5EM"), 1.5);
  assertEquals(parseFontSize("1.5 em"), 1.5);
  assertEquals(parseFontSize(".75em"), 0.75);
});

Deno.test("a parsed size is clamped, so the document cannot carry an unusable one", () => {
  assertEquals(parseFontSize("99em"), SECTION_SIZE_MAX);
  assertEquals(parseFontSize("0.01em"), SECTION_SIZE_MIN);
  // Zero and negatives are not sizes at all.
  assertEquals(parseFontSize("0em"), null);
  assertEquals(parseFontSize("0%"), null);
  assertEquals(parseFontSize("-2em"), null);
});

Deno.test("every offered size has its own label", () => {
  // The submenu labels itself from whichever item is active, so two sizes
  // sharing a label would leave the operator unable to tell what is set.
  const labels = SECTION_SIZES.map(formatMultiplier);
  assertEquals(new Set(labels).size, labels.length);
  assertEquals(labels, ["75%", "100%", "125%", "150%", "200%"]);
});

Deno.test("the offered sizes are all within the bounds they are clamped to", () => {
  // Otherwise the toolbar would offer a size that silently became another one.
  for (const m of SECTION_SIZES) {
    assertEquals(clampMultiplier(m), m, `${m} is outside the bounds`);
  }
});
