// The operator's own preferences for how this page behaves, remembered for
// this browser.
//
// One of them, `liveEditing`, does decide whether something reaches a viewer,
// which the rest of this file deliberately does not — see its own note for
// why it is remembered anyway.
//
// DOM-free, and the Storage is injected, the same split as doc.ts / themes.ts
// against docControls.ts / themeControls.ts: settingsControls.ts owns the
// dialog, this owns what is remembered and the one piece of arithmetic that
// depends on it.

// The slice of localStorage this needs, injected so tests can hand it a plain
// object instead of a real Storage.
export interface SettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SETTINGS_KEY = "teleprompter.settings";

export type Settings = {
  /**
   * Whether the wheel moves a slider's thumb the opposite way to the default.
   *
   * "Opposite to the default", not "opposite to down": which physical direction
   * a `deltaY` stands for is decided by the pointing device and the "natural
   * scrolling" preference above the browser, and the page can see neither. So
   * the switch is defined against what this build ships, which is the direction
   * a conventional mouse wheel wants, and the operator flips it if their setup
   * disagrees. Default `false` so a fresh page has every switch off.
   */
  invertWheel: boolean;
  /**
   * Whether an edit goes out to the displays as it is typed.
   *
   * Off is how an operator opens another document, fixes a typo three pages
   * ahead or pastes in a late change without any of it appearing in front of
   * the talent; `pushContent` is then the deliberate "show it now".
   *
   * Remembered, unlike a piece of show state, because an operator who works
   * with it off wants it off — and the cost of remembering is bounded by
   * saying so loudly: the app bar carries an indicator whenever the displays
   * are not tracking the editor, so a reload cannot come back quietly not
   * live. Default true, so a fresh browser behaves the way the app always
   * has.
   */
  liveEditing: boolean;
  /**
   * Whether scrolling the preview scrolls the audience.
   *
   * Off by default because the preview sits in the operator's sidebar under
   * their pointer: armed, a wheel that drifts over it while they were reaching
   * for a slider jogs every display mid-service. On, it is the fastest way to
   * put the talent on a line — the gesture behaves like hand-scrolling the
   * driver display, and the pacer carries on from wherever it is let go.
   *
   * Remembered, like the two above, which is why the preview shows plainly
   * when it is armed rather than leaving that to a switch inside a dialog.
   */
  previewScrub: boolean;
  /**
   * Whether a countdown target time that has already passed means tomorrow.
   *
   * Only consulted by the countdown's "time of day" mode, and only at the
   * moment Reset is pressed. Default false: a target in the past counts *up*
   * past zero, which is what the countdown already does at the end of a
   * duration and is honest about a moment that has gone — a service that
   * started at 10:00 is four minutes late, not twenty-three hours and
   * fifty-six minutes early. On, "00:30" dialled at 23:00 is ninety minutes
   * away, which is the late-night case the switch exists for.
   */
  rollTargetToTomorrow: boolean;
  /**
   * Whether a wheel scrub over the preview eases, rather than jumping.
   *
   * The two positions are for two kinds of pointing device, which is why this
   * is a setting rather than a constant someone has to be right about. A cheap
   * mouse reports one coarse notch at a time — a hundred-odd pixels, or three
   * whole lines — and forwarded whole that moves every display in a single
   * jolt. A good trackpad or a high-resolution wheel already sends a stream of
   * small deltas, which is smooth on its own, and easing it only adds lag.
   *
   * On, a notch is spent over a shrinking series of frames and capped per
   * frame, so several notches in quick succession blend into continuous motion
   * instead of a staccato of jumps — see scrubStep, whose constants were
   * retuned after the first attempt still read as jumpy on exactly the cheap
   * Windows mouse this exists for.
   *
   * Default on, because the jump is not a behaviour anyone would choose; it is
   * what the code happened to do.
   *
   * Only the wheel is eased. A drag is direct manipulation and has to track
   * the finger, so easing it would add lag to the one gesture that must not
   * have any.
   */
  smoothScrub: boolean;
  /**
   * Whether a paste is recoloured to read on a dark screen.
   *
   * A script copied out of Word, Docs or a web page is black on white. This
   * page and every display are dark unconditionally, so pasted as authored it
   * is black text on black. On, the colours are rewritten on the way in: greys
   * lose their colour entirely so they follow --viewer-color and any user
   * theme, and a saturated hue keeps its hue and has its lightness raised
   * until it clears 4.5:1 against black — so red stays red and green stays
   * green instead of everything becoming white.
   *
   * Default true, unlike every switch here except liveEditing. Off is not a
   * preference anyone holds: there is no light mode for a pasted white page to
   * be correct against, so unaltered it is unreadable by construction. It is
   * worth knowing that this is destructive in a way a render-time filter would
   * not be — what the paste discards is gone from the document rather than
   * merely overridden — which is why the switch exists at all. Two escape
   * hatches already cover it: the editor's own undo, and Ctrl+Shift+V, which
   * pastes plain text and so carries no colour to correct.
   */
  brightenPastedText: boolean;
  /**
   * The colour "repeat last colour" applies, by id from colours.ts.
   *
   * The one setting here that is not a switch, and the one that is not really
   * a preference either — it is the operator's *last action*, kept so the
   * shortcut survives a reload the way Notion's own repeat-colour does.
   * Validated where it is used rather than here: settings.ts has no business
   * knowing the palette, and an id this build no longer ships should fall back
   * to a usable colour rather than silently applying nothing.
   */
  lastColourID: string;
};

export const DEFAULT_SETTINGS: Settings = {
  invertWheel: false,
  liveEditing: true,
  previewScrub: false,
  rollTargetToTomorrow: false,
  smoothScrub: true,
  brightenPastedText: true,
  lastColourID: "yellow",
};

/**
 * Read stored settings, dropping anything that isn't the shape it should be.
 *
 * Tolerant per key rather than all-or-nothing, like parseThemes: a single
 * unrecognised or mistyped entry — a hand-edited value, or a key this build no
 * longer has — must not throw away the rest of the operator's preferences, and
 * must not throw out of page load.
 */
export function parseSettings(raw: string | null): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw) return settings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!parsed || typeof parsed !== "object") return settings;
  const source = <Record<string, unknown>> parsed;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    // Still one typeof test per key, so a mistyped entry is dropped on its
    // own — it just no longer assumes every setting is a boolean.
    if (typeof source[key] === typeof DEFAULT_SETTINGS[key]) {
      (<Record<string, unknown>> settings)[key] = source[key];
    }
  }
  return settings;
}

/**
 * How far a wheel event moves a slider's value.
 *
 * One function for all three sliders, because the direction is one decision:
 * the speed slider is geometrically inverted (Forward at the bottom, see
 * teleprompter.ts) but that inversion is already in what "up" means for its
 * value, so nothing here needs to know which slider it is. Callers scale the
 * result for their own range; the sign is this function's business.
 *
 * The default subtracts: a conventional mouse wheel reports a scroll away from
 * the operator as a positive `deltaY`, and that should walk the thumb *down*
 * the track. A trackpad set to scroll naturally reports the opposite sign for
 * the same gesture, which is what the setting is for.
 */
export function wheelStep(deltaY: number, invertWheel: boolean): number {
  return invertWheel ? deltaY : -deltaY;
}

export class SettingsStorage {
  #store: SettingsStore;
  #settings: Settings;

  constructor(store: SettingsStore = localStorage) {
    this.#store = store;
    let raw: string | null = null;
    try {
      raw = this.#store.getItem(SETTINGS_KEY);
    } catch {
      // Private mode or blocked storage: run on the defaults rather than
      // failing the page load.
    }
    this.#settings = parseSettings(raw);
  }

  /** A copy, so a caller cannot mutate stored state without persisting it. */
  all(): Settings {
    return { ...this.#settings };
  }

  get invertWheel(): boolean {
    return this.#settings.invertWheel;
  }

  /** Saving happens in the mutator, so nothing can change a setting silently. */
  set invertWheel(value: boolean) {
    this.#settings.invertWheel = value;
    this.#save();
  }

  get liveEditing(): boolean {
    return this.#settings.liveEditing;
  }

  set liveEditing(value: boolean) {
    this.#settings.liveEditing = value;
    this.#save();
  }

  get previewScrub(): boolean {
    return this.#settings.previewScrub;
  }

  set previewScrub(value: boolean) {
    this.#settings.previewScrub = value;
    this.#save();
  }

  get rollTargetToTomorrow(): boolean {
    return this.#settings.rollTargetToTomorrow;
  }

  set rollTargetToTomorrow(value: boolean) {
    this.#settings.rollTargetToTomorrow = value;
    this.#save();
  }

  get smoothScrub(): boolean {
    return this.#settings.smoothScrub;
  }

  set smoothScrub(value: boolean) {
    this.#settings.smoothScrub = value;
    this.#save();
  }

  get lastColourID(): string {
    return this.#settings.lastColourID;
  }

  set lastColourID(value: string) {
    this.#settings.lastColourID = value;
    this.#save();
  }

  get brightenPastedText(): boolean {
    return this.#settings.brightenPastedText;
  }

  set brightenPastedText(value: boolean) {
    this.#settings.brightenPastedText = value;
    this.#save();
  }

  #save() {
    try {
      this.#store.setItem(SETTINGS_KEY, JSON.stringify(this.#settings));
    } catch (err) {
      // Over quota, or storage blocked. In-memory state stands: the setting
      // holds for this session and is simply forgotten on reload.
      console.warn(`could not persist ${SETTINGS_KEY}`, err);
    }
  }
}
