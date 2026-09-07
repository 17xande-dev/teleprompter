// Game-controller support for the control page: the DOM half of gamepad.ts, in
// the same arrangement as paletteControls.ts / commands.ts. All the arithmetic
// and the button map live there; this file polls, presses and shows the
// indicator.
//
// Polling is not a choice. The Gamepad API fires events only for connection, so
// an analog trigger can only be read by sampling `navigator.getGamepads()` on
// every frame. That cadence is exactly what #pushSettings already coalesces to,
// which is why the throttle can drive the slider directly without any
// rate-limiting of its own.

import type { Command } from "./commands.ts";
import {
  newlyPressed,
  nextCarry,
  PAD_BINDINGS,
  type PadButton,
  readPad,
  speedFromTriggers,
  stickScroll,
} from "./gamepad.ts";

/** A slider this drives. Web Awesome's wa-slider satisfies it, as does a stub. */
interface Slider {
  value: number;
  dispatchEvent(event: Event): boolean;
}

/**
 * What the pad needs from the control page.
 *
 * Structural and declared here, like `CommandHost`, so this file never imports
 * teleprompter.ts — that import would pull the page's raw CSS imports into any
 * test's module graph.
 */
export interface GamepadHost {
  rngSpeed: Slider;
  scrollOwnPane(px: number): number;
}

/**
 * Something shown only while a pad is connected.
 *
 * `hidden` is widened because Web Awesome reflects it as an attribute, so
 * `wa-icon.hidden` is typed `string | boolean`; writing a boolean to it is
 * still what hides the element.
 */
interface Indicator {
  hidden: boolean | string;
}

export interface GamepadOptions {
  /** Hidden until a pad is connected. */
  indicator?: Indicator;
  /** Injected so a test needn't own the real navigator or a frame loop. */
  getGamepads?: () => (Gamepad | null)[];
  requestFrame?: (cb: (t: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  /**
   * Where the connect/disconnect events arrive. Injectable so each test gets
   * its own, rather than every instance ever built listening on one global and
   * waking for another test's pad.
   */
  target?: EventTarget;
}

/**
 * The slider's forward extreme, and so what a fully squeezed trigger means.
 *
 * Matches `#rngSpeed`'s `max` in index.html. Read from the markup instead? No:
 * `wa-slider.max` is only there once the component has upgraded, and this is
 * constructed alongside it.
 */
const SPEED_MAX = 500;

/**
 * How fast the stick moves the operator's pane at full deflection.
 *
 * Deliberately far quicker than any sane scroll speed: this is for finding a
 * place in the script, not for reading along.
 */
const STICK_MAX_PX_PER_SEC = 2500;

/** Cap on the sub-pixel scroll debt, in pixels. */
const CARRY_LIMIT = 200;

export class GamepadControls {
  #host: GamepadHost;
  #actions = new Map<PadButton, () => void | Promise<void>>();
  #indicator?: Indicator;
  #getGamepads: () => (Gamepad | null)[];
  #requestFrame: (cb: (t: number) => void) => number;
  #cancelFrame: (handle: number) => void;

  #frame = 0;
  /**
   * The previous frame's timestamp, or -1 for "there wasn't one".
   *
   * A sentinel rather than 0, because 0 is a timestamp a first frame can
   * genuinely carry — and testing it for truthiness meant every later frame
   * subtracted from "no previous frame" and integrated no time at all, so the
   * stick moved nothing for the life of the poll.
   */
  #lastTime = -1;
  #held: ReadonlySet<PadButton> = new Set();
  #carry = 0;
  /**
   * Whether the last frame's throttle was off rest.
   *
   * The idle rule turns on this flag: a connected pad nobody is touching must
   * not write the slider at all, or it would broadcast a speed sixty times a
   * second and stamp on the operator the moment they reached for the wheel or
   * Mod+ArrowUp. One trailing write is still needed on release, to put the
   * final zero in — hence a flag rather than a plain `if (throttled)`.
   */
  #wasThrottling = false;

  constructor(
    commands: Command[],
    host: GamepadHost,
    options: GamepadOptions = {},
  ) {
    this.#host = host;
    this.#indicator = options.indicator;
    // Bound to the real navigator, which getGamepads requires as its receiver.
    this.#getGamepads = options.getGamepads ??
      (() => navigator.getGamepads?.() ?? []);
    this.#requestFrame = options.requestFrame ??
      ((cb) => requestAnimationFrame(cb));
    this.#cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));

    // Resolved once, by id, from the same bound table the palette lists. A
    // missing id is a programming error rather than a quiet dead button — the
    // same call buildCommands makes for an action it can't find.
    for (const [button, id] of Object.entries(PAD_BINDINGS)) {
      const command = commands.find((c) => c.id === id);
      if (!command) {
        throw new Error(`pad button ${button} is bound to unknown ${id}`);
      }
      this.#actions.set(button as PadButton, () => command.run());
    }

    const target = options.target ?? globalThis;
    target.addEventListener("gamepadconnected", () => this.#start());
    target.addEventListener("gamepaddisconnected", () => this.#start());
    // A pad already held when the page loaded still has to press a button
    // before Chrome will admit it exists, and that fires the connect event —
    // so there is nothing useful to do here but wait for it.
  }

  /**
   * Begin or re-check the poll.
   *
   * Deliberately the handler for *both* connect and disconnect: either way the
   * question is "is there a pad worth polling now", and asking `getGamepads()`
   * rather than trusting `event.gamepad` answers it correctly when two are
   * plugged in and one leaves.
   */
  #start() {
    const connected = this.#pad() !== null;
    if (this.#indicator) this.#indicator.hidden = !connected;
    if (!connected) {
      if (this.#frame) this.#cancelFrame(this.#frame);
      this.#frame = 0;
      return;
    }
    if (this.#frame) return;
    this.#lastTime = -1;
    this.#frame = this.#requestFrame((t) => this.#poll(t));
  }

  /** The first pad we can read, or null. */
  #pad(): Gamepad | null {
    for (const pad of this.#getGamepads()) {
      if (pad && readPad(pad)) return pad;
    }
    return null;
  }

  #poll(timestamp: number) {
    this.#frame = 0;
    const pad = this.#pad();
    if (!pad) {
      // Unplugged between frames without an event, or the pad stopped
      // reporting a mapping we trust.
      this.#start();
      return;
    }

    const sample = readPad(pad)!;
    const dt = this.#lastTime < 0 ? 0 : timestamp - this.#lastTime;
    this.#lastTime = timestamp;

    this.#applyThrottle(sample.forward, sample.reverse);
    this.#applyStick(sample.stickY, dt);

    for (const button of newlyPressed(this.#held, sample.pressed)) {
      // No typing or dialog guard, unlike the keyboard: a pad cannot be typed
      // into, so there is no focus for it to steal or interfere with.
      this.#actions.get(button)?.();
    }
    this.#held = sample.pressed;

    this.#frame = this.#requestFrame((t) => this.#poll(t));
  }

  #applyThrottle(forward: number, reverse: number) {
    const throttling = forward > 0 || reverse > 0;
    if (!throttling && !this.#wasThrottling) return;
    this.#wasThrottling = throttling;

    // Moved through the slider and its "input" event, never by pushing a
    // settings message directly: the slider is the single source of truth for
    // what the viewers are told, so a pad that bypassed it would leave the
    // control the operator is looking at showing a speed nobody is running.
    this.#host.rngSpeed.value = speedFromTriggers(forward, reverse, SPEED_MAX);
    this.#host.rngSpeed.dispatchEvent(new Event("input"));
  }

  #applyStick(stickY: number, dtMs: number) {
    if (stickY === 0) {
      // Dropped rather than kept: a debt banked from the last flick would
      // start the next one with a jump.
      this.#carry = 0;
      return;
    }
    const wanted = stickScroll(stickY, dtMs, STICK_MAX_PX_PER_SEC) +
      this.#carry;
    const moved = this.#host.scrollOwnPane(wanted);
    this.#carry = nextCarry(wanted, moved, CARRY_LIMIT);
  }
}
