/**
 * Making a pasted script readable on a dark screen without flattening its
 * colours.
 *
 * A script arrives from Word, Google Docs or a web page as black text on
 * white. Both this page and every display are dark unconditionally, so pasted
 * as authored it is black on black. The obvious fix — invert everything — is
 * the wrong one: a liturgy's red rubric, a cue marked in green, a highlighted
 * line all carry meaning in their hue, and inverting turns red into cyan.
 *
 * So: **decide in WCAG luminance, move in OkLCH.** The two metrics do
 * different jobs and both are needed.
 *
 * Luminance is the metric the requirement is actually written in — "can this be
 * read off a screen at the back of a hall" — and it catches the case perceptual
 * lightness misses. Pure blue is 2.44:1 against black, which is a smudge at
 * distance, but its OkLab lightness is 0.452, above any sane grey threshold; a
 * lightness-only rule would leave it exactly as unreadable as it found it.
 *
 * Luminance is useless as a *transform* axis, though. Raising it by scaling
 * channels either desaturates the colour or clips a hue to a different one.
 * OkLCH is where "keep the hue and the colourfulness, raise the lightness" is a
 * meaningful sentence, so that is where the move happens, with hue held exactly
 * and the gamut handled by reducing chroma rather than by clipping.
 *
 * DOM-free and dependency-free, like textscale.ts and sectionsize.ts: the walk
 * that applies this to real markup needs CSSOM and so cannot be unit-tested,
 * which is precisely why every *decision* is here and returns a verdict instead
 * of acting. See pasteColors.ts for the other half.
 */

export interface Rgba {
  /** 0-255, integers. */
  r: number;
  g: number;
  b: number;
  /** 0-1. */
  a: number;
}

export interface Oklch {
  /** Perceptual lightness, 0-1. */
  l: number;
  /** Chroma. 0 is a grey; around 0.37 is as saturated as sRGB gets. */
  c: number;
  /** Hue, in radians. */
  h: number;
}

/**
 * What to do with one colour declaration.
 *
 * A verdict rather than a new value, so the DOM walk carries no decisions and
 * this module needs no DOM. "drop" is not "replace with white": removing the
 * declaration lets the text inherit `--viewer-color`, so a user theme that
 * sets amber ink applies to it. That is the only reason a palette token is
 * worth having, and hard-coding white here would quietly defeat it.
 */
export type ColorVerdict =
  | { kind: "keep" }
  | { kind: "drop" }
  | { kind: "replace"; value: string };

const KEEP: ColorVerdict = { kind: "keep" };
const DROP: ColorVerdict = { kind: "drop" };

/**
 * Below this, text is too dark for a black screen.
 *
 * Exactly WCAG 2 AA body-text contrast of 4.5:1 against pure black:
 * `(L + 0.05) / 0.05 >= 4.5` gives `L >= 0.175`. Pure black is the right
 * reference because viewerBase.css sets `--viewer-bg: black` — a display is
 * black unless a theme says otherwise, and a paste-time transform cannot know
 * about a theme that may not exist yet.
 *
 * It lands usefully between the colours that actually turn up: Google Docs red
 * (#CC0000, 3.57:1) is lifted, pure red (5.25:1) is left alone.
 */
export const MIN_TEXT_LUMINANCE = 0.175;

/**
 * What a lifted colour is aimed at, above the threshold it is judged by.
 *
 * The gap is hysteresis, and it exists to make idempotence an argument rather
 * than a hope: a replacement lands at ~0.19, comfortably inside the "keep"
 * region, so pasting twice — or pasting content this has already been through
 * — cannot walk a colour up in steps.
 */
export const BRIGHTEN_TARGET_LUMINANCE = 0.19;

/**
 * At or above this, an achromatic colour is treated as somebody's "white
 * text" and dropped rather than kept, so it follows the viewer's own ink.
 */
export const NEAR_WHITE_LUMINANCE = 0.6;

/** Below this chroma a colour is a grey: no hue worth preserving. */
export const ACHROMATIC_CHROMA = 0.02;

/** A background at or below this is already dark enough to read on. */
export const MAX_BACKGROUND_LUMINANCE = 0.1;

/** Where a light highlight is moved to, in OkLab lightness. */
export const HIGHLIGHT_TARGET_L = 0.3;

/**
 * The named colours worth knowing.
 *
 * Not all 148. In production the walk reads values through CSSOM, which has
 * already serialised every form to `rgb()`, so this table is mostly for
 * hand-written markup and for tests — and a name that is missing costs
 * nothing, because an unparseable colour is kept exactly as authored.
 */
const NAMED: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  navy: "#000080",
  olive: "#808000",
  purple: "#800080",
  teal: "#008080",
  orange: "#ffa500",
  darkred: "#8b0000",
  darkgreen: "#006400",
  darkblue: "#00008b",
  dimgray: "#696969",
  dimgrey: "#696969",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  whitesmoke: "#f5f5f5",
};

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** A channel written as either a number or a percentage. */
function channel(raw: string): number | null {
  const pct = raw.endsWith("%");
  const n = Number(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) return null;
  return clamp255(pct ? (n / 100) * 255 : n);
}

function alpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const pct = raw.endsWith("%");
  const n = Number(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) return null;
  return clamp01(pct ? n / 100 : n);
}

function hueToRgb(p: number, q: number, t: number): number {
  let u = t;
  if (u < 0) u += 1;
  if (u > 1) u -= 1;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

/**
 * Read a CSS colour, or `null` for one we do not understand.
 *
 * **Never a guess.** `null` means the declaration is left exactly as authored,
 * and that is the right answer for `currentColor`, `inherit`, `var(--x)`,
 * `color-mix()`, `lab()`, `color(display-p3 …)` and Word's `windowtext`. Two of
 * those matter especially: `windowtext` is Word's black and is already handled
 * for free (it is not a valid CSS colour, so the browser drops the declaration
 * and the text arrives unstyled), and a modern wide-gamut value is better left
 * intact than mangled through an sRGB round trip.
 */
export function parseCssColor(value: string): Rgba | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  if (!input) return null;

  const named = NAMED[input];
  const text = named ?? input;

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const d = hex[1];
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
    if (d.length === 3 || d.length === 4) {
      return {
        r: expand(d[0]),
        g: expand(d[1]),
        b: expand(d[2]),
        a: d.length === 4 ? expand(d[3]) / 255 : 1,
      };
    }
    if (d.length === 6 || d.length === 8) {
      return {
        r: expand(d.slice(0, 2)),
        g: expand(d.slice(2, 4)),
        b: expand(d.slice(4, 6)),
        a: d.length === 8 ? expand(d.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }

  // Both the legacy comma syntax and the modern space syntax, since the first
  // is what older sources emit and the second is what a browser serialises to
  // when an alpha is involved.
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[2].trim().split(/\s*[,/]\s*|\s+/).filter((p) => p !== "");
  if (parts.length < 3 || parts.length > 4) return null;

  const a = alpha(parts[3]);
  if (a === null) return null;

  if (fn[1].startsWith("rgb")) {
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if (r === null || g === null || b === null) return null;
    return { r, g, b, a };
  }

  const hueRaw = parts[0].replace(/deg$/, "");
  const hue = Number(hueRaw);
  const sat = Number(parts[1].replace(/%$/, "")) / 100;
  const light = Number(parts[2].replace(/%$/, "")) / 100;
  if (![hue, sat, light].every(Number.isFinite)) return null;
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = clamp01(sat);
  const l = clamp01(light);
  if (s === 0) {
    const v = clamp255(l * 255);
    return { r: v, g: v, b: v, a };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: clamp255(hueToRgb(p, q, h + 1 / 3) * 255),
    g: clamp255(hueToRgb(p, q, h) * 255),
    b: clamp255(hueToRgb(p, q, h - 1 / 3) * 255),
    a,
  };
}

/**
 * Write a colour back out.
 *
 * Hex when it is opaque, because this string ends up in the document and the
 * published HTML goes out whole on every keystroke with live editing on — a
 * shorter form is free. `rgba()` when it is not, since hex with alpha is not
 * universally understood by older sources we might round-trip through.
 */
export function formatCssColor(c: Rgba): string {
  const hex = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  if (c.a >= 1) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${
    Number(clamp01(c.a).toFixed(3))
  })`;
}

function linearise(c8: number): number {
  const c = clamp255(c8) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function delinearise(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

/** WCAG relative luminance, 0 for black and 1 for white. */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * linearise(c.r) + 0.7152 * linearise(c.g) +
    0.0722 * linearise(c.b);
}

/** Contrast ratio against pure black — what a display's page actually is. */
export function contrastOnBlack(c: Rgba): number {
  return (relativeLuminance(c) + 0.05) / 0.05;
}

export function srgbToOklch(c: Rgba): Oklch {
  const r = linearise(c.r);
  const g = linearise(c.g);
  const b = linearise(c.b);

  const l = Math.cbrt(
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
  );
  const m = Math.cbrt(
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
  );
  const s = Math.cbrt(
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  );

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    l: okL,
    c: Math.sqrt(okA * okA + okB * okB),
    h: Math.atan2(okB, okA),
  };
}

function oklchToLinear(lch: Oklch): [number, number, number] {
  const okA = Math.cos(lch.h) * lch.c;
  const okB = Math.sin(lch.h) * lch.c;

  const l = Math.pow(lch.l + 0.3963377774 * okA + 0.2158037573 * okB, 3);
  const m = Math.pow(lch.l - 0.1055613458 * okA - 0.0638541728 * okB, 3);
  const s = Math.pow(lch.l - 0.0894841775 * okA - 1.291485548 * okB, 3);

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  const e = 1e-4;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e &&
    b <= 1 + e;
}

/**
 * Back to sRGB, reducing chroma until the colour fits.
 *
 * Chroma is what gives, never hue: the whole promise of this module is that red
 * stays red, so a colour that cannot be had at this lightness becomes a less
 * colourful version of itself rather than a slightly different colour. Clipping
 * the channels instead would shift the hue, which is the failure mode to avoid.
 */
export function oklchToSrgb(lch: Oklch, alphaValue = 1): Rgba {
  const l = clamp01(lch.l);
  let lo = 0;
  let hi = Math.max(0, lch.c);
  if (inGamut(oklchToLinear({ l, c: hi, h: lch.h }))) lo = hi;
  else {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: lch.h }))) lo = mid;
      else hi = mid;
    }
  }
  const [r, g, b] = oklchToLinear({ l, c: lo, h: lch.h });
  return {
    r: clamp255(delinearise(clamp01(r))),
    g: clamp255(delinearise(clamp01(g))),
    b: clamp255(delinearise(clamp01(b))),
    a: clamp01(alphaValue),
  };
}

/**
 * The smallest lift that clears the target, measured on the quantised result.
 *
 * Quantised is the important word. The search asks what the *8-bit* colour's
 * luminance is, so the value that ships is the value that was judged — which is
 * what makes a second pass return "keep" rather than lifting it again.
 */
function liftToTarget(lch: Oklch, alphaValue: number, target: number): Rgba {
  let lo = lch.l;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const candidate = oklchToSrgb({ l: mid, c: lch.c, h: lch.h }, alphaValue);
    if (relativeLuminance(candidate) >= target) hi = mid;
    else lo = mid;
  }
  return oklchToSrgb({ l: hi, c: lch.c, h: lch.h }, alphaValue);
}

/**
 * What to do with a pasted text colour.
 *
 * Three outcomes, and which one applies is decided by whether the colour
 * carries a hue worth keeping:
 *
 * - **A grey** — including black — is dropped, so the text inherits the
 *   viewer's own ink and follows any theme. A near-white grey is dropped too:
 *   it was almost certainly somebody's "white text" for a dark theme, and
 *   inheriting is what makes it right on an amber screen as well as a white
 *   one. A deliberate mid-grey is kept, since de-emphasis is a real intent and
 *   it already reads.
 * - **A hue that is bright enough** is left alone. Pure red is already 5.25:1.
 * - **A hue that is too dark** keeps its hue and chroma and has its lightness
 *   raised until it clears the target.
 */
export function brightenTextColor(value: string): ColorVerdict {
  const rgba = parseCssColor(value);
  if (!rgba) return KEEP;
  // Invisible either way, and "leave it" is the conservative half. Google Docs
  // emits background-color: transparent on nearly every span.
  if (rgba.a === 0) return KEEP;

  const luminance = relativeLuminance(rgba);
  const lch = srgbToOklch(rgba);

  if (lch.c < ACHROMATIC_CHROMA) {
    if (luminance < MIN_TEXT_LUMINANCE) return DROP;
    if (luminance >= NEAR_WHITE_LUMINANCE) return DROP;
    return KEEP;
  }

  if (luminance >= MIN_TEXT_LUMINANCE) return KEEP;

  const lifted = liftToTarget(lch, rgba.a, BRIGHTEN_TARGET_LUMINANCE);
  return { kind: "replace", value: formatCssColor(lifted) };
}

/**
 * What to do with a pasted background colour.
 *
 * A light background pasted onto a dark screen is a lit box around the text,
 * and the naive fix is worse than the problem: keep a yellow highlight while
 * brightening the black text inside it and the result is white on yellow.
 *
 * So a light *highlight* is inverted in lightness rather than discarded — it
 * keeps its hue, so "this bit is highlighted, in yellow" survives, and because
 * the result is dark the foreground rule needs no knowledge of the background
 * at all. That is what lets these two functions stay independent, with no
 * inherited-background stack down the walk.
 *
 * Greys go entirely: a white page box or a grey table shading carries no
 * meaning worth keeping on a screen that is already black.
 */
export function adaptBackgroundColor(value: string): ColorVerdict {
  const rgba = parseCssColor(value);
  if (!rgba) return KEEP;
  if (rgba.a === 0) return KEEP;

  // Anything already dark enough to read on is left alone, and this test comes
  // *first* deliberately — it is what makes the whole function idempotent, and
  // ordering it after the achromatic test did not work. Darkening a barely
  // chromatic colour lowers its chroma too: #566 (chroma 0.0206, just above the
  // threshold) darkens to #223131 (chroma 0.0200, just below it), so a second
  // pass took the achromatic branch and dropped what the first pass had kept.
  // Measured, not hypothesised — the sweep in contrast_test.ts found it. With
  // the dark test first, a darkened highlight is simply kept, whatever its
  // chroma rounds to.
  if (relativeLuminance(rgba) <= MAX_BACKGROUND_LUMINANCE) return KEEP;

  const lch = srgbToOklch(rgba);
  // A light grey — a white page box, a shaded table cell — carries nothing
  // worth keeping on a screen that is already black.
  if (lch.c < ACHROMATIC_CHROMA) return DROP;

  const darkened = oklchToSrgb(
    { l: HIGHLIGHT_TARGET_L, c: lch.c, h: lch.h },
    rgba.a,
  );
  return { kind: "replace", value: formatCssColor(darkened) };
}
