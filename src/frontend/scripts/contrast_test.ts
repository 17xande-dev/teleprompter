import { assertAlmostEquals, assertEquals } from "@std/assert";

import {
  ACHROMATIC_CHROMA,
  adaptBackgroundColor,
  brightenTextColor,
  type ColorVerdict,
  contrastOnBlack,
  formatCssColor,
  MAX_BACKGROUND_LUMINANCE,
  MIN_TEXT_LUMINANCE,
  oklchToSrgb,
  parseCssColor,
  relativeLuminance,
  srgbToOklch,
} from "./contrast.ts";

function value(v: ColorVerdict): string {
  return v.kind === "replace" ? v.value : v.kind;
}

Deno.test("the colour forms that turn up in pasted markup are all read", () => {
  // 1 and 2 are what CSSOM hands the walk; the rest are what hand-written
  // markup and older sources contain.
  assertEquals(parseCssColor("rgb(255, 0, 0)"), { r: 255, g: 0, b: 0, a: 1 });
  assertEquals(parseCssColor("rgba(255, 0, 0, 0.5)"), {
    r: 255,
    g: 0,
    b: 0,
    a: 0.5,
  });
  assertEquals(parseCssColor("rgb(255 0 0)"), { r: 255, g: 0, b: 0, a: 1 });
  assertEquals(parseCssColor("rgb(255 0 0 / 0.5)"), {
    r: 255,
    g: 0,
    b: 0,
    a: 0.5,
  });
  assertEquals(parseCssColor("rgb(100%, 0%, 0%)"), {
    r: 255,
    g: 0,
    b: 0,
    a: 1,
  });
  assertEquals(parseCssColor("#f00"), { r: 255, g: 0, b: 0, a: 1 });
  assertEquals(parseCssColor("#ff0000"), { r: 255, g: 0, b: 0, a: 1 });
  assertEquals(parseCssColor("#ff000080")?.r, 255);
  assertAlmostEquals(parseCssColor("#ff000080")!.a, 0.502, 0.002);
  assertEquals(parseCssColor("hsl(0, 100%, 50%)"), {
    r: 255,
    g: 0,
    b: 0,
    a: 1,
  });
  assertEquals(parseCssColor("hsl(0deg 100% 50%)"), {
    r: 255,
    g: 0,
    b: 0,
    a: 1,
  });
  // Case and surrounding whitespace, since the value has been through a
  // serialiser or somebody's hand.
  assertEquals(parseCssColor("  RED "), { r: 255, g: 0, b: 0, a: 1 });
  assertEquals(parseCssColor("BLACK"), { r: 0, g: 0, b: 0, a: 1 });
});

Deno.test("a colour we do not understand is left exactly as authored", () => {
  // The most important guarantee in this module: never guess. Every one of
  // these has to come back as a "keep" end to end, not as a best effort.
  const unknown = [
    "windowtext", // Word's black. Already handled: not valid CSS, so the
    // browser drops the declaration and the text arrives unstyled.
    "currentColor",
    "inherit",
    "initial",
    "unset",
    "revert",
    "medium",
    "var(--viewer-color)",
    "color(display-p3 1 0 0)",
    "lab(50% 40 30)",
    "oklch(0.6 0.2 30)",
    "color-mix(in srgb, red, blue)",
    "",
    "   ",
    "#12345",
    "#gggggg",
    "rgb(1, 2)",
    "rgb()",
    "not-a-colour",
  ];
  for (const css of unknown) {
    assertEquals(parseCssColor(css), null, css);
    assertEquals(brightenTextColor(css).kind, "keep", css);
    assertEquals(adaptBackgroundColor(css).kind, "keep", css);
  }
});

Deno.test("relative luminance matches the values the thresholds were chosen from", () => {
  assertEquals(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
  assertEquals(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }), 1);
  // Pins the sRGB linearisation: a wrong gamma shows up here first.
  assertAlmostEquals(
    relativeLuminance({ r: 128, g: 128, b: 128, a: 1 }),
    0.2159,
    1e-4,
  );
  assertAlmostEquals(
    relativeLuminance({ r: 255, g: 0, b: 0, a: 1 }),
    0.2126,
    1e-4,
  );
  // And the threshold is exactly WCAG AA against black, which is where 0.175
  // comes from rather than taste.
  assertAlmostEquals(
    contrastOnBlack({ r: 0, g: 0, b: 0, a: 1 }),
    1,
    1e-9,
  );
  assertAlmostEquals(MIN_TEXT_LUMINANCE, 4.5 * 0.05 - 0.05, 1e-9);
});

Deno.test("black text becomes the display's own ink, rather than a hard-coded white", () => {
  // Dropping is what makes a user theme's amber ink apply to a pasted script.
  // Replacing with white here would quietly defeat the palette.
  for (const css of ["black", "#000", "rgb(0, 0, 0)", "#333333", "#555555"]) {
    assertEquals(brightenTextColor(css).kind, "drop", css);
  }
});

Deno.test("a deliberate mid-grey survives, and near-white is handed back to the theme", () => {
  // A grey stage direction reads fine already and means something.
  assertEquals(brightenTextColor("#808080").kind, "keep");
  assertEquals(brightenTextColor("#999999").kind, "keep");
  // Near-white was almost certainly somebody's "white text" for a dark theme,
  // so inheriting is what makes it right on an amber screen too.
  assertEquals(brightenTextColor("#eeeeee").kind, "drop");
  assertEquals(brightenTextColor("white").kind, "drop");
});

Deno.test("a colour that already reads on black is not touched", () => {
  for (const css of ["#ff0000", "#ffff00", "#ffa500", "#00b050"]) {
    assertEquals(brightenTextColor(css).kind, "keep", css);
  }
});

Deno.test("a dark hue is lifted, and the hue is what survives", () => {
  // The measured table. Pinned exactly so a change in the gamut mapper or the
  // search is a failing test rather than a silently different palette.
  assertEquals(value(brightenTextColor("#8b0000")), "#ce4f40");
  assertEquals(value(brightenTextColor("#006400")), "#368a32");
  assertEquals(value(brightenTextColor("#0000ff")), "#336eff");
  assertEquals(value(brightenTextColor("#000080")), "#4072e9");
  assertEquals(value(brightenTextColor("#800080")), "#bb4bb9");
  // The two that actually arrive: Google Docs red and blue, Word blue.
  assertEquals(value(brightenTextColor("#cc0000")), "#e63024");
  assertEquals(value(brightenTextColor("#1155cc")), "#3073ed");
  assertEquals(value(brightenTextColor("#0563c1")), "#2679d8");
});

Deno.test("pure blue is lifted even though it is not perceptually dark", () => {
  // The case that justifies deciding in luminance rather than OkLab lightness:
  // #0000ff is 2.44:1 on black — a smudge at the back of a hall — while its
  // OkLab lightness is 0.452, above any sane grey threshold. A
  // lightness-only rule would leave it exactly as unreadable as it found it.
  const lch = srgbToOklch(parseCssColor("#0000ff")!);
  assertAlmostEquals(lch.l, 0.452, 0.01);
  assertAlmostEquals(contrastOnBlack(parseCssColor("#0000ff")!), 2.44, 0.01);
  assertEquals(brightenTextColor("#0000ff").kind, "replace");
});

Deno.test("hue is preserved through a lift, so red stays red", () => {
  for (const css of ["#8b0000", "#006400", "#0000ff", "#800080", "#1f3864"]) {
    const before = srgbToOklch(parseCssColor(css)!);
    const after = srgbToOklch(parseCssColor(value(brightenTextColor(css)))!);
    const shift = Math.abs(after.h - before.h) * 180 / Math.PI;
    // Measured: every one of these moves by under a third of a degree. The
    // budget is 3, which is still far below anything nameable.
    assertEquals(shift < 3, true, `${css} moved ${shift.toFixed(2)}deg`);
  }
});

Deno.test("alpha survives a lift", () => {
  const v = brightenTextColor("rgba(139, 0, 0, 0.5)");
  assertEquals(v.kind, "replace");
  assertAlmostEquals(parseCssColor(value(v))!.a, 0.5, 0.01);
});

Deno.test("a fully transparent colour is left alone", () => {
  // Google Docs emits background-color: transparent on nearly every span, and
  // it is invisible either way.
  assertEquals(brightenTextColor("transparent").kind, "keep");
  assertEquals(adaptBackgroundColor("transparent").kind, "keep");
  assertEquals(adaptBackgroundColor("rgba(255, 255, 255, 0)").kind, "keep");
});

Deno.test("a light page background goes, and a highlight is darkened instead", () => {
  // A white page box carries no meaning on a screen that is already black.
  for (const css of ["#ffffff", "#f3f3f3", "#cccccc"]) {
    assertEquals(adaptBackgroundColor(css).kind, "drop", css);
  }
  // A background that is already dark is kept rather than dropped, including
  // black — it is a no-op on a black page, and testing darkness before
  // greyness is what makes this function idempotent. See adaptBackgroundColor.
  assertEquals(adaptBackgroundColor("#000000").kind, "keep");
  assertEquals(adaptBackgroundColor("#111111").kind, "keep");
  // A highlight does: keeping the hue keeps "this bit is highlighted, in
  // yellow", and darkening it is what lets the foreground rule stay ignorant
  // of the background — the alternative is white text on yellow.
  assertEquals(value(adaptBackgroundColor("#ffff00")), "#303000");
  assertEquals(value(adaptBackgroundColor("#ffc000")), "#3c2b00");
  assertEquals(value(adaptBackgroundColor("#ffe599")), "#392c00");
  assertEquals(value(adaptBackgroundColor("#d9ead3")), "#253220");
  assertEquals(value(adaptBackgroundColor("#c9daf8")), "#212e45");
});

Deno.test("a darkened highlight is dark enough to read white text on", () => {
  for (const css of ["#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ffe599"]) {
    const out = parseCssColor(value(adaptBackgroundColor(css)))!;
    assertEquals(
      relativeLuminance(out) <= MAX_BACKGROUND_LUMINANCE,
      true,
      `${css} -> ${formatCssColor(out)}`,
    );
  }
});

Deno.test("running the transform twice changes nothing the second time", () => {
  // The guard against drift. Pasting twice, or pasting content that has
  // already been through this, must not walk a colour up in steps — which is
  // what the hysteresis between the target and the threshold is for.
  let checked = 0;
  for (let r = 0; r < 16; r++) {
    for (let g = 0; g < 16; g++) {
      for (let b = 0; b < 16; b++) {
        const css = `#${r.toString(16)}${g.toString(16)}${b.toString(16)}`;
        const text = brightenTextColor(css);
        if (text.kind === "replace") {
          assertEquals(brightenTextColor(text.value).kind, "keep", css);
          assertEquals(
            relativeLuminance(parseCssColor(text.value)!) >=
              MIN_TEXT_LUMINANCE,
            true,
            `${css} -> ${text.value}`,
          );
          checked++;
        }
        const bg = adaptBackgroundColor(css);
        if (bg.kind === "replace") {
          assertEquals(adaptBackgroundColor(bg.value).kind, "keep", css);
        }
      }
    }
  }
  // Make sure the sweep actually exercised the replace branch rather than
  // passing because nothing was replaced.
  assertEquals(checked > 500, true, `only ${checked} colours were lifted`);
});

Deno.test("every colour this module emits can be read back", () => {
  // An invalid value assigned through CSSOM is silently ignored, so a
  // malformed string here would look like "the setting did nothing".
  for (let r = 0; r < 16; r++) {
    for (let g = 0; g < 16; g++) {
      const css = `#${r.toString(16)}${g.toString(16)}8`;
      for (const v of [brightenTextColor(css), adaptBackgroundColor(css)]) {
        if (v.kind !== "replace") continue;
        assertEquals(/^#[0-9a-f]{6}$|^rgba\(/.test(v.value), true, v.value);
        assertEquals(parseCssColor(v.value) !== null, true, v.value);
      }
    }
  }
});

Deno.test("an achromatic colour really is treated as one", () => {
  // The branch that decides "drop" rather than "keep the hue" hangs off this,
  // so it is worth knowing greys land under the threshold and colours do not.
  for (const css of ["#000000", "#808080", "#ffffff", "#333333"]) {
    assertEquals(
      srgbToOklch(parseCssColor(css)!).c < ACHROMATIC_CHROMA,
      true,
      css,
    );
  }
  for (const css of ["#8b0000", "#006400", "#1f3864"]) {
    assertEquals(
      srgbToOklch(parseCssColor(css)!).c >= ACHROMATIC_CHROMA,
      true,
      css,
    );
  }
});

Deno.test("a colour out of sRGB's reach loses chroma, never its hue", () => {
  // Clipping the channels instead would shift the hue, which is the one thing
  // this module promises not to do.
  const wanted = { l: 0.6, c: 0.4, h: Math.PI / 4 };
  const got = oklchToSrgb(wanted);
  const back = srgbToOklch(got);
  assertEquals(back.c < wanted.c, true, "chroma should have been reduced");
  assertAlmostEquals(back.h, wanted.h, 0.02);
  assertAlmostEquals(back.l, wanted.l, 0.02);
});
