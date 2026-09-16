import { assertEquals } from "@std/assert";

import { ICE_GRACE_MS, ICE_MAX_WAIT_MS, iceRestartDelay } from "./webrtc.ts";

Deno.test("the first attempt waits the grace period, not zero", () => {
  // `disconnected` heals on its own within a second or two — packet loss, a
  // laptop roaming, a phone moving to cellular — so restarting instantly would
  // renegotiate over every blip.
  assertEquals(iceRestartDelay(0), ICE_GRACE_MS);
});

Deno.test("attempts back off, so a display that is gone is not hammered", () => {
  assertEquals(iceRestartDelay(1), ICE_GRACE_MS * 2);
  assertEquals(iceRestartDelay(2), ICE_GRACE_MS * 4);
});

Deno.test("the wait is capped, so a display coming back is not left for minutes", () => {
  // Unbounded in count but bounded in rate: a network that returns after ten
  // minutes should recover, and giving up would leave a black screen in front
  // of the talent with nothing trying to fix it.
  assertEquals(iceRestartDelay(3), ICE_MAX_WAIT_MS);
  assertEquals(iceRestartDelay(50), ICE_MAX_WAIT_MS);
  assertEquals(iceRestartDelay(Number.MAX_SAFE_INTEGER), ICE_MAX_WAIT_MS);
});

Deno.test("a nonsensical attempt count falls back to the grace period", () => {
  // Rather than NaN reaching setTimeout, which fires immediately and would
  // restart ICE in a tight loop.
  assertEquals(iceRestartDelay(NaN), ICE_GRACE_MS);
  assertEquals(iceRestartDelay(-1), ICE_GRACE_MS);
  assertEquals(iceRestartDelay(Infinity), ICE_GRACE_MS);
  assertEquals(iceRestartDelay(1.7), ICE_GRACE_MS * 2);
});
