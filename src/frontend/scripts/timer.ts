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
 * Which of the two things the operator dialled in is what Reset means.
 *
 * `"duration"` is a length — twenty minutes from whenever Reset is pressed.
 * `"target"` is a wall-clock time: Reset works out how far away it is and arms
 * the countdown with *that*, which is why nothing absolute ever reaches the
 * wire. See msUntilTimeOfDay.
 */
export type TimerMode = "duration" | "target";

/**
 * Read an "hh:mm" or "hh:mm:ss" *time of day*.
 *
 * Strict where parseDuration is deliberately tolerant, and the strictness is
 * the difference between the two: a duration field may legitimately hold
 * 99:00:00, ninety-nine hours, while there is no such time of day. An hour
 * above 23 or a minute above 59 is a typo, and reading it as a time would
 * silently roll into another day — which is precisely the bug the old
 * Date-based `parseTimer` had.
 *
 * `null` rather than a throw for anything unreadable, including an empty
 * field: the operator clears the input to retype it, and a countdown that
 * threw while they did would take the page down with it.
 */
export function parseTimeOfDay(
  text: string | null,
): { hours: number; minutes: number; seconds: number } | null {
  if (!text) return null;
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part.trim())) return null;
    values.push(parseInt(part.trim(), 10));
  }
  const [hours, minutes, seconds = 0] = values;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds };
}

/**
 * How long from `now` until the next occurrence of a time of day.
 *
 * This is the one place in the app where building "today at HH:MM:SS" out of a
 * Date is the *right* thing to do, and it is worth saying so because it looks
 * exactly like the mistake the old `parseTimer` made — that one built such a
 * Date and then counted it down as though it were a duration, which is why an
 * hour field above 23 rolled the date over. Here the value really is a time of
 * day, and a local Date is what knows when that time occurs.
 *
 * The result is resolved against the *control page's* clock and travels as a
 * remaining duration, never as the target itself: an epoch stamped here would
 * be read against a display's own clock, and a phone or a Pi that has not
 * reached NTP would show nonsense. See protocol.ts's ClockMessage.
 *
 * A target already past reads negative — the countdown counts up past zero the
 * same way it does at the end of a duration — unless `rollToTomorrow`, which is
 * the operator's setting for "00:30 dialled at 23:00 means ninety minutes".
 * Tomorrow is `setDate(+1)`, not `+ 86_400_000`: across a daylight-saving
 * boundary the same clock time is 23 or 25 hours away, not 24.
 */
export function msUntilTimeOfDay(
  text: string | null,
  now: number,
  rollToTomorrow: boolean,
): number {
  const time = parseTimeOfDay(text);
  if (!time) return 0;
  const target = new Date(now);
  target.setHours(time.hours, time.minutes, time.seconds, 0);
  if (rollToTomorrow && target.getTime() <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now;
}

/**
 * What Reset goes back to: the mode, and the value belonging to that mode.
 *
 * Both are carried whichever mode is live, so switching back and forth doesn't
 * throw away what was dialled into the other one. `targetMs` is the length in
 * the three fields; `targetTime` is the "hh:mm:ss" in the time field.
 */
export interface ResetTarget {
  mode: TimerMode;
  targetMs: number;
  targetTime: string;
}

export const ZERO_TARGET: ResetTarget = {
  mode: "duration",
  targetMs: 0,
  targetTime: "",
};

/**
 * What is written down, which is more than what travels.
 *
 * The reset target is a separate fact from where the countdown has got to.
 * Restoring the running value into the fields instead would quietly change
 * what Reset means: a five-minute countdown refreshed at 4:38 would reset to
 * 4:38 from then on.
 */
interface StoredTimer extends TimerState, ResetTarget {
  /** Epoch milliseconds at the moment of writing. */
  at: number;
}

/** A restored countdown: where it is, and what Reset should return it to. */
export interface RestoredTimer extends TimerState, ResetTarget {}

export function serialiseTimer(
  state: TimerState,
  target: ResetTarget,
  now: number,
): string {
  return JSON.stringify({ ...state, ...target, at: now });
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
  const zero = { ...ZERO_TIMER, ...ZERO_TARGET };
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
  // where the countdown is: better than resetting to zero. The mode and the
  // time field are the same story — a blob from before this existed is a
  // duration countdown, which is what it was.
  const targetMs = typeof stored.targetMs === "number" &&
      Number.isFinite(stored.targetMs)
    ? stored.targetMs
    : Math.max(0, stored.remainingMs);
  const mode: TimerMode = stored.mode === "target" ? "target" : "duration";
  const targetTime = typeof stored.targetTime === "string"
    ? stored.targetTime
    : "";
  const target: ResetTarget = { mode, targetMs, targetTime };
  if (!stored.running) {
    return { running: false, remainingMs: stored.remainingMs, ...target };
  }
  if (typeof stored.at !== "number" || !Number.isFinite(stored.at)) {
    // Running but undatable. Resuming would be a guess at how long ago;
    // holding it where it was is the answer that cannot be wrong by hours.
    return { running: false, remainingMs: stored.remainingMs, ...target };
  }
  // A clock that went backwards (an NTP correction, a suspend) would
  // otherwise *add* time to the countdown.
  const elapsed = Math.max(0, now - stored.at);
  return {
    running: true,
    remainingMs: stored.remainingMs - elapsed,
    ...target,
  };
}
