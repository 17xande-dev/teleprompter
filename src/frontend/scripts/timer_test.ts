import { assertEquals } from "@std/assert";

import {
  formatDuration,
  formatFields,
  parseDuration,
  parseTimer,
  serialiseTimer,
  ZERO_TIMER,
} from "./timer.ts";

Deno.test("a duration is summed, not read as a time of day", () => {
  assertEquals(parseDuration("00:00:30"), 30_000);
  assertEquals(parseDuration("00:05:00"), 300_000);
  assertEquals(parseDuration("01:00:00"), 3_600_000);
  // The regression this exists for: the old parseTimer set these fields on a
  // Date, so anything past 23 rolled over into the next day and the countdown
  // came out short by however far it rolled.
  assertEquals(parseDuration("99:00:00"), 99 * 3_600_000);
  assertEquals(parseDuration("00:90:00"), 90 * 60_000);
});

Deno.test("a short duration means the small unit", () => {
  // Right-aligned, so an operator typing "90" gets ninety seconds rather than
  // ninety hours.
  assertEquals(parseDuration("90"), 90_000);
  assertEquals(parseDuration("1:30"), 90_000);
});

Deno.test("a malformed duration is zero, not a throw", () => {
  // These reach the parser from three empty-able number inputs, and a
  // countdown that threw while a field was being cleared would take the page
  // with it.
  assertEquals(parseDuration(null), 0);
  assertEquals(parseDuration(""), 0);
  assertEquals(parseDuration("::"), 0);
  assertEquals(parseDuration("aa:bb:cc"), 0);
  assertEquals(parseDuration("1:2:3:4"), 0);
  // A missing field is skipped rather than poisoning the sum.
  assertEquals(parseDuration("00::30"), 30_000);
});

Deno.test("the display rounds up, so a countdown starts at its own value", () => {
  // 30_000 must read 0:30, not 0:29: the last whole second has not gone yet.
  assertEquals(formatDuration(30_000), "0:30");
  assertEquals(formatDuration(29_999), "0:30");
  assertEquals(formatDuration(29_001), "0:30");
  assertEquals(formatDuration(29_000), "0:29");
});

Deno.test("the hour field appears only when there are hours", () => {
  assertEquals(formatDuration(0), "0:00");
  assertEquals(formatDuration(65_000), "1:05");
  assertEquals(formatDuration(3_600_000), "1:00:00");
  assertEquals(formatDuration(99 * 3_600_000), "99:00:00");
});

Deno.test("past zero counts up with a sign", () => {
  assertEquals(formatDuration(-1), "-0:01");
  assertEquals(formatDuration(-1000), "-0:01");
  assertEquals(formatDuration(-61_000), "-1:01");
});

Deno.test("the three fields are zero-padded on the way out", () => {
  // value() used to concatenate the inputs raw, so a single-digit field
  // produced "0:5:0" — which the old date-based parser then read as 05:00.
  assertEquals(formatFields("0", "5", "0"), "00:05:00");
  assertEquals(formatFields("", "", ""), "00:00:00");
  assertEquals(formatFields("01", "30", "00"), "01:30:00");
});

const ZERO_RESTORED = { ...ZERO_TIMER, targetMs: 0 };

Deno.test("a running countdown comes back aged by the time away", () => {
  // The bug this is the fix for: a display or the control page reloading put
  // the countdown back to where it was written, so a timer "resumed" minutes
  // behind — or, on a display, at 00:00:00, because nothing was written at
  // all.
  const raw = serialiseTimer(
    { running: true, remainingMs: 30_000 },
    60_000,
    1000,
  );
  assertEquals(parseTimer(raw, 1000), {
    running: true,
    remainingMs: 30_000,
    targetMs: 60_000,
  });
  assertEquals(parseTimer(raw, 6000), {
    running: true,
    remainingMs: 25_000,
    targetMs: 60_000,
  });
  // And it keeps running past zero rather than clamping.
  assertEquals(parseTimer(raw, 41_000), {
    running: true,
    remainingMs: -10_000,
    targetMs: 60_000,
  });
});

Deno.test("the reset target survives independently of the countdown", () => {
  // A five-minute countdown refreshed at 4:38 must still reset to 5:00. The
  // fields are what Reset means, so restoring the *running* value into them
  // would silently redefine it.
  const raw = serialiseTimer(
    { running: true, remainingMs: 278_000 },
    300_000,
    1000,
  );
  const restored = parseTimer(raw, 1000);
  assertEquals(restored.remainingMs, 278_000);
  assertEquals(restored.targetMs, 300_000);
});

Deno.test("a target written by an older build falls back to the countdown", () => {
  // Rather than to zero, which would make Reset useless after an upgrade.
  assertEquals(
    parseTimer('{"running":false,"remainingMs":30000}', 0).targetMs,
    30_000,
  );
  // Never negative, even from a countdown stored past zero.
  assertEquals(
    parseTimer('{"running":false,"remainingMs":-5000}', 0).targetMs,
    0,
  );
});

Deno.test("a stopped countdown is not aged", () => {
  const raw = serialiseTimer(
    { running: false, remainingMs: 30_000 },
    60_000,
    1000,
  );
  assertEquals(parseTimer(raw, 999_000), {
    running: false,
    remainingMs: 30_000,
    targetMs: 60_000,
  });
});

Deno.test("a clock that went backwards does not add time", () => {
  // An NTP correction or a resume from suspend can put `now` before `at`.
  // Unclamped that elapsed would be negative and *lengthen* the countdown.
  const raw = serialiseTimer(
    { running: true, remainingMs: 30_000 },
    60_000,
    5000,
  );
  assertEquals(parseTimer(raw, 1000), {
    running: true,
    remainingMs: 30_000,
    targetMs: 60_000,
  });
});

Deno.test("unusable stored state gives a zeroed countdown, not a throw", () => {
  assertEquals(parseTimer(null, 0), ZERO_RESTORED);
  assertEquals(parseTimer("{", 0), ZERO_RESTORED);
  assertEquals(parseTimer("null", 0), ZERO_RESTORED);
  assertEquals(parseTimer("42", 0), ZERO_RESTORED);
  assertEquals(parseTimer('{"running":true}', 0), ZERO_RESTORED);
  assertEquals(parseTimer('{"remainingMs":30000}', 0), ZERO_RESTORED);
  // Right keys, wrong types.
  assertEquals(
    parseTimer('{"running":"yes","remainingMs":1}', 0),
    ZERO_RESTORED,
  );
  assertEquals(
    parseTimer('{"running":true,"remainingMs":null}', 0),
    ZERO_RESTORED,
  );
});

Deno.test("running but undatable is held rather than guessed at", () => {
  // No `at` means there is no telling how long ago this was; resuming would
  // be a guess that can be wrong by hours, so it comes back stopped where it
  // was left and the operator decides.
  assertEquals(parseTimer('{"running":true,"remainingMs":30000}', 9999), {
    running: false,
    remainingMs: 30_000,
    targetMs: 30_000,
  });
});
