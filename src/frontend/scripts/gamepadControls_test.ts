// Tests for the polling half. Everything it touches in the world — the pad
// list, the frame loop, the connect events, the slider, the pane — is a
// constructor argument, so this runs with no DOM and no pad, and frames are
// stepped by hand rather than waited on.
import { assert, assertEquals } from "@std/assert";
import type { Command } from "./commands.ts";
import { GamepadControls } from "./gamepadControls.ts";

/** A standard-mapping pad, mutable so a test can squeeze a trigger. */
function fakePad() {
  const buttons = Array.from({ length: 17 }, () => ({
    pressed: false,
    value: 0,
  }));
  return {
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons,
    press(index: number, value = 1) {
      buttons[index] = { pressed: value > 0, value };
    },
    release(index: number) {
      buttons[index] = { pressed: false, value: 0 };
    },
  };
}

/**
 * The three commands the pad binds, recording what ran.
 *
 * Real `Command`s, because the controls resolve them by id out of the same
 * bound list the palette gets, and that lookup is part of what is under test.
 */
function fakeCommands(ran: string[]): Command[] {
  return [
    { id: "scroll.toggle", repeatable: false },
    { id: "position.send", repeatable: false },
    { id: "position.get", repeatable: false },
    // The two the D-pad drives. Repeatable, like the real table's, which is
    // what lets a held button keep nudging the slider.
    { id: "scale.up", repeatable: true },
    { id: "scale.down", repeatable: true },
  ].map(({ id, repeatable }) => ({
    id,
    label: id,
    group: "Scroll" as const,
    repeatable,
    run: () => {
      ran.push(id);
    },
  }));
}

/**
 * A GamepadControls with every seam faked.
 *
 * `scrollLimit` stands in for the browser refusing to move less than a whole
 * device pixel — 0 means "never moves", which is the case the carry exists for.
 */
function harness({ scrollLimit = Infinity }: { scrollLimit?: number } = {}) {
  const ran: string[] = [];
  const slider = { value: 0, inputs: 0 };
  const scrolled: number[] = [];
  const scrolledControls: number[] = [];
  // What each scroller was *asked* for, as against what it moved. The carry
  // only shows up here: a scroller that refuses to move reports 0 every
  // frame while the request it is handed keeps growing.
  const askedControls: number[] = [];
  const indicator = { hidden: true as boolean | string };
  const pads: unknown[] = [];
  const target = new EventTarget();
  let pending: ((t: number) => void) | null = null;

  new GamepadControls(
    fakeCommands(ran),
    {
      rngSpeed: {
        get value() {
          return slider.value;
        },
        set value(v: number) {
          slider.value = v;
        },
        dispatchEvent: () => (slider.inputs++, true),
      },
      scrollOwnPane: (px: number) => {
        const moved = Math.min(Math.abs(px), scrollLimit) * Math.sign(px);
        scrolled.push(moved);
        return moved;
      },
      scrollControls: (px: number) => {
        askedControls.push(px);
        const moved = Math.min(Math.abs(px), scrollLimit) * Math.sign(px);
        scrolledControls.push(moved);
        return moved;
      },
    },
    {
      indicator,
      target,
      getGamepads: () => pads as (Gamepad | null)[],
      requestFrame: (cb) => {
        pending = cb;
        return 1;
      },
      cancelFrame: () => {
        pending = null;
      },
    },
  );

  return {
    ran,
    slider,
    scrolled,
    scrolledControls,
    askedControls,
    indicator,
    pads,
    connect: () => target.dispatchEvent(new Event("gamepadconnected")),
    disconnect: () => target.dispatchEvent(new Event("gamepaddisconnected")),
    /** Run the frame the controls are waiting on, at `t` ms. */
    step(t: number) {
      const cb = pending;
      pending = null;
      cb?.(t);
    },
    polling: () => pending !== null,
  };
}

Deno.test("nothing is polled until a pad connects", () => {
  const h = harness();
  assert(!h.polling());
  assertEquals(h.indicator.hidden, true);
});

Deno.test("connecting a pad shows the indicator and starts the poll", () => {
  const h = harness();
  h.pads.push(fakePad());
  h.connect();
  assertEquals(h.indicator.hidden, false);
  assert(h.polling());
});

Deno.test("a pad the browser could not map is not a pad", () => {
  // Its indices are unknown, so polling it could scroll the show from
  // whatever button happened to land at index 7.
  const h = harness();
  const pad = fakePad();
  pad.mapping = "";
  h.pads.push(pad);
  h.connect();
  assertEquals(h.indicator.hidden, true);
  assert(!h.polling());
});

Deno.test("an untouched pad never writes the speed slider", () => {
  // The rule that keeps a connected pad out of the operator's way. Without it
  // the pad would broadcast a speed every frame and stamp on the wheel and
  // the keyboard nudges the moment either was used.
  const h = harness();
  h.pads.push(fakePad());
  h.connect();
  h.step(16);
  h.step(32);
  h.step(48);
  assertEquals(h.slider.inputs, 0);
  assertEquals(h.slider.value, 0);
});

Deno.test("the forward trigger drives the slider toward Forward", () => {
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  pad.press(7, 1); // R2
  h.step(16);
  assertEquals(h.slider.value, -500);
  assertEquals(h.slider.inputs, 1);

  pad.press(6, 1); // L2 as well, and they cancel.
  h.step(32);
  assertEquals(h.slider.value, 0);
});

Deno.test("releasing the trigger writes the final zero exactly once", () => {
  // The trailing write is why the throttle keeps a flag rather than skipping
  // every idle frame: without it the slider would stick at whatever the
  // trigger read on its way up.
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  pad.press(7, 1);
  h.step(16);
  pad.release(7);
  h.step(32);
  assertEquals(h.slider.value, 0);
  assertEquals(h.slider.inputs, 2);
  h.step(48);
  h.step(64);
  assertEquals(h.slider.inputs, 2);
});

Deno.test("the stick scrolls the operator's pane and nothing else", () => {
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0); // The first frame has no elapsed time to integrate.
  pad.axes[1] = -1; // Stick fully up.
  h.step(1000);
  assertEquals(h.scrolled.length, 1);
  assert(h.scrolled[0] < 0, "up on the stick scrolls up");
  // The pane moved; the speed slider was never touched.
  assertEquals(h.slider.inputs, 0);
});

Deno.test("a stick at rest asks for no scroll at all", () => {
  const h = harness();
  h.pads.push(fakePad());
  h.connect();
  h.step(0);
  h.step(16);
  h.step(32);
  assertEquals(h.scrolled, []);
});

Deno.test("sub-pixel stick movement keeps asking rather than being lost", () => {
  // A pane that quantises to whole pixels moves nothing for a small
  // deflection, so the debt accumulates until it is worth a pixel. This fake
  // never moves, which is the pathological version of that.
  const h = harness({ scrollLimit: 0 });
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0);
  pad.axes[1] = 0.2;
  for (let t = 16; t <= 96; t += 16) h.step(t);
  assert(h.scrolled.length >= 5);
  assert(h.scrolled.every((px) => px === 0));
});

Deno.test("a button press runs its command once, however long it is held", () => {
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();

  pad.press(5); // R1
  h.step(16);
  h.step(32);
  h.step(48);
  assertEquals(h.ran, ["position.send"]);

  // Released and pressed again is a second press.
  pad.release(5);
  h.step(64);
  pad.press(5);
  h.step(80);
  assertEquals(h.ran, ["position.send", "position.send"]);
});

Deno.test("each bound button runs its own command", () => {
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  pad.press(0); // Cross
  pad.press(4); // L1
  h.step(16);
  assertEquals(h.ran.toSorted(), ["position.get", "scroll.toggle"]);
});

Deno.test("unplugging mid-frame stops the poll and hides the indicator", () => {
  // The disconnect event may not have arrived — and with two pads plugged in
  // it says nothing about whether one is left — so the poll re-asks.
  const h = harness();
  h.pads.push(fakePad());
  h.connect();
  h.step(16);
  h.pads.length = 0;
  h.step(32);
  assert(!h.polling());
  assertEquals(h.indicator.hidden, true);
});

Deno.test("a second connect does not start a second poll", () => {
  // Two pads, or a pad that reconnects, would otherwise leave two frame loops
  // running and double every write.
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.connect();
  pad.press(7, 1);
  h.step(16);
  assertEquals(h.slider.inputs, 1);
});

Deno.test("a binding naming a command that isn't there fails loudly", () => {
  // A quietly dead button is the worst outcome: the palette would go on
  // listing it and the operator would find out mid-service.
  let threw = false;
  try {
    new GamepadControls([], {
      scrollControls: () => 0,
      rngSpeed: { value: 0, dispatchEvent: () => true },
      scrollOwnPane: () => 0,
    });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("the right stick scrolls the sidebar, and the left the script", () => {
  // Two scrollers, two sticks. Crossing them would be invisible in review and
  // obvious the first time an operator nudged the panel and the script moved
  // in front of the talent.
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0);

  pad.axes[3] = 1; // Right stick down.
  h.step(1000);
  assertEquals(h.scrolled.length, 0, "the script must not move");
  assertEquals(h.scrolledControls.length, 1);
  assert(h.scrolledControls[0] > 0, "down on the stick scrolls down");

  pad.axes[3] = 0;
  pad.axes[1] = -1; // Left stick up.
  h.step(2000);
  assertEquals(h.scrolledControls.length, 1, "the sidebar must not move");
  assertEquals(h.scrolled.length, 1);
  assert(h.scrolled[0] < 0);
});

Deno.test("each stick carries its own sub-pixel remainder", () => {
  // A debt owed by one scroller must not be spent on the other: with a shared
  // carry, a flick of the script would make the sidebar jump on the next
  // frame the right stick moved at all.
  const h = harness({ scrollLimit: 0 });
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0);

  pad.axes[3] = 0.4;
  h.step(100);
  h.step(200);
  assert(
    h.askedControls[1] > h.askedControls[0],
    `the sidebar's unspent pixels should accumulate: ${h.askedControls}`,
  );
  assertEquals(h.scrolled.length, 0, "and none of it reached the script");
});

Deno.test("a held D-pad keeps nudging the slider, after a pause", () => {
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0);

  pad.press(12); // D-pad up.
  h.step(100);
  assertEquals(h.ran, ["scale.up"], "the press itself fires once");

  // Nothing during the delay, however many frames go by.
  h.step(200);
  h.step(400);
  assertEquals(h.ran.length, 1, "a deliberate press must not become two");

  // Then it repeats on its own clock.
  h.step(520);
  h.step(620);
  assert(h.ran.length >= 3, `expected repeats, got ${h.ran.length}`);
  assert(h.ran.every((id) => id === "scale.up"));

  // And stops the moment it is released.
  pad.release(12);
  h.step(720);
  const afterRelease = h.ran.length;
  h.step(820);
  assertEquals(h.ran.length, afterRelease);
});

Deno.test("a one-shot button held down still fires exactly once", () => {
  // The repeat is driven by the command's own `repeatable` flag, so holding
  // "send my position" sends one position rather than seven — the same rule
  // the keyboard follows.
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0);

  pad.press(5); // R1.
  h.step(100);
  h.step(600);
  h.step(1200);
  assertEquals(h.ran, ["position.send"]);
});

Deno.test("releasing and pressing again starts the delay over", () => {
  // Otherwise the second press would look like a button held since the first
  // and repeat immediately, which reads as a double press.
  const h = harness();
  const pad = fakePad();
  h.pads.push(pad);
  h.connect();
  h.step(0);

  pad.press(13); // D-pad down.
  h.step(100);
  pad.release(13);
  h.step(200);
  pad.press(13);
  h.step(300);
  assertEquals(h.ran, ["scale.down", "scale.down"]);
  h.step(360);
  assertEquals(h.ran.length, 2, "the delay restarted with the new press");
});
