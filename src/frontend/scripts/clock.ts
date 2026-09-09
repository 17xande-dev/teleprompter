import WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import WaInput from "@awesome.me/webawesome/dist/components/input/input.js";

import {
  formatDuration,
  formatFields,
  parseDuration,
  type TimerState,
  ZERO_TIMER,
} from "./timer.ts";

/**
 * Teleprompter countdown clock control component.
 *
 * Usage:
 * <tp-clock-control id="tpClockControl"></tp-clock-control>
 */
class TPClockControl extends HTMLElement {
  inHour: WaInput;
  inMinute: WaInput;
  inSecond: WaInput;
  btnStart: WaButton;
  btnStop: WaButton;
  btnReset: WaButton;
  countdown: TPClock;

  constructor() {
    // TODO: don't think I need this when extending HTMLElement.
    super();
    // These are actually needed in the Update method, but I'm including them here to prevent a TS error.
    // If there's a better way to do this, do it.
    this.inHour = this.querySelector("#inHour")!;
    this.inMinute = this.querySelector("#inMinute")!;
    this.inSecond = this.querySelector("#inSecond")!;
    this.btnStart = this.querySelector("#btnCountdownStart")!;
    this.btnStop = this.querySelector("#btnCountdownStop")!;
    this.btnReset = this.querySelector("#btnCountdownReset")!;
    this.countdown = this.querySelector("#timeCountdown")!;
  }

  connectedCallback() {
    // TODO: import that html template literal function from the vanilla website.
    // No heading of its own: the card this sits in is titled "Clocks", and
    // the timer's own <h3> read as a second, competing section header.
    this.innerHTML = `
    <div class="wrapper">
    <wa-input id="inHour" type="number" value="00"></wa-input><span>:</span>
    <wa-input id="inMinute" type="number" value="00"></wa-input><span>:</span>
    <wa-input id="inSecond" type="number" value="00"></wa-input>
    </div>
    <div class="timer-transport">
    <wa-button-group label="Timer">
		<wa-button id="btnCountdownReset" size="s" appearance="outlined" value="reset" title="Reset">
    <wa-icon name="clock-rotate-left" label="Reset"></wa-icon>
    </wa-button>
		<wa-button id="btnCountdownStart" size="s" appearance="outlined" value="start" title="Start">
    <wa-icon name="play" label="Start"></wa-icon>
    </wa-button>
		<wa-button id="btnCountdownStop" size="s" appearance="outlined" value="stop" title="Stop">
    <wa-icon name="stop" label="Stop"></wa-icon>
    </wa-button>
    </wa-button-group>
		<tp-clock id="timeCountdown" type="timer" timer="00:00:00"></tp-clock>
    </div>
`;

    this.update();
  }

  disconnectedCallback() {
    throw new Error("not implemented");
  }

  attributeChangedCallback(
    _name: string,
    _oldValue: string,
    _newValue: string,
  ) {
    throw new Error("not implemented");
  }

  update() {
    this.inHour = this.querySelector("#inHour")!;
    this.inMinute = this.querySelector("#inMinute")!;
    this.inSecond = this.querySelector("#inSecond")!;
    this.btnStart = this.querySelector("#btnCountdownStart")!;
    this.btnStop = this.querySelector("#btnCountdownStop")!;
    this.btnReset = this.querySelector("#btnCountdownReset")!;
    this.countdown = this.querySelector("#timeCountdown")!;

    // Each button drives this page's own countdown and then reports where it
    // ended up. Driving it first is deliberate: the state reported is the
    // state that is on screen here, so the operator's copy is the one the
    // displays are told to match rather than a parallel calculation.
    this.btnStart.addEventListener("click", () => {
      this.countdown?.start();
      this.#report();
    });

    this.btnStop.addEventListener("click", () => {
      this.countdown?.stop();
      this.#report();
    });

    this.btnReset.addEventListener("click", () => {
      this.countdown?.reset(this.value());
      this.#report();
    });
  }

  /**
   * The countdown as it is right now.
   *
   * Read from the element rather than cached anywhere, because a cached
   * `remainingMs` is only true at the instant it was taken: handing a
   * 36-second-old "two minutes left" to a display that has just connected
   * starts it two minutes from *now* and it runs that far behind. Measured,
   * and it is the same mistake in miniature that the old command-based
   * protocol made everywhere.
   */
  state(): TimerState {
    return this.countdown?.state() ?? { ...ZERO_TIMER };
  }

  /**
   * Say where the countdown ended up.
   *
   * One `clock` event rather than the `start`/`stop`/`reset` trio this
   * replaces: the three buttons are three ways of reaching the same answer —
   * "here is the countdown now" — and the page listening has one thing to do
   * with it either way. A `start` that carried no duration was why there was
   * nothing to replay to a display that joined late. The detail is carried
   * for a listener that wants it; teleprompter.ts reads the control instead,
   * so what it sends is never a moment old.
   */
  #report() {
    if (!this.countdown) return;
    this.dispatchEvent(
      new CustomEvent<TimerState>("clock", {
        detail: this.state(),
        bubbles: false,
        composed: false,
      }),
    );
  }

  /**
   * Put a countdown back, without reporting it.
   *
   * Silent on purpose: this is how a state restored from storage — or one
   * arriving from anywhere else — is shown here, and reporting it would send
   * the displays a state they are the reason for.
   *
   * `targetMs` fills the three fields and is deliberately not the same number
   * as `remainingMs`: the fields are what Reset goes back to, so putting the
   * running value in them would turn a five-minute countdown refreshed at
   * 4:38 into a 4:38 countdown from then on.
   */
  setState(state: TimerState, targetMs = state.remainingMs) {
    this.countdown?.setState(state);
    const total = Math.max(0, targetMs);
    this.inHour.value = `${Math.floor(total / 3_600_000)}`.padStart(2, "0");
    this.inMinute.value = `${Math.floor(total / 60_000) % 60}`.padStart(2, "0");
    this.inSecond.value = `${Math.floor(total / 1000) % 60}`.padStart(2, "0");
  }

  /** The three fields as "hh:mm:ss", zero-padded — which this never was. */
  value(): string {
    return formatFields(
      this.inHour.value,
      this.inMinute.value,
      this.inSecond.value,
    );
  }
}

function registerClockControlComponent() {
  customElements.define("tp-clock-control", TPClockControl);
}

const dateOptions: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/**
 * Teleprompter clock component.
 *
 * Usage:
 * <tp-clock type="clock"></tp-clock>
 * <tp-clock type="timer" timer="00:05:00"></tp-clock>
 *
 * `timer="hh:mm:ss"` is only the value before anything says otherwise — the
 * countdown is driven by setState from then on. It is *not* observed: the
 * `countdown` attribute that observedAttributes used to watch was read by a
 * `type="countdown"` this app never used, so nothing on that path ever ran.
 *
 * TODO: I think it's best for the control to not be aware of various
 * countdowns. Rather, it should issue an event, which the other clocks can
 * subscribe to. (Half done: the control reports one `clock` event, and
 * teleprompter.ts is what forwards it.)
 *
 * An *autonomous* custom element, and it has to be. This was
 * `<time is="tp-clock">` — a customized built-in — and on WebKit that is
 * silently inert: iOS 18.7 / Safari 26.6 accepts the `define()` call and
 * registers the name (`customElements.get("tp-clock")` is truthy) but never
 * upgrades the elements already in the markup, so `el instanceof TPClock` is
 * false, the element keeps whatever text the HTML gave it, and nothing is
 * logged anywhere. On a phone the wall clock was simply blank and the
 * countdown sat frozen at its markup's 00:00:00. Semantic `<time>` is not
 * worth a component that doesn't run on half the displays it is pointed at.
 */
class TPClock extends HTMLElement {
  // TODO: should this be an enum?
  type: string = "clock";
  // Not `number`: with the deno libs in play setTimeout is typed as returning
  // a Timeout. undefined is the "not running" sentinel that -1 used to be —
  // same shape themeControls.ts uses for its timer, and load-bearing: #run
  // returns early on anything else, and with it defeated a second start
  // stacks a second chain of redraws.
  //
  // A chain of timeouts rather than an interval, and that is the whole reason
  // two copies of one countdown show the same second. An interval fires on
  // whatever phase it was started on, so two copies redraw up to a period
  // apart and a snapshot catches them either side of a boundary — measured at
  // a whole second apart between the operator's countdown and the preview's.
  // Each redraw is instead aimed at the moment the *text* changes, which is
  // derived from the deadline both copies were given, so they land together.
  tickTimer: ReturnType<typeof setTimeout> | undefined;

  // A countdown is a deadline while it runs and a remaining duration while it
  // does not. That is the whole change: it used to be a Date stepped back one
  // second per tick, so the display was the *accumulated* result of every
  // tick that had happened here. Two copies each stepping their own Date off
  // their own interval drift apart with nothing to pull them back — the same
  // hazard teleprompter.ts documents for the scroll pacer — and a copy that
  // missed ticks (a background tab, a throttled window) simply ran slow. Now
  // every tick re-derives from #endsAt, so a copy cannot drift, cannot fall
  // behind, and can be handed to another page as two numbers.
  #endsAt: number | null = null;
  #remainingMs = 0;

  constructor() {
    super();
  }

  /** Milliseconds left, negative once past zero. */
  remaining(): number {
    return this.#endsAt === null
      ? this.#remainingMs
      : this.#endsAt - Date.now();
  }

  /** What this countdown is, in the form that travels and is stored. */
  state(): TimerState {
    return { running: this.#endsAt !== null, remainingMs: this.remaining() };
  }

  tick() {
    if (this.type === "clock") {
      this.textContent = new Date().toLocaleTimeString("en-ZA", dateOptions);
      return;
    }
    const remaining = this.remaining();
    this.textContent = formatDuration(remaining);
    // Read off the value rather than latched in a boolean, so it is correct
    // after a reset from a negative countdown without anything having to
    // remember to clear it.
    this.classList.toggle("negative", remaining < 0);
  }

  start() {
    if (this.type === "clock") {
      this.#run();
      return;
    }
    if (this.#endsAt !== null) return;
    this.#endsAt = Date.now() + this.#remainingMs;
    this.#run();
  }

  stop() {
    // Freeze where it actually is, not where it was armed: this is what makes
    // stop/start a pause rather than a restart.
    if (this.#endsAt !== null) this.#remainingMs = this.remaining();
    this.#endsAt = null;
    this.#halt();
    this.tick();
  }

  reset(strTime: string | null) {
    this.setState({ running: false, remainingMs: parseDuration(strTime) });
  }

  /**
   * Show a countdown someone else is authoritative about.
   *
   * The receiving end of the wire, and of a restore from storage. The
   * duration is anchored to *this* machine's clock on arrival, which is why
   * the message carries a remaining time rather than an absolute deadline: an
   * epoch from the control page would be read against a display's own clock,
   * and a phone or a Pi that has not reached NTP yet would show nonsense.
   * Transit is milliseconds, so the anchoring costs nothing measurable.
   */
  setState(state: TimerState) {
    this.#halt();
    if (state.running) {
      this.#endsAt = Date.now() + state.remainingMs;
      this.#run();
    } else {
      this.#endsAt = null;
      this.#remainingMs = state.remainingMs;
    }
    this.tick();
  }

  #halt() {
    clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
  }

  /** Redraw now, and again each time the displayed value is due to change. */
  #run() {
    if (this.tickTimer !== undefined) return;
    const step = () => {
      this.tick();
      this.tickTimer = setTimeout(step, this.#msToNextChange());
    };
    step();
  }

  /**
   * How long until the text this shows would change.
   *
   * The ticks only redraw the countdown — they no longer *are* it — so the
   * right moment to redraw is the moment the value turns over, and every copy
   * of one countdown computes that from the same deadline and so redraws
   * together. A few milliseconds late on purpose: firing exactly on the
   * boundary can land a hair before it and redraw the same text twice, which
   * would then wait a whole second for the next change.
   */
  #msToNextChange(): number {
    // The wall clock turns over on the second, not on the phase it happened
    // to be started on — so two of these agree as well.
    if (this.type === "clock") return 1000 - (Date.now() % 1000) + 5;
    // formatDuration rounds up in absolute value, so the text changes when
    // the remainder to the next whole second runs out. Modulo written to be
    // right for a negative remaining too, which is a countdown past zero.
    const mod = ((this.remaining() % 1000) + 1000) % 1000;
    return (mod === 0 ? 1000 : mod) + 5;
  }

  connectedCallback() {
    const clockType = this.getAttribute("type");
    if (!clockType) {
      throw Error("type attribute is required");
    }
    this.type = clockType;
    switch (clockType) {
      case "clock":
        this.start();
        break;
      case "timer":
        // The markup's `timer` attribute is the value before anyone says
        // otherwise, which for a display is what it shows until the
        // controller's catch-up arrives.
        this.setState({
          running: false,
          remainingMs: parseDuration(this.getAttribute("timer")),
        });
        break;
      default:
        throw new Error(`Unknown clock type: ${clockType}`);
    }
  }

  disconnectedCallback() {
    this.stop();
  }

  adoptedCallback() {
    throw new Error("Not implemented");
  }
}

function registerClockComponent() {
  // No `{ extends: "time" }` — see the note on TPClock. A definition WebKit
  // accepts and then ignores is worse than one it rejects.
  customElements.define("tp-clock", TPClock);
}

export {
  registerClockComponent,
  registerClockControlComponent,
  TPClock,
  TPClockControl,
};
