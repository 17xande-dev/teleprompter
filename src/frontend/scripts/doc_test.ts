// No DOM here — doc.ts is storage and validation only, and DocStorage takes
// its Storage as a constructor argument so these can hand it a plain object.
// (The version of DocStorage these replaced was untestable for exactly the
// lack of that seam.)

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type Doc,
  DocStorage,
  type DocStore,
  formatDateTime,
  newDocName,
  parseDocs,
} from "./doc.ts";

const DOCS_KEY = "teleprompter.documents";
const CURRENT_KEY = "teleprompter.currentDocument";

function fakeStore(seed: Record<string, string> = {}): DocStore & {
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
function readOnlyStore(seed: Record<string, string> = {}): DocStore {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
    removeItem: () => {},
  };
}

/** Build a store already holding `docs`, with `currentID` open. */
function storeWith(docs: Record<string, Doc>, currentID: string) {
  return fakeStore({
    [DOCS_KEY]: JSON.stringify(docs),
    [CURRENT_KEY]: currentID,
  });
}

Deno.test("an empty store seeds exactly one document and opens it", () => {
  const store = fakeStore();
  const storage = new DocStorage(store);

  assertEquals(storage.list().length, 1);
  const [id, doc] = storage.list()[0];
  assertEquals(storage.getCurrentID(), id);
  assertEquals(doc.content, "", "a seeded document must start empty");
  // Persisted immediately: the old code left a new document in memory only
  // until the first keystroke.
  assert(store.data.has(DOCS_KEY), "seeding did not persist");
  assertEquals(store.data.get(CURRENT_KEY), id);
});

Deno.test("documents survive a round trip through storage", () => {
  const store = fakeStore();
  const first = new DocStorage(store);
  const id = first.create("Sermon");
  first.setCurrent(id);
  first.setContent("hello");
  // Content writes are throttled now, so persistence is what flush() means.
  first.flush();

  const reopened = new DocStorage(store);
  assertEquals(reopened.getCurrentID(), id);
  assertEquals(reopened.get(id), { name: "Sermon", content: "hello" });
});

Deno.test("corrupt stored documents seed fresh rather than throwing", () => {
  // A throw here escapes to app.ts's bare `new Teleprompter()` and the control
  // page never boots — which has happened before in this codebase.
  assertEquals(parseDocs("}{not json"), {});
  assertEquals(parseDocs(null), {});
  assertEquals(parseDocs("[]"), {});
  assertEquals(parseDocs('"a string"'), {});

  const storage = new DocStorage(fakeStore({ [DOCS_KEY]: "}{not json" }));
  assertEquals(storage.list().length, 1);
});

Deno.test("one malformed document doesn't cost the operator the others", () => {
  const raw = JSON.stringify({
    good: { name: "Good", content: "a" },
    noName: { content: "b" },
    nul: null,
    // A missing content is recoverable — an unnamed document is not.
    noContent: { name: "No Content" },
  });
  assertEquals(parseDocs(raw), {
    good: { name: "Good", content: "a" },
    noContent: { name: "No Content", content: "" },
  });
});

Deno.test("a current id that no longer exists falls back to a survivor", () => {
  const store = storeWith({ a: { name: "A", content: "" } }, "vanished");
  const storage = new DocStorage(store);

  assertEquals(storage.getCurrentID(), "a");
  // And the repair is persisted, so the dangling pointer doesn't come back.
  assertEquals(store.data.get(CURRENT_KEY), "a");
});

Deno.test("renaming leaves the id alone, so nothing holding it breaks", () => {
  const storage = new DocStorage(fakeStore());
  const id = storage.create("Before");
  storage.rename(id, "After");

  assertEquals(storage.get(id)?.name, "After");
  assertEquals(storage.list().length, 2, "rename must not create a document");
});

Deno.test("renaming another document does not move the open one", () => {
  // The old rename set `current` unconditionally, so renaming a document you
  // were not editing pointed `current` at it while the editor still showed the
  // old text — and the next keystroke wrote that text over the renamed
  // document. Silent data loss.
  const storage = new DocStorage(fakeStore());
  const open = storage.create("Open");
  const other = storage.create("Other");
  storage.setCurrent(open);
  storage.setContent("the open document's text");

  storage.rename(other, "Renamed");

  assertEquals(storage.getCurrentID(), open);
  assertEquals(
    storage.get(other)?.content,
    "",
    "other document was written to",
  );
  assertEquals(storage.get(open)?.content, "the open document's text");
});

Deno.test("renaming to a name already in use keeps both documents", () => {
  // Names were the storage key, so this used to destroy the other document.
  const storage = new DocStorage(fakeStore());
  const a = storage.create("Taken");
  const b = storage.create("Free");
  storage.rename(b, "Taken");

  assertEquals(storage.get(a)?.name, "Taken");
  assertEquals(storage.get(b)?.name, "Taken");
  assert(a !== b);
  assertEquals(storage.list().length, 3);
});

Deno.test("a blank rename falls back to a usable name", () => {
  const storage = new DocStorage(fakeStore());
  const id = storage.create("Named");
  storage.rename(id, "   ");
  assertEquals(storage.get(id)?.name, "Untitled");
});

Deno.test("renaming a document that doesn't exist throws", () => {
  const storage = new DocStorage(fakeStore());
  assertThrows(() => storage.rename("ghost", "x"));
});

Deno.test("delete actually deletes, and stays deleted", () => {
  // The headline bug: remove(doc: Doc) called with a string evaluated
  // undefined.name, so it deleted nothing. The menu item disappeared and the
  // next keystroke wrote the document straight back.
  const store = fakeStore();
  const storage = new DocStorage(store);
  const keep = storage.create("Keep");
  const doomed = storage.create("Doomed");
  storage.setCurrent(keep);

  storage.remove(doomed);
  assertEquals(storage.get(doomed), undefined);
  assertEquals(new DocStorage(store).get(doomed), undefined, "came back");
});

Deno.test("deleting the open document opens a survivor", () => {
  const storage = new DocStorage(fakeStore());
  const other = storage.create("Other");
  const open = storage.create("Open");
  storage.setCurrent(open);

  storage.remove(open);
  assert(storage.getCurrentID() !== open);
  assert(storage.get(storage.getCurrentID()) !== undefined, "dangling current");
  assert(storage.list().some(([id]) => id === other));
});

Deno.test("deleting the last document seeds a replacement", () => {
  // The editor always has a document open, so an empty collection is not a
  // reachable state — it would leave `current` dangling and crash the next load.
  const storage = new DocStorage(fakeStore());
  const [only] = storage.list()[0];
  storage.remove(only);

  assertEquals(storage.list().length, 1);
  assert(storage.get(storage.getCurrentID()) !== undefined);
  assertEquals(storage.getCurrent().content, "");
});

Deno.test("removing an unknown id is a no-op, not a throw", () => {
  const storage = new DocStorage(fakeStore());
  const before = storage.list().length;
  storage.remove("ghost");
  assertEquals(storage.list().length, before);
});

Deno.test("opening an unknown id leaves the open document alone", () => {
  const storage = new DocStorage(fakeStore());
  const open = storage.getCurrentID();
  storage.setCurrent("ghost");
  assertEquals(storage.getCurrentID(), open);
});

Deno.test("list() hands out a snapshot, not the live collection", () => {
  const storage = new DocStorage(fakeStore());
  const list = storage.list();
  list.length = 0;
  assertEquals(storage.list().length, 1, "internal state was mutated");
});

Deno.test("a store that cannot be written leaves in-memory state intact", () => {
  const storage = new DocStorage(readOnlyStore());
  const id = storage.create("Ephemeral");
  storage.setCurrent(id);
  storage.setContent("typed");
  // Reverting the edit under the operator's hands would be worse than losing
  // it on reload.
  assertEquals(storage.get(id)?.content, "typed");
  assertEquals(storage.getCurrentID(), id);
});

// --- content-write throttling -------------------------------------------
//
// A short injected window rather than the 500ms default, so these stay fast.
// Every case must end with nothing pending, or Deno's resource sanitizer
// fails the test on the leaked timer — the same discipline as
// scrollsync_test.ts's `finally { sync.stop() }`.
const TICK = 5;
const settle = () => new Promise((r) => setTimeout(r, TICK * 5));

function throttled(seed: Record<string, string> = {}) {
  const store = fakeStore(seed);
  const storage = new DocStorage(store, TICK);
  // Counting collection writes, not just checking the resulting value: a
  // redundant duplicate write leaves the same bytes behind, so value
  // assertions alone can't see one.
  const counter = { writes: 0 };
  const realSet = store.setItem;
  store.setItem = (k, v) => {
    if (k === DOCS_KEY) counter.writes++;
    realSet(k, v);
  };
  return { store, storage, counter };
}

/** The content currently persisted for the open document, if any. */
function storedContent(
  store: ReturnType<typeof fakeStore>,
): string | undefined {
  const raw = store.data.get(DOCS_KEY);
  if (!raw) return undefined;
  const id = store.data.get(CURRENT_KEY)!;
  return (JSON.parse(raw) as Record<string, Doc>)[id]?.content;
}

Deno.test("a content edit is readable immediately but not yet written", async () => {
  const { store, storage } = throttled();
  storage.setContent("typed");

  // Every read goes through memory, so it must not wait for the timer.
  assertEquals(storage.getCurrent().content, "typed");
  assertEquals(storedContent(store), "", "wrote through instead of throttling");

  await settle();
  assertEquals(
    storedContent(store),
    "typed",
    "the throttled write never landed",
  );
});

Deno.test("a burst of edits collapses to one write, with the last value", async () => {
  const { store, storage, counter } = throttled();

  for (let i = 0; i < 50; i++) storage.setContent(`edit ${i}`);
  await settle();

  assertEquals(counter.writes, 1, `50 edits caused ${counter.writes} writes`);
  assertEquals(storedContent(store), "edit 49");
});

Deno.test("continuous typing keeps getting written — the window doesn't restart", async () => {
  // The reason this is a throttle and not a debounce: a debounce restarts its
  // window on every edit, so it would hold everything in memory for as long
  // as someone keeps typing. Edits have to yield to the event loop the way
  // real keystrokes do — a synchronous loop would starve the timer no matter
  // which strategy were used.
  const { storage, counter } = throttled();

  const until = Date.now() + TICK * 8;
  while (Date.now() < until) {
    storage.setContent(`t${Date.now()}`);
    await new Promise((r) => setTimeout(r, 1));
  }

  assert(
    counter.writes >= 2,
    `only ${counter.writes} write(s) during a burst of 8 windows`,
  );
  storage.flush();
  await settle();
});

Deno.test("flush writes a pending edit straight away, exactly once", async () => {
  const { store, storage, counter } = throttled();
  storage.setContent("unsaved");
  storage.flush();

  assertEquals(storedContent(store), "unsaved");
  assertEquals(counter.writes, 1);
  // The pending timer must have been cancelled, not left armed to repeat the
  // identical write a moment later.
  await settle();
  assertEquals(counter.writes, 1, "flush left a duplicate write armed");
  assertEquals(storedContent(store), "unsaved");
});

Deno.test("flush with nothing pending is a no-op", async () => {
  const { store, storage } = throttled();
  storage.flush();
  storage.flush();
  assert(store.data.has(DOCS_KEY));
  await settle();
});

Deno.test("another mutation persists the pending edit too, without repeating it", async () => {
  // create/rename/remove write the whole collection, so a pending content
  // edit rides along — and its timer must not then fire a second write.
  const { store, storage, counter } = throttled();
  storage.setContent("pending");
  storage.create("Another");

  assertEquals(storedContent(store), "pending");
  assertEquals(counter.writes, 1);
  await settle();
  assertEquals(counter.writes, 1, "the pending timer fired a duplicate write");
  assertEquals(storedContent(store), "pending");
});

Deno.test("switching documents settles the outgoing one's edits", async () => {
  // setCurrent only writes CURRENT_KEY, so without a flush the outgoing
  // document's content would still be sitting on the timer.
  const { store, storage } = throttled();
  const first = storage.getCurrentID();
  const second = storage.create("Second");

  storage.setContent("first's text");
  storage.setCurrent(second);

  const docs = JSON.parse(store.data.get(DOCS_KEY)!) as Record<string, Doc>;
  assertEquals(docs[first].content, "first's text");
  await settle();
});

Deno.test("a throttled write that fails leaves memory intact", async () => {
  const storage = new DocStorage(readOnlyStore(), TICK);
  storage.setContent("typed");
  await settle();
  assertEquals(storage.getCurrent().content, "typed");
});

Deno.test("formatDateTime pads every field from its injected clock", () => {
  assertEquals(
    formatDateTime(new Date(2026, 0, 2, 3, 4, 5)),
    "20260102-030405",
  );
  assertEquals(
    formatDateTime(new Date(2026, 10, 20, 13, 40, 50)),
    "20261120-134050",
  );
  assert(newDocName(new Date(2026, 0, 2, 3, 4, 5)).endsWith("20260102-030405"));
});

Deno.test("a document remembers where it was left, and reads back", async () => {
  const { store, storage } = throttled();
  const id = storage.getCurrentID();
  storage.setScrollFor(id, { index: 42, fraction: 0.25 });
  // In memory at once, like every other mutator here.
  assertEquals(storage.get(id)!.scroll, { index: 42, fraction: 0.25 });
  storage.flush();

  // And survives the round trip through storage, which is the whole point:
  // this is read back by a *fresh page*, not by this object.
  const reopened = new DocStorage(store, TICK);
  assertEquals(reopened.get(id)!.scroll, { index: 42, fraction: 0.25 });
  await settle();
});

Deno.test("a position is written against the document it was measured in", async () => {
  const { storage } = throttled();
  const first = storage.getCurrentID();
  const second = storage.create("Second");
  storage.setScrollFor(first, { index: 10, fraction: 0 });
  storage.setCurrent(second);
  // The case this exists for: the editor is rebuilt *after* the current
  // document has already moved, so the outgoing pane's position is written
  // by id. Taking "the current one" would land it in the script just opened
  // and drop the operator somewhere they have never been.
  storage.setScrollFor(first, { index: 99, fraction: 0.5 });

  assertEquals(storage.get(first)!.scroll, { index: 99, fraction: 0.5 });
  assertEquals(storage.get(second)!.scroll, undefined);
  storage.flush();
  await settle();
});

Deno.test("a position for a document that is gone is dropped, not created", async () => {
  const { storage } = throttled();
  const id = storage.getCurrentID();
  const other = storage.create("Other");
  storage.remove(other);
  storage.setScrollFor(other, { index: 3, fraction: 0 });
  assertEquals(storage.get(other), undefined);
  assertEquals(storage.list().length, 1);
  assertEquals(storage.getCurrentID(), id);
  await settle();
});

Deno.test("scrolling is throttled and flushed like an edit", async () => {
  const { store, storage, counter } = throttled();
  const id = storage.getCurrentID();
  const before = counter.writes;
  // A wheel produces these far faster than a keystroke does, and each write
  // serialises the whole collection.
  for (let i = 0; i < 20; i++) {
    storage.setScrollFor(id, { index: i, fraction: 0 });
  }
  assertEquals(counter.writes, before, "a scroll burst wrote immediately");
  storage.flush();
  assertEquals(counter.writes, before + 1);
  assertEquals(
    (JSON.parse(store.data.get(DOCS_KEY)!) as Record<string, Doc>)[id].scroll,
    { index: 19, fraction: 0 },
    "the last position is the one that lands",
  );
  await settle();
});

Deno.test("a stored position that is nonsense costs the position, not the script", () => {
  const docs = parseDocs(JSON.stringify({
    a: {
      name: "NaN",
      content: "<p>a</p>",
      scroll: { index: NaN, fraction: 0 },
    },
    b: {
      name: "string",
      content: "<p>b</p>",
      scroll: { index: "3", fraction: 0 },
    },
    c: { name: "missing", content: "<p>c</p>", scroll: { index: 3 } },
    d: { name: "not an object", content: "<p>d</p>", scroll: 12 },
    e: {
      name: "negative",
      content: "<p>e</p>",
      scroll: { index: -1, fraction: 0 },
    },
    f: {
      name: "good",
      content: "<p>f</p>",
      scroll: { index: 7, fraction: 0.5 },
    },
  }));
  // Every script is still here — a bad position must never cost a document.
  assertEquals(Object.keys(docs).length, 6);
  for (const id of ["a", "b", "c", "d", "e"]) {
    assertEquals(docs[id].scroll, undefined, `${id} kept a bad position`);
    assert(docs[id].content.length > 0);
  }
  assertEquals(docs.f.scroll, { index: 7, fraction: 0.5 });
});

Deno.test("a position just outside its block is clamped rather than refused", () => {
  const docs = parseDocs(JSON.stringify({
    a: { name: "a", content: "", scroll: { index: 4.7, fraction: 1.0000001 } },
    b: { name: "b", content: "", scroll: { index: 2, fraction: -0.0001 } },
  }));
  // Rounding artefacts of a measurement, not a reason to lose the place.
  assertEquals(docs.a.scroll, { index: 4, fraction: 1 });
  assertEquals(docs.b.scroll, { index: 2, fraction: 0 });
});
