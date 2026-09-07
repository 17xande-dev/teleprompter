// No DOM here — themes.ts is deliberately storage-and-validation only, and
// ThemeStorage takes its Storage as a constructor argument so these can hand
// it a plain object.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  BUILTIN_LAYOUTS,
  DEFAULT_LAYOUT,
  findThemeCssProblems,
  parseThemes,
  type ThemeStore,
  ThemeStorage,
  themeSlug,
  uniqueSlug,
} from "./themes.ts";

function fakeStore(seed: Record<string, string> = {}): ThemeStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** A store whose writes always fail, like one over quota or in private mode. */
function readOnlyStore(seed: Record<string, string> = {}): ThemeStore {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
    removeItem: () => {},
  };
}

Deno.test("a stored theme survives a round trip through storage", () => {
  const store = fakeStore();
  const slug = new ThemeStorage(store).create("Sunday Morning", "body{}");

  const reopened = new ThemeStorage(store);
  assertEquals(reopened.get(slug), { name: "Sunday Morning", css: "body{}" });
  assertEquals(reopened.list().length, 1);
});

Deno.test("a slug can never collide with a built-in layout", () => {
  // The prefix is what guarantees this: a user theme called "default" must not
  // end up wearing theme-default and silently inheriting the bundled rules it
  // is supposed to replace.
  for (const name of ["default", "big clock", "Big-Clock", "theme default"]) {
    assert(
      !BUILTIN_LAYOUTS.includes(themeSlug(name)),
      `${name} slugged to a built-in layout`,
    );
  }
});

Deno.test("a name that kebabs to nothing still yields a distinct slug", () => {
  // "!!!" and "???" both reduce to an empty kebab; without the fallback plus
  // the uniqueness pass they would be the same class name.
  const a = uniqueSlug("!!!", []);
  const b = uniqueSlug("???", [a]);
  assert(a.length > "theme-user-".length, `bare prefix slug: ${a}`);
  assert(a !== b, "two unnameable themes collided");
});

Deno.test("a duplicate name gets its own slug rather than overwriting", () => {
  const storage = new ThemeStorage(fakeStore());
  const first = storage.create("Advent", "a{}");
  const second = storage.create("Advent", "b{}");

  assert(first !== second);
  assertEquals(storage.get(first)?.css, "a{}");
  assertEquals(storage.get(second)?.css, "b{}");
});

Deno.test("corrupt stored themes yield an empty map, not an exception", () => {
  // The failure this guards against is not cosmetic: throwing here would
  // throw out of the control page's constructor and leave no page at all.
  assertEquals(parseThemes("}{not json"), {});
  assertEquals(parseThemes(null), {});
  assertEquals(parseThemes("[]"), {});
  assertEquals(parseThemes('"a string"'), {});
});

Deno.test("one malformed theme doesn't cost the operator the others", () => {
  const raw = JSON.stringify({
    "theme-user-good": { name: "Good", css: "a{}" },
    "theme-user-nocss": { name: "No CSS" },
    "theme-user-null": null,
    "not-prefixed": { name: "Bad slug", css: "b{}" },
  });
  assertEquals(parseThemes(raw), {
    "theme-user-good": { name: "Good", css: "a{}" },
  });
});

Deno.test("a store that cannot be written leaves in-memory state intact", () => {
  const storage = new ThemeStorage(readOnlyStore());
  const slug = storage.create("Ephemeral", "a{}");
  // Reverting the edit under the operator's hands would be worse than losing
  // it on reload, so create() must still report success in memory.
  assertEquals(storage.get(slug)?.css, "a{}");
  storage.setLayout(slug);
  assertEquals(storage.getLayout(), slug);
});

Deno.test("a layout naming a deleted theme falls back to the default", () => {
  const store = fakeStore({
    "teleprompter.themes": "{}",
    "teleprompter.layout": "theme-user-gone",
  });
  assertEquals(new ThemeStorage(store).getLayout(), DEFAULT_LAYOUT);
});

Deno.test("deleting the active theme falls back to the default", () => {
  const storage = new ThemeStorage(fakeStore());
  const slug = storage.create("Doomed", "a{}");
  storage.setLayout(slug);
  storage.remove(slug);
  assertEquals(storage.getLayout(), DEFAULT_LAYOUT);
});

Deno.test("a built-in layout is a valid stored layout", () => {
  const store = fakeStore({ "teleprompter.layout": "theme-big-clock" });
  assertEquals(new ThemeStorage(store).getLayout(), "theme-big-clock");
});

Deno.test("renaming keeps the slug, so a viewer's class stays valid", () => {
  const storage = new ThemeStorage(fakeStore());
  const slug = storage.create("Before", "a{}");
  storage.update(slug, { name: "After", css: "a{}" });
  assertEquals(storage.get(slug)?.name, "After");
  assertEquals(storage.list().length, 1);
});

Deno.test("updating a theme that doesn't exist throws rather than creating it", () => {
  const storage = new ThemeStorage(fakeStore());
  assertThrows(() => storage.update("theme-user-ghost", { name: "x", css: "" }));
});

Deno.test("@import is reported, because replaceSync will reject it", () => {
  assertEquals(findThemeCssProblems(`@import "other.css";\nbody{}`).length, 1);
  assertEquals(findThemeCssProblems(`a{}\n@import url(x);`).length, 1);
  // "@import" inside a string or a property value is not an at-rule.
  assertEquals(findThemeCssProblems(`a{content:"@import"}`).length, 0);
});

Deno.test("a rule changing .pdf-page height is reported", () => {
  // Nothing errors when a theme does this — the PDF column just stops being
  // proportional and differently-sized viewers drift apart per page.
  for (const css of [
    `.pdf-page { height: 500px }`,
    `.pdf-page{margin-bottom:2rem}`,
    `.pdf-page {\n  padding: 1rem;\n}`,
    `.content .pdf-page { border: 1px solid red }`,
  ]) {
    assertEquals(findThemeCssProblems(css).length, 1, css);
  }
});

Deno.test("styling .pdf-page without touching its box is allowed", () => {
  assertEquals(findThemeCssProblems(`.pdf-page { background: #eee }`), []);
  assertEquals(
    findThemeCssProblems(`.pdf-page { border-radius: 4px; opacity: .9 }`),
    [],
  );
});

Deno.test("a height rule on another selector is not blamed on .pdf-page", () => {
  // The scan walks brace depth so a nested or neighbouring rule can't be
  // mistaken for .pdf-page's own block.
  assertEquals(findThemeCssProblems(`.content { height: 100vh }`), []);
  assertEquals(
    findThemeCssProblems(`.pdf-page{background:#fff} .content{height:50vh}`),
    [],
  );
  assertEquals(
    findThemeCssProblems(`.pdf-page{background:#fff; &:hover{opacity:.5}}`),
    [],
  );
});

Deno.test("the seed template is clean by its own rules", () => {
  // A brand-new theme must not open with warnings against it.
  return import("./themes.ts").then(({ THEME_TEMPLATE }) => {
    assertEquals(findThemeCssProblems(THEME_TEMPLATE), []);
  });
});
