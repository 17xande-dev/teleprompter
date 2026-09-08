import WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import WaInput from "@awesome.me/webawesome/dist/components/input/input.js";

interface ResetEvent extends CustomEvent {
  detail: {
    time: string;
  };
}

/**
 * Teleprompter countdown clock control component.
 *
 * Usage:
 * <tp-clock-control id="countdowncontrol" countdown="00:00:00"></tp-clock-control>
 */
class TPClockControl extends HTMLElement {
  inHour: WaInput;
  inMinute: WaInput;
  inSecond: WaInput;
  btnStart: WaButton;
  btnStop: WaButton;
  btnReset: WaButton;
  countdown: TPClock;
  // TODO: I think it's best for this component to not be aware of various countdowns.
  // Rather, it should issue an event, which the other clocks can subscribe to.
  popCountdown: TPClock | null = null;

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

    this.btnStart.addEventListener("click", () => {
      const evStart = new CustomEvent("start", {
        detail: {},
        bubbles: false,
        composed: false,
      });
      this.dispatchEvent(evStart);

      this.countdown?.start();
    });

    this.btnStop.addEventListener("click", () => {
      const evStop = new CustomEvent("stop", {
        detail: {},
        bubbles: false,
        composed: false,
      });
      this.dispatchEvent(evStop);
      this.countdown?.stop();
    });

    this.btnReset.addEventListener("click", () => {
      const evReset = new CustomEvent<ResetEvent["detail"]>("reset", {
        detail: { time: this.value() },
        bubbles: false,
        composed: false,
      });
      this.dispatchEvent(evReset);
      this.countdown?.reset(this.value());
    });
  }

  value(): string {
    return `${this.inHour.value}:${this.inMinute.value}:${this.inSecond.value}`;
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
 * <tp-clock type="clock" countdown="01:02:03"></tp-clock>
 * countdown="hh:mm:ss" to countdown from.
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
  // TODO: is this actually a good case for inheritance?
  // Each differenty type of clock having the same methods by slightly different implementations?
  static observedAttributes = ["countdown"];

  // TODO: should this be an enum?
  type: string = "clock";
  // Not `number`: with the deno libs in play setInterval is typed as
  // returning a Timeout. undefined is the "not running" sentinel that -1
  // used to be — same shape themeControls.ts uses for its timer.
  interval: ReturnType<typeof setInterval> | undefined;
  targetDate: Date = new Date();
  negative: boolean = false;

  constructor() {
    super();
  }

  tick() {
    let diff = 1;
    let locStr = this.targetDate.toLocaleTimeString("en-ZA", dateOptions);
    switch (this.type) {
      case "clock":
        this.textContent = new Date().toLocaleTimeString("en-ZA", dateOptions);
        return;
      case "timer":
        if (this.negative) {
          break;
        }
        if (locStr == "00:00:00") {
          this.negative = true;
          this.classList.add("negative");
          break;
        }
        diff = -1;
        break;
    }
    this.targetDate.setSeconds(this.targetDate.getSeconds() + diff);
    if (this.negative) {
      this.textContent = "-";
    } else {
      this.textContent = "";
    }
    // Remove hour zeroes:
    if (this.targetDate.getHours() === 0) {
      locStr = locStr.substring(3);
    }
    this.textContent += locStr;
  }

  start() {
    if (this.interval !== undefined) return;
    this.tick();
    this.interval = setInterval(() => {
      this.tick();
    }, 1000);
  }

  stop() {
    clearInterval(this.interval);
    this.interval = undefined;
  }

  reset(strTime: string | null) {
    this.stop();
    if (strTime) {
      this.setAttribute("timer", strTime);
    }
    this.parseTimer();
  }

  parseTimer() {
    const timer = this.getAttribute("timer");
    if (!timer) {
      throw new Error("timer attribute is required for timer type");
    }
    const [hours, minutes, seconds] = timer.split(":");
    this.targetDate = new Date();
    this.targetDate.setHours(parseInt(hours, 10));
    this.targetDate.setMinutes(parseInt(minutes, 10));
    this.targetDate.setSeconds(parseInt(seconds, 10));
    this.textContent = this.targetDate.toLocaleTimeString("en-ZA", dateOptions);
    this.negative = false;
    this.classList.remove("negative");
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
        this.parseTimer();
        break;
      case "timerUp":
        this.targetDate = new Date(0, 0);
        // this.start()
        break;
      case "countdown":
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

  attributeChangedCallback(name: string, _oldValue: string, _newValue: string) {
    if (this.type === "countdown" && name === "countdown") {
      this.parseTimer();
    }
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

export type { ResetEvent };
