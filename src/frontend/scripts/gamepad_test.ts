// Tests for the gamepad arithmetic. No DOM and no fakes beyond a plain object
// standing in for a Gamepad — the same reason textscale.ts was split out of
// teleprompter.ts, with the extra one that a physical pad can't be held by CI.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type GamepadLike,
  newlyPressed,
  PAD_BINDINGS,
  PAD_LABELS,
  type PadButton,
  readPad,
  speedFromTriggers,
  stickScroll,
  triggerValue,
} from "./gamepad.ts";

/** A standard-mapping pad with everything at rest, and overrides applied. */
function pad(
  {
    r2 = 0,
    l2 = 0,
    stickY = 0,
    down = [] as PadButton[],
    mapping = "standard",
  },
): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({
    pressed: false,
    value: 0,
  }));
  buttons[7] = { pressed: r2 > 0, value: r2 };
  buttons[6] = { pressed: l2 > 0, value: l2 };
  const index: Record<PadButton, number> = { cross: 0, l1: 4, r1: 5 };
  for (const name of down) buttons[index[name]] = { pressed: true, value: 1 };
  return { mapping, axes: [0, stickY, 0, 0], buttons };
}

// The slider's own bounds, mirrored here so the expectations below read as the
// operator's numbers rather than as a variable.
const MAX = 500;

Deno.test("full forward throttle is the slider's *negative* extreme", () => {
  // The sign is the one thing here that is easy to get backwards, and getting
  // it backwards means a teleprompter that runs the show in reverse. Wire speed
  // is -rngSpeed.value, so forward is a negative slider value.
  assertEquals(speedFromTriggers(1, 0, MAX), -MAX);
  assertEquals(speedFromTriggers(0, 1, MAX), MAX);
  assertEquals(speedFromTriggers(0, 0, MAX), 0);
});

Deno.test("the throttle is proportional, so half pressed is half speed", () => {
  assertEquals(speedFromTriggers(0.5, 0, MAX), -250);
  assertEquals(speedFromTriggers(0.2, 0, MAX), -100);
});

Deno.test("squeezing both throttles cancels rather than picking a winner", () => {
  assertEquals(speedFromTriggers(1, 1, MAX), 0);
  assertEquals(speedFromTriggers(0.75, 0.25, MAX), -250);
});

Deno.test("a resting trigger reads exactly zero", () => {
  // A pad on the desk reporting 0.02 would otherwise creep the show along for
  // the whole service.
  assertEquals(triggerValue(0), 0);
  assertEquals(triggerValue(0.03), 0);
  assert(triggerValue(0.2) > 0);
});

Deno.test("the deadzone costs the bottom of the range, not the top", () => {
  // Rescaled past the deadzone, so full deflection still means full speed —
  // otherwise the operator could never reach the slider's extreme.
  assertEquals(triggerValue(1), 1);
});

Deno.test("a pad is read in the app's terms, not the API's indices", () => {
  const sample = readPad(pad({ r2: 1, l2: 0.5, down: ["r1"] }))!;
  assertEquals(sample.forward, 1);
  assertAlmostEquals(sample.reverse, (0.5 - 0.04) / 0.96);
  assertEquals([...sample.pressed], ["r1"]);
});

Deno.test("a pad the browser could not map is refused outright", () => {
  // Its indices are whatever the hardware chose, so R2 could be the stick.
  // Better nothing than scrolling the show from a button nobody pressed.
  assertEquals(readPad(pad({ mapping: "", r2: 1 })), null);
  assertEquals(readPad(pad({ mapping: "standard-gamepad", r2: 1 })), null);
});

Deno.test("a pad missing the buttons we read is still safe to sample", () => {
  // Standard mapping promises the indices; a driver that under-reports anyway
  // must not throw inside the frame loop and take the poll down with it.
  const sample = readPad({ mapping: "standard", axes: [], buttons: [] })!;
  assertEquals(sample.forward, 0);
  assertEquals(sample.reverse, 0);
  assertEquals(sample.stickY, 0);
  assertEquals(sample.pressed.size, 0);
});

Deno.test("a stick at rest, or barely off it, scrolls nothing", () => {
  assertEquals(readPad(pad({ stickY: 0 }))!.stickY, 0);
  assertEquals(readPad(pad({ stickY: 0.1 }))!.stickY, 0);
  assertEquals(stickScroll(0, 16, 2000), 0);
});

Deno.test("the stick's response is squared, and up scrolls up", () => {
  // Half deflection is a quarter of the speed: the stick has to creep a line
  // and cross a page, and linear makes the slow end unusable.
  assertEquals(stickScroll(1, 1000, 2000), 2000);
  assertEquals(stickScroll(0.5, 1000, 2000), 500);
  assertEquals(stickScroll(-0.5, 1000, 2000), -500);
});

Deno.test("a frame with no time in it moves nothing", () => {
  // The first poll of a run has no previous timestamp to subtract.
  assertEquals(stickScroll(1, 0, 2000), 0);
  assertEquals(stickScroll(1, -5, 2000), 0);
});

Deno.test("a held button is one press, not one per frame", () => {
  // R1 held for a second must send one position. Nothing else in the input
  // path debounces, because keys repeat and polled buttons don't.
  const none = new Set<PadButton>();
  const r1 = new Set<PadButton>(["r1"]);
  assertEquals([...newlyPressed(none, r1)], ["r1"]);
  assertEquals([...newlyPressed(r1, r1)], []);
  assertEquals([...newlyPressed(r1, none)], []);
  // Released and pressed again is a second press.
  assertEquals([...newlyPressed(none, r1)], ["r1"]);
});

Deno.test("every bound button has a label and no two share a command", () => {
  const ids = Object.values(PAD_BINDINGS);
  assertEquals(new Set(ids).size, ids.length);
  for (const name of Object.keys(PAD_BINDINGS) as PadButton[]) {
    assert(PAD_LABELS[name], `${name} has no label to show in the palette`);
  }
});
