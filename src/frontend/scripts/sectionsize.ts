/**
 * The arithmetic behind making one part of a script bigger than the rest.
 *
 * A **multiplier**, never a length, and that is the whole design. The Text
 * Scale slider sets how big a display's script is for the venue — the one
 * control an operator reaches for when they move from a chapel to a hall — and
 * a section pinned to an absolute size would simply ignore it. So a section
 * carries "1.5 times whatever the script is", which survives every slider
 * position, and `cssFontSize` renders that as `em`: relative to the parent, so
 * it needs no cooperation from any viewer stylesheet. That matters because a
 * user theme replaces the built-in layout layer wholesale, and anything
 * depending on a rule in there would quietly stop working under a custom theme.
 *
 * DOM-free and Wordgard-free, like textscale.ts and for the same reason: the
 * module that defines the mark and its toolbar imports Wordgard, which
 * `deno test` cannot resolve, so everything that can be got wrong numerically
 * lives here instead.
 */

/**
 * What the toolbar offers.
 *
 * Five is a judgement, not a limit: enough to be worth opening a menu for,
 * few enough that the operator picks rather than reads. 1 is in the list
 * because "back to normal" is the most common thing to want.
 */
export const SECTION_SIZES: readonly number[] = [0.75, 1, 1.25, 1.5, 2];

/**
 * Bounds for a multiplier that did not come from the list.
 *
 * Nothing in the UI can currently ask for a size outside SECTION_SIZES, but a
 * document is persisted state: a hand-edited store, a future control, or a
 * paste from another build can all put a number in here. The floor and ceiling
 * are what stop that being a script nobody can read — and `clampMultiplier` is
 * where a non-finite value is caught, which matters more than the range. A NaN
 * reaching CSS computes `font-size: 0`, so the section vanishes with nothing in
 * any console.
 */
export const SECTION_SIZE_MIN = 0.5;
export const SECTION_SIZE_MAX = 4;

/** The size a section has when it carries no mark at all. */
export const SECTION_SIZE_DEFAULT = 1;

export function clampMultiplier(m: number): number {
  if (!Number.isFinite(m)) return SECTION_SIZE_DEFAULT;
  return Math.min(SECTION_SIZE_MAX, Math.max(SECTION_SIZE_MIN, m));
}

/**
 * The CSS a multiplier becomes, or `null` for one that needs no declaration.
 *
 * `null` at 1 is deliberate. Wordgard drops an attribute whose value is null,
 * so a run at the default size serialises as bare text rather than a span
 * wrapping the whole line for no reason — which keeps the published HTML (sent
 * whole on every keystroke with live editing on) free of spans that say
 * nothing.
 *
 * `em` and nothing else. A px or rem value here would override the Text Scale
 * slider, which is the one thing this feature must not do; the unit is asserted
 * in the tests for that reason rather than for tidiness.
 */
export function cssFontSize(m: number): string | null {
  const clamped = clampMultiplier(m);
  if (clamped === SECTION_SIZE_DEFAULT) return null;
  // Trimmed, so 0.75 * 100 / 100 style arithmetic upstream cannot emit
  // "0.7500000000000001em" into the document and then into every display.
  return `${Number(clamped.toFixed(4))}em`;
}

/**
 * Read a font-size back into a multiplier, or `null` if it is not one.
 *
 * `null` is what makes the mark refuse to match, and refusing is the point on
 * the paste path: Word and Google Docs emit `font-size: 14pt` and `24px`, and
 * accepting those would pin a section to an absolute size that the Text Scale
 * slider could no longer move. They are better dropped, so the pasted text
 * simply inherits the script's size.
 *
 * `%` is accepted as the same thing as `em`, because it means the same thing
 * here — both are relative to the parent's size — and it is what some sources
 * emit for the identical intent.
 */
export function parseFontSize(css: string): number | null {
  const match = /^\s*(\d*\.?\d+)\s*(em|%)\s*$/i.exec(css);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const m = match[2].toLowerCase() === "%" ? value / 100 : value;
  if (m <= 0) return null;
  return Number(clampMultiplier(m).toFixed(4));
}

/**
 * How a size reads in the toolbar.
 *
 * A percentage rather than "1.5x": it is the vocabulary every word processor
 * uses for the same control, and the submenu labels itself from whichever item
 * is active, so these are also what the operator sees in the bar.
 */
export function formatMultiplier(m: number): string {
  return `${Math.round(clampMultiplier(m) * 100)}%`;
}
