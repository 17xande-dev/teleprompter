// Converting between the viewers' text scale and the control editor's font
// size. DOM-free so it is testable, the same split as doc.ts / docControls.ts —
// the measuring and the assigning live in teleprompter.ts.
//
// What "the same size" means here needs stating, because the obvious reading is
// wrong. The panes are different widths: the editor is roughly three quarters
// of the control page, a viewer is a whole screen. Matching font size in pixels
// would put a different number of words on each line, so the operator's eye
// would learn line breaks that the viewer doesn't have. Matching
// font-size / content-width instead keeps *characters per line* equal, which is
// what makes the two read the same even though one is a strip beside a control
// panel and the other is a wall display.

/**
 * What one unit of textScale is worth in pixels.
 *
 * viewer.ts sets `--textScale` as a rem length, and nothing on either page
 * changes the root font size, so a scale of 3 is 3rem is 48px.
 */
export const REM_PX = 16;

/** The pixel font size a viewer renders at for a given textScale. */
export function viewerFontPx(textScale: number): number {
  return textScale * REM_PX;
}

/**
 * The editor font size that reads like the viewer's, given both widths.
 *
 * Returns 0 for a width that is missing or zero rather than Infinity or NaN:
 * a viewer that has not reported its dimensions yet, or a pane measured before
 * layout, should leave the font alone instead of collapsing it.
 */
export function matchedEditorFontPx(
  textScale: number,
  editorWidth: number,
  viewerWidth: number,
): number {
  if (!(editorWidth > 0) || !(viewerWidth > 0)) return 0;
  return viewerFontPx(textScale) * (editorWidth / viewerWidth);
}

/**
 * The textScale that makes the viewers read like the editor does — the inverse
 * of `matchedEditorFontPx`, for pushing the operator's reading size outwards.
 */
export function matchedViewerTextScale(
  editorFontPx: number,
  editorWidth: number,
  viewerWidth: number,
): number {
  if (!(editorWidth > 0) || !(viewerWidth > 0)) return 0;
  return (editorFontPx / REM_PX) * (viewerWidth / editorWidth);
}

/**
 * Clamp a textScale to what the Text Scale slider can actually hold.
 *
 * The slider is the single source of truth for what the viewers are told, and
 * pushing a computed value through it means a scale push and a slider drag stay
 * one code path — so the computed value has to be a position the slider has.
 */
export function clampTextScale(textScale: number): number {
  return Math.min(10, Math.max(0.1, textScale));
}
