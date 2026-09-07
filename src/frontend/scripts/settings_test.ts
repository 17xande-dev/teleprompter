// No DOM: SettingsStorage takes its Storage, so the tolerance of the parser and
// the sign of the wheel can both be checked without a browser.
import { assertEquals, assertFalse } from "@std/assert";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  SettingsStorage,
  type SettingsStore,
  wheelStep,
} from "./settings.ts";

function fakeStore(initial: Record<string, string> = {}): SettingsStore & {
  items: Record<string, string>;
} {
  const items = { ...initial };
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
    },
  };
}

Deno.test("nothing stored means the defaults", () => {
  assertEquals(parseSettings(null), DEFAULT_SETTINGS);
  assertEquals(parseSettings(""), DEFAULT_SETTINGS);
});

Deno.test("unusable stored settings fall back rather than throwing", () => {
  // A hand-edited value, or a key written by another build. Every one of these
  // used to be a way to throw out of page load in doc.ts, which is the lesson
  // this shape exists for.
  assertEquals(parseSettings("{"), DEFAULT_SETTINGS);
  assertEquals(parseSettings("null"), DEFAULT_SETTINGS);
  assertEquals(parseSettings("42"), DEFAULT_SETTINGS);
  assertEquals(parseSettings('"invertWheel"'), DEFAULT_SETTINGS);
  // Right key, wrong type: dropped, not coerced. "false" as a string would
  // otherwise read as true.
  assertEquals(parseSettings('{"invertWheel":"false"}'), DEFAULT_SETTINGS);
});

Deno.test("an unknown key doesn't take the rest of the settings with it", () => {
  assertEquals(parseSettings('{"invertWheel":true,"colour":"puce"}'), {
    invertWheel: true,
  });
});

Deno.test("a setting is persisted by the mutator that changes it", () => {
  const store = fakeStore();
  const settings = new SettingsStorage(store);
  assertFalse(settings.invertWheel);

  settings.invertWheel = true;
  assertEquals(settings.invertWheel, true);
  // And it comes back, which is the only reason the write matters.
  assertEquals(new SettingsStorage(store).invertWheel, true);
});

Deno.test("storage that throws is not fatal in either direction", () => {
  const hostile: SettingsStore = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  const settings = new SettingsStorage(hostile);
  assertEquals(settings.all(), DEFAULT_SETTINGS);
  settings.invertWheel = true;
  // Held in memory for this session even though it could not be written.
  assertEquals(settings.invertWheel, true);
});

Deno.test("the wheel's sign is the setting, and nothing else", () => {
  // The default has the thumb follow the scroll on a naturally-scrolling
  // system; inverting flips it for everyone else. Asserted because a sign is
  // the one thing here that looks identical when it is backwards.
  assertEquals(wheelStep(120, false), 120);
  assertEquals(wheelStep(120, true), -120);
  assertEquals(wheelStep(-120, false), -120);
  assertEquals(wheelStep(-120, true), 120);
  // No deflection either way when the wheel didn't move.
  assertEquals(wheelStep(0, false), 0);
});

Deno.test("all() hands out a copy, not the stored object", () => {
  const settings = new SettingsStorage(fakeStore());
  const snapshot = settings.all();
  snapshot.invertWheel = true;
  assertFalse(settings.invertWheel);
});
