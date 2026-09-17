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

/**
 * The editor slider's position for a pixel font size, and back again.
 *
 * Both sliders count in tenths of a rem — one grid for two panes, so "editor
 * 2.0, viewers 3.0" is a comparison and not two units side by side. The
 * rounding is the slider's `step="1"`: a position it cannot hold would be
 * quantised by the component anyway, and rounding here keeps the readout and
 * the applied size agreeing about which position was chosen.
 */
export function pxToTenths(px: number): number {
  return Math.round((px / REM_PX) * 10);
}

/** The rem length a slider position stands for, e.g. 20 is 2rem. */
export function tenthsToRem(tenths: number): number {
  return tenths / 10;
}

/**
 * The editor's own reading size: the range, and where it starts.
 *
 * In code rather than in the markup, which is where it used to be — the
 * `min`/`max`/`step`/`value` of a `wa-slider` in the transport column. That
 * slider is gone (the editor's toolbar has the control now), and with it went
 * the component that had been *clamping* every write. Several call sites
 * leaned on that without saying so, with comments reading "clamping is the
 * component's": the wheel handler, the two nudge commands and "match viewers'
 * text size" all just assigned and let `wa-slider` sort it out. Nothing does
 * that any more, so the range lives here beside the arithmetic that uses it
 * and `clampEditorScale` is the one thing that enforces it.
 */
export const EDITOR_SCALE = {
  min: 5,
  max: 80,
  step: 1,
  /** 2.0rem, the size the markup used to start the slider at. */
  initial: 20,
} as const;

/**
 * Hold a size inside the editor's range, on the step grid.
 *
 * Rounded as well as clamped because the callers deal in fractions — the
 * wheel divides a `deltaY` by 30, and matching the viewers' size converts
 * from pixels — and a size off the grid would make the toolbar's readout and
 * the applied size disagree about which position was chosen. Same reasoning
 * as pxToTenths above, which is why both round to the same grid.
 *
 * A non-finite input (an empty stored value parsed to NaN, a division that
 * went wrong) comes back as the initial size rather than propagating: NaN
 * assigned to the custom property computes a font-size of 0 and the script
 * vanishes with nothing in any console.
 */
export function clampEditorScale(tenths: number): number {
  if (!Number.isFinite(tenths)) return EDITOR_SCALE.initial;
  const stepped = Math.round(tenths / EDITOR_SCALE.step) * EDITOR_SCALE.step;
  return Math.min(EDITOR_SCALE.max, Math.max(EDITOR_SCALE.min, stepped));
}

/**
 * The pixels of Ctrl+wheel that move the size by one tenth of a rem.
 *
 * The same 30 `listenScaleWheel` divides by on the control page, so a display's
 * Ctrl+wheel and the operator's wheel over the Text Scale slider move the size
 * at the same rate — which matters because the two can be happening in the same
 * room, and a gesture that ran four times faster at one end would read as a
 * fault rather than as a different control.
 */
const WHEEL_PIXELS_PER_TENTH = 30;

/**
 * Round a scale to the tenth the slider counts in.
 *
 * Not because the slider demands it — `wa-slider` clamps but does not quantise
 * to its `step`, so 3.07 survives being assigned — but because the operator's
 * readout prints one decimal. Without this a pinch leaves the slider showing
 * "3.1" for a room set to 3.07, and the number on the desk stops being the
 * number in the room.
 */
function toTenth(scale: number): number {
  return Math.round(scale * 10) / 10;
}

/**
 * The size a pinch asks for, from the size it started at.
 *
 * **A ratio, never a pixel delta.** A display's `#stage` is `transform:
 * scale()`d to fit its screen, so the distance between two fingers is in screen
 * pixels while the script is laid out in the reference display's — a
 * "pixels apart to tenths" mapping would make the same physical pinch mean
 * different things on a letterboxed display and on the reference one. A ratio
 * carries no units and is the same gesture everywhere.
 *
 * `startScale` is the size the gesture *began* at, not the current one. The
 * controller echoes the new size back as it arrives, and compounding the
 * gesture onto a value it has already moved runs away exponentially.
 *
 * A ratio of zero or less, or a non-finite one, means the gesture produced
 * nothing usable — two pointers at the same point, or a lost touch — and leaves
 * the size where it was rather than propagating into a font-size.
 */
export function scaleFromPinch(startScale: number, ratio: number): number {
  if (!Number.isFinite(startScale)) return clampTextScale(1);
  if (!Number.isFinite(ratio) || ratio <= 0) return clampTextScale(startScale);
  return clampTextScale(toTenth(startScale * ratio));
}

/**
 * The size a Ctrl+wheel notch asks for.
 *
 * `pixels` is already normalised for `deltaMode` by `wheelPixels` — Firefox on
 * Windows reports a notch as three *lines* where Chrome reports it as ~120
 * pixels, and read raw that notch would resize by a hundredth of what it should.
 *
 * Scrolling *up* (a negative delta) makes the text bigger, which is what every
 * browser's own Ctrl+wheel zoom does. Deliberately not routed through
 * `wheelStep`: the "reverse slider scrolling" setting is the operator's own
 * preference about which way a wheel drags a *thumb*, it lives on the control
 * page rather than on a display, and this is a zoom rather than a slider.
 */
export function scaleFromWheel(startScale: number, pixels: number): number {
  if (!Number.isFinite(startScale)) return clampTextScale(1);
  if (!Number.isFinite(pixels)) return clampTextScale(startScale);
  const tenths = -pixels / WHEEL_PIXELS_PER_TENTH;
  return clampTextScale(toTenth(startScale + tenths / 10));
}
