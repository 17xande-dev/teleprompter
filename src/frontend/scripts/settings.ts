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
};

export const DEFAULT_SETTINGS: Settings = {
  invertWheel: false,
  liveEditing: true,
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
    if (typeof source[key] === typeof DEFAULT_SETTINGS[key]) {
      settings[key] = <boolean> source[key];
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
