// The countdown's arithmetic and its stored form, with no DOM in sight.
//
// Split out of clock.ts for the reason textscale.ts is split out of
// teleprompter.ts — and here it is not merely tidier: clock.ts imports Web
// Awesome components, which `deno test` cannot resolve, so anything left in
// there is untestable by construction. TPClock had no tests at all.
//
// The shape these functions describe is the fix for the timer that restarted
// on every reload. A countdown used to be a Date stepped back one second per
// interval tick, which meant the running state existed *only* as a live
// setInterval in whichever page happened to be running it: nothing to send a
// display that joined late, nothing to write down before a reload, and N
// copies each drifting off their own clock with nothing to pull them back.
// State is a remaining duration instead, which every copy renders from.

/** A countdown, as it travels and as it is stored. */
export interface TimerState {
  running: boolean;
  /** Milliseconds left. Negative once the countdown is past zero. */
  remainingMs: number;
}

export const ZERO_TIMER: TimerState = { running: false, remainingMs: 0 };

/**
 * Read an "hh:mm:ss" duration as milliseconds.
 *
 * A duration, not a time of day — which is what this replaces. `parseTimer`
 * built "today at HH:MM:SS" and counted the Date down, so an hour field above
 * 23 rolled the date over and the countdown came out wrong by however far it
 * had rolled. Fields are summed here, so 99:00:00 is ninety-nine hours.
 *
 * Tolerant of missing and malformed fields — the three inputs it reads are
 * `type="number"` and can be empty, and a countdown that throws while the
 * operator is clearing a field would take the page down with it.
 */
export function parseDuration(text: string | null): number {
  if (!text) return 0;
  const parts = text.split(":");
  if (parts.length > 3) return 0;
  // Right-aligned, so "90" is ninety seconds and "1:30" is a minute and a
  // half: an operator typing a short countdown means the small unit.
  const units = [1000, 60_000, 3_600_000];
  let total = 0;
  for (const [i, part] of parts.reverse().entries()) {
    const value = parseInt(part.trim(), 10);
    if (Number.isNaN(value)) continue;
    total += value * units[i];
  }
  return total;
}

/**
 * Format a duration as the display reads it: "m:ss", "h:mm:ss", "-m:ss".
 *
 * The hour field is dropped when there is none, which is what the old code did
 * by taking a substring of a locale time string — a route that only worked
 * because the value was a Date, and only for durations under a day.
 *
 * Rounds *up* in absolute value, so a countdown started at thirty seconds
 * reads 0:30 rather than flicking straight to 0:29: the last whole second is
 * still to come. Past zero the same rule counts up from -0:01.
 */
export function formatDuration(ms: number): string {
  const negative = ms < 0;
  const total = Math.ceil(Math.abs(ms) / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => `${n}`.padStart(2, "0");
  const body = hours
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
  return negative ? `-${body}` : body;
}

/** "hh:mm:ss" from three fields, zero-padded — which `value()` never was. */
export function formatFields(
  hours: string | null,
  minutes: string | null,
  seconds: string | null,
) {
  const pad = (v: string | null) =>
    `${parseInt(v ?? "", 10) || 0}`.padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * What is written down, which is more than what travels.
 *
 * `targetMs` is the length the operator dialled into the three fields — what
 * Reset goes back to — and it is a separate fact from where the countdown has
 * got to. Restoring the running value into those fields instead would quietly
 * change what Reset means: a five-minute countdown refreshed at 4:38 would
 * reset to 4:38 from then on.
 */
interface StoredTimer extends TimerState {
  /** Epoch milliseconds at the moment of writing. */
  at: number;
  targetMs: number;
}

/** A restored countdown: where it is, and what Reset should return it to. */
export interface RestoredTimer extends TimerState {
  targetMs: number;
}

export function serialiseTimer(
  state: TimerState,
  targetMs: number,
  now: number,
): string {
  return JSON.stringify({ ...state, targetMs, at: now });
}

/**
 * Read a stored countdown back, aged by however long the page was away.
 *
 * The ageing is the whole point and the reason `at` is stored: a countdown
 * that was running when the operator refreshed has to come back where it
 * would have been, not where it was left. A stopped one is untouched by
 * time — that is what stopped means.
 *
 * Tolerant in the same shape as parseSettings and parseThemes: a hand-edited
 * value or one written by another build gives a zeroed countdown rather than
 * throwing out of page load.
 */
export function parseTimer(raw: string | null, now: number): RestoredTimer {
  const zero = { ...ZERO_TIMER, targetMs: 0 };
  if (!raw) return zero;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return zero;
  }
  if (!parsed || typeof parsed !== "object") return zero;
  const stored = <Partial<StoredTimer>> parsed;
  if (
    typeof stored.running !== "boolean" ||
    typeof stored.remainingMs !== "number" ||
    !Number.isFinite(stored.remainingMs)
  ) {
    return zero;
  }
  // A target written by an older build, or hand-edited away, falls back to
  // where the countdown is: better than resetting to zero.
  const targetMs = typeof stored.targetMs === "number" &&
      Number.isFinite(stored.targetMs)
    ? stored.targetMs
    : Math.max(0, stored.remainingMs);
  if (!stored.running) {
    return { running: false, remainingMs: stored.remainingMs, targetMs };
  }
  if (typeof stored.at !== "number" || !Number.isFinite(stored.at)) {
    // Running but undatable. Resuming would be a guess at how long ago;
    // holding it where it was is the answer that cannot be wrong by hours.
    return { running: false, remainingMs: stored.remainingMs, targetMs };
  }
  // A clock that went backwards (an NTP correction, a suspend) would
  // otherwise *add* time to the countdown.
  const elapsed = Math.max(0, now - stored.at);
  return {
    running: true,
    remainingMs: stored.remainingMs - elapsed,
    targetMs,
  };
}
