// Tests for the polling half. Everything it touches in the world — the pad
// list, the frame loop, the connect events, the slider, the pane — is a
// constructor argument, so this runs with no DOM and no pad, and frames are
// stepped by hand rather than waited on.
import { assert, assertEquals } from "jsr:@std/assert";
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
  return ["scroll.toggle", "position.send", "position.get"].map((id) => ({
    id,
    label: id,
    group: "Scroll" as const,
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
      rngSpeed: { value: 0, dispatchEvent: () => true },
      scrollOwnPane: () => 0,
    });
  } catch {
    threw = true;
  }
  assert(threw);
});
