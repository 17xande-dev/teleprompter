// The arithmetic and the mapping table behind game-controller support. DOM-free
// so all of it is testable without a browser and — more to the point — without a
// physical pad, which is the one part of this feature a test can never hold.
// gamepadControls.ts does the polling and the pressing.
//
// Everything here reads a *snapshot*. The Gamepad API has no events for axes or
// analog triggers, only a `Gamepad` object re-read on every frame, so the DOM
// half samples and hands the numbers over.

/**
 * What this module needs from a `Gamepad`.
 *
 * Structural because `Gamepad` cannot be constructed: a test can build one of
 * these as a plain object, and the real one satisfies it.
 */
export interface GamepadLike {
  mapping: string;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

/** The controls this feature uses, named as a PlayStation pad labels them. */
export type PadButton = "cross" | "l1" | "r1" | "dpadUp" | "dpadDown";

/**
 * Indices into `Gamepad.buttons` under the "standard" mapping.
 *
 * L2/R2 are *buttons* there, not axes, and carry their pressure in `value`
 * rather than only `pressed` — which is what makes an analog throttle possible
 * at all. The stick is axes 0 (x) and 1 (y).
 */
const BUTTON_INDEX = {
  cross: 0,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  dpadUp: 12,
  dpadDown: 13,
} as const;
const AXIS_STICK_Y = 1;
/**
 * The right stick's vertical axis.
 *
 * Axes 2 and 3 are the right stick under the standard mapping, the same way 0
 * and 1 are the left. Only the vertical half is read: the sidebar it scrolls
 * has no horizontal travel, and a stick that did something on both axes would
 * make a diagonal nudge move the page sideways for no reason.
 */
const AXIS_RIGHT_STICK_Y = 3;

/** One frame of the pad, in the terms this app cares about. */
export interface PadSample {
  /** 0..1, the forward throttle (R2). */
  forward: number;
  /** 0..1, the reverse throttle (L2). */
  reverse: number;
  /** -1..1 as the browser reports it: negative is stick pushed *up*. */
  stickY: number;
  /** The same for the right stick, which scrolls the operator's own panel. */
  rightStickY: number;
  /** The one-shot buttons held down this frame. */
  pressed: Set<PadButton>;
}

/**
 * A resting trigger does not report exactly zero, and a worn stick reports
 * rather more than that. Both deadzones exist so an untouched pad sitting on
 * the desk cannot creep the show along.
 */
const TRIGGER_DEADZONE = 0.04;
const STICK_DEADZONE = 0.15;

/**
 * Rescale past a deadzone so the usable travel still reaches 1.
 *
 * Without the rescale the operator loses the top of the range as well as the
 * bottom, and full deflection would never quite mean full speed.
 */
function pastDeadzone(v: number, deadzone: number): number {
  const m = Math.min(1, Math.abs(v));
  if (m <= deadzone) return 0;
  return Math.sign(v) * (m - deadzone) / (1 - deadzone);
}

/** A trigger's pressure, 0..1, with its resting noise removed. */
export function triggerValue(v: number): number {
  return pastDeadzone(Math.max(0, v), TRIGGER_DEADZONE);
}

/**
 * Read a pad, or `null` if it isn't one we can trust.
 *
 * A pad the browser could not fit to the standard mapping reports its axes and
 * buttons in whatever order its hardware chose, so R2's index could be anything
 * — including the stick. Refusing it outright beats scrolling the show from a
 * button nobody pressed; the alternative is a per-device mapping table, which
 * is a much larger feature than this one.
 */
export function readPad(pad: GamepadLike): PadSample | null {
  if (pad.mapping !== "standard") return null;

  const button = (i: number) => pad.buttons[i];
  const pressed = new Set<PadButton>();
  for (const name of ["cross", "l1", "r1", "dpadUp", "dpadDown"] as const) {
    if (button(BUTTON_INDEX[name])?.pressed) pressed.add(name);
  }

  return {
    forward: triggerValue(button(BUTTON_INDEX.r2)?.value ?? 0),
    reverse: triggerValue(button(BUTTON_INDEX.l2)?.value ?? 0),
    stickY: pastDeadzone(pad.axes[AXIS_STICK_Y] ?? 0, STICK_DEADZONE),
    rightStickY: pastDeadzone(
      pad.axes[AXIS_RIGHT_STICK_Y] ?? 0,
      STICK_DEADZONE,
    ),
    pressed,
  };
}

/**
 * The Scroll Speed slider position for a pair of throttles.
 *
 * The sign is the thing to get right here, and it is not intuitive: wire speed
 * is `-rngSpeed.value`, the inversion that puts Forward at the *bottom* of the
 * vertical slider so the thumb travels the way the text does. So forward is a
 * *negative* slider value, and R2 pushes the slider down.
 *
 * The two throttles subtract rather than taking priority, so squeezing both
 * lands on zero. That is the honest reading of "one wants forward this hard,
 * the other back that hard", and it needs no rule of its own.
 */
export function speedFromTriggers(
  forward: number,
  reverse: number,
  max: number,
): number {
  return (reverse - forward) * max;
}

/**
 * Pixels the operator's pane should move this frame for a stick deflection.
 *
 * Squared response: the stick's job is both to creep a line at a time and to
 * cross a page, and a linear map makes the slow end unusably twitchy. Sign is
 * preserved, and up on the stick (negative) scrolls up.
 */
export function stickScroll(
  stickY: number,
  dtMs: number,
  maxPxPerSec: number,
): number {
  if (stickY === 0 || dtMs <= 0) return 0;
  return Math.sign(stickY) * stickY * stickY * maxPxPerSec * (dtMs / 1000);
}

/**
 * The buttons that went down between two frames.
 *
 * Polling means a held button is indistinguishable from a button pressed sixty
 * times unless the edge is taken here. R1 held for a second must send one
 * position, not sixty.
 */
export function newlyPressed(
  prev: ReadonlySet<PadButton>,
  next: ReadonlySet<PadButton>,
): Set<PadButton> {
  const edges = new Set<PadButton>();
  for (const name of next) {
    if (!prev.has(name)) edges.add(name);
  }
  return edges;
}

/**
 * The one-shot buttons, as command ids.
 *
 * Ids rather than functions so a pad press runs the *same* `Command.run` the
 * palette row and the keyboard shortcut do — the rule that keeps the three from
 * drifting, which is why controlCommands.ts's table is the only place behaviour
 * is written down. commands_test.ts checks every id here names a real command.
 */
export const PAD_BINDINGS: Record<PadButton, string> = {
  cross: "scroll.toggle",
  r1: "position.send",
  l1: "position.get",
  // The viewers' size, not the operator's own: the D-pad is on the hand that
  // is not holding the throttle, and "the text is too small" is a thing the
  // person at the desk fixes for the room rather than for their screen.
  dpadUp: "scale.up",
  dpadDown: "scale.down",
};

/** How each bound button is named in the palette. */
export const PAD_LABELS: Record<PadButton, string> = {
  cross: "Cross",
  r1: "R1",
  l1: "L1",
  dpadUp: "D-pad up",
  dpadDown: "D-pad down",
};

/**
 * How long a held button waits before it starts repeating, and how fast.
 *
 * A keyboard gets this from the operating system; a polled pad has to do it
 * itself. Without it a held D-pad is one step, and the Text Scale slider is
 * twenty steps wide — so the operator would be tapping rather than holding,
 * which is not what a pad is for. The delay is what keeps a single deliberate
 * press from becoming two.
 */
export const REPEAT_DELAY_MS = 400;
export const REPEAT_EVERY_MS = 80;

/**
 * Whether a held button should fire again this frame.
 *
 * `heldMs` is how long it has been down, `sinceLastMs` how long since it last
 * fired. Only commands marked `repeatable` are given to this — pressing
 * "send my position" for half a second must send one position, not seven.
 */
export function repeatDue(heldMs: number, sinceLastMs: number): boolean {
  if (heldMs < REPEAT_DELAY_MS) return false;
  return sinceLastMs >= REPEAT_EVERY_MS;
}
