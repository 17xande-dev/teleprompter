// The operator's own preferences for how this page behaves — not show state,
// and nothing a viewer ever hears about.
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
   * Which way a wheel over a slider moves its thumb.
   *
   * There is no correct default, only a common one: whether a scroll away from
   * the operator arrives as a positive or a negative `deltaY` is decided by the
   * pointing device and the "natural scrolling" setting above the browser, and
   * the page cannot see either. So the default is the direction that matches a
   * system scrolling naturally (thumb follows the fingers), and this flips it
   * for everyone else — which is the whole reason it is a setting and not a
   * constant someone has to be right about.
   */
  invertWheel: boolean;
};

export const DEFAULT_SETTINGS: Settings = { invertWheel: false };

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
 */
export function wheelStep(deltaY: number, invertWheel: boolean): number {
  return invertWheel ? -deltaY : deltaY;
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
    try {
      this.#store.setItem(SETTINGS_KEY, JSON.stringify(this.#settings));
    } catch (err) {
      // Over quota, or storage blocked. In-memory state stands: the setting
      // holds for this session and is simply forgotten on reload.
      console.warn(`could not persist ${SETTINGS_KEY}`, err);
    }
  }
}
