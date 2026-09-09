import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";

import { randomID, type RandomSource } from "./ids.ts";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An insecure origin: getRandomValues, and no randomUUID at all. */
function insecureSource(fill = (i: number) => i): RandomSource {
  return {
    getRandomValues<T extends Uint8Array>(array: T): T {
      for (let i = 0; i < array.length; i++) array[i] = fill(i) & 0xff;
      return array;
    },
  };
}

Deno.test("randomUUID is used when the origin is secure enough to have it", () => {
  let called = 0;
  const source: RandomSource = {
    randomUUID: () => {
      called++;
      return "11111111-2222-4333-8444-555555555555";
    },
    getRandomValues<T extends Uint8Array>(_a: T): T {
      throw new Error("should not have fallen back");
    },
  };
  assertEquals(randomID(source), "11111111-2222-4333-8444-555555555555");
  assertEquals(called, 1);
});

Deno.test("an origin without randomUUID still gets a v4 UUID", () => {
  // The case that mattered: over plain HTTP to anything but localhost,
  // crypto.randomUUID is absent and calling it threw out of the control
  // page's constructor, leaving a dead page.
  assertMatch(randomID(insecureSource()), V4);
});

Deno.test("the fallback stamps the version and variant, not raw bytes", () => {
  // All-zero bytes would give a nil UUID if the fields were not set; all-ones
  // would give an f in both positions. Both must come back as a valid v4, or
  // an id minted on an insecure origin would be distinguishable from — and
  // potentially collide differently to — one minted on a secure one.
  assertMatch(randomID(insecureSource(() => 0x00)), V4);
  assertMatch(randomID(insecureSource(() => 0xff)), V4);
  const zeroed = randomID(insecureSource(() => 0x00));
  assertEquals(zeroed, "00000000-0000-4000-8000-000000000000");
  const ones = randomID(insecureSource(() => 0xff));
  assertEquals(ones, "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

Deno.test("the fallback consumes 16 bytes and uses all of them", () => {
  let asked = 0;
  const source: RandomSource = {
    getRandomValues<T extends Uint8Array>(array: T): T {
      asked = array.length;
      for (let i = 0; i < array.length; i++) array[i] = i;
      return array;
    },
  };
  const id = randomID(source);
  assertEquals(asked, 16);
  // Byte 0 is 0x00 and byte 15 is 0x0f, so both ends of the string are
  // accounted for — a slice that dropped bytes would not show up in the
  // shape test above.
  assert(id.startsWith("00010203"), id);
  assert(id.endsWith("0a0b0c0d0e0f"), id);
});

Deno.test("the fallback does not repeat itself", () => {
  // Sanity, with a real source: the ids are stored and compared, and one that
  // returned a constant would silently make every document the same document.
  const ids = new Set(Array.from({ length: 200 }, () => randomID(crypto)));
  assertEquals(ids.size, 200);
  const insecure: RandomSource = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  };
  const fallbacks = new Set(
    Array.from({ length: 200 }, () => randomID(insecure)),
  );
  assertEquals(fallbacks.size, 200);
  assertNotEquals(randomID(insecure), randomID(insecure));
});
