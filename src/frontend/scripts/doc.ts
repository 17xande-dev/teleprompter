// The operator's script documents, held in localStorage.
//
// DOM-free on purpose: this is the storage and validation half, and staying
// DOM-free is what makes it testable (see doc_test.ts). docControls.ts is the
// DOM half — dropdown, dialogs, events. Same split, and for the same reason,
// as themes.ts / themeControls.ts.

import { randomID } from "./ids.ts";
import type { BlockPos } from "./scrollsync.ts";

export type Doc = {
  // Display name, editable. Identity is the id, not this.
  name: string;
  // A Wordgard state JSON blob, or "" for a document never edited — which
  // restoreEditor reads as "no content yet" and starts a fresh editor from.
  content: string;
  /**
   * Where the operator's own pane was left, as a block and a fraction of it.
   *
   * **Not a pixel offset and not a ratio**, for the reason the Sync buttons
   * already document: the same script is a different number of pixels tall
   * whenever the reading size or the pane's width changes, and a bigger font
   * wraps long paragraphs more than short ones — so neither pixels nor a
   * fraction of the height survives an editor-scale change or a dragged
   * divider between one session and the next. The block index does, because
   * it is the same document either way.
   *
   * Absent on a document never scrolled, which reads as "start at the top".
   */
  scroll?: BlockPos;
};

// The slice of localStorage this needs, injected so tests can hand it a plain
// object instead of a real Storage.
export interface DocStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Namespaced, matching #ensureControlKey and themes.ts. The bare "documents"
// and "currentDocument" these replace were two very generic keys on a shared
// origin.
const DOCS_KEY = "teleprompter.documents";
const CURRENT_KEY = "teleprompter.currentDocument";

// How long content edits may sit in memory before being written.
//
// This is a throttle, not a true debounce: the window is *not* restarted by
// each keystroke, so a write always lands within this long of any edit. A
// debounce would write nothing at all while someone types continuously —
// which, for an operator drafting a script, could be minutes of work held
// only in memory. Same "coalesce, last value wins" reasoning as
// #pushSettings, just at a coarser grain, because the cost being avoided
// here is a synchronous localStorage write of the whole collection on every
// keypress rather than a data channel flood.
const CONTENT_SAVE_MS = 500;

/** A timestamp suffix for generated names. Takes its clock for testability. */
export function formatDateTime(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");

  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function newDocName(d?: Date): string {
  return `document_${formatDateTime(d)}`;
}

/**
 * Read a stored document map, tolerating anything. Corrupt or half-written
 * localStorage yields an empty map rather than an exception: everything here
 * runs from the control page's constructor, which runs from a bare top-level
 * `new Teleprompter()` in app.ts, so a throw means the page never boots. That
 * has already happened once in this codebase — a Quill delta left in storage
 * after the Wordgard migration threw out of the load handler on every
 * first-ever page load.
 */
/** A stored scroll position, or undefined if it is not one. */
function parseBlockPos(value: unknown): BlockPos | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { index, fraction } = value as Partial<BlockPos>;
  if (typeof index !== "number" || !Number.isFinite(index) || index < 0) {
    return undefined;
  }
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return undefined;
  }
  // Clamped rather than refused: a fraction a hair outside the block is a
  // rounding artefact of the measurement, not a reason to lose the place.
  return {
    index: Math.floor(index),
    fraction: Math.min(1, Math.max(0, fraction)),
  };
}

export function parseDocs(raw: string | null): Record<string, Doc> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("stored documents are not valid JSON, starting empty");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const docs: Record<string, Doc> = {};
  for (const [id, value] of Object.entries(parsed)) {
    // Drop entries one at a time: one unreadable document shouldn't cost the
    // operator the rest of their scripts.
    if (typeof value !== "object" || value === null) continue;
    const { name, content, scroll } = value as Partial<Doc>;
    if (typeof name !== "string") continue;
    docs[id] = { name, content: typeof content === "string" ? content : "" };
    // A bad position costs the *position*, never the script: it is the one
    // field here that is written from measured geometry rather than typed by
    // anyone, so it is the one most likely to arrive as a NaN from a browser
    // that was mid-relayout. Dropped silently, which reads as "start at the
    // top" — the same thing a document nobody has scrolled does.
    const pos = parseBlockPos(scroll);
    if (pos) docs[id].scroll = pos;
  }
  return docs;
}

export class DocStorage {
  #store: DocStore;
  #docs: Record<string, Doc>;
  // The *id* of the open document, not the object. Holding the object was the
  // old design's central defect: the reference aliased the collection
  // sometimes and not others, so `current` and `docs[name]` could drift apart
  // and a rename could silently redirect edits into the wrong document.
  #currentID: string;
  #saveDelayMs: number;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  // saveDelayMs is injected for the same reason the store is: so tests can
  // drive the throttle without sleeping half a second per case.
  constructor(store: DocStore = localStorage, saveDelayMs = CONTENT_SAVE_MS) {
    this.#store = store;
    this.#saveDelayMs = saveDelayMs;
    this.#docs = parseDocs(this.#read(DOCS_KEY));

    const ids = Object.keys(this.#docs);
    if (ids.length === 0) {
      const id = randomID();
      this.#docs[id] = { name: newDocName(), content: "" };
      this.#currentID = id;
      this.#save();
      return;
    }

    // A stored id that no longer exists (deleted in another tab, or storage
    // written by an older build) would leave every read dereferencing
    // undefined. Repair it to a real document and persist the repair.
    const stored = this.#read(CURRENT_KEY);
    this.#currentID = stored && stored in this.#docs ? stored : ids[0];
    this.#write(CURRENT_KEY, this.#currentID);
  }

  #read(key: string): string | null {
    try {
      return this.#store.getItem(key);
    } catch {
      // Private mode or blocked storage. Run in memory for this session
      // rather than failing the page load.
      return null;
    }
  }

  #write(key: string, value: string) {
    try {
      this.#store.setItem(key, value);
    } catch (err) {
      // Over quota, or storage blocked. In-memory state is left alone: the
      // operator keeps working and only loses the change on reload, which
      // beats reverting an edit under their hands.
      console.warn(`could not persist ${key}`, err);
    }
  }

  // Writes the whole collection, so it also satisfies whatever edit was
  // waiting on the throttle — drop the pending timer rather than letting it
  // fire a second, identical write.
  #save() {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    this.#write(DOCS_KEY, JSON.stringify(this.#docs));
    this.#write(CURRENT_KEY, this.#currentID);
  }

  /**
   * Persist a throttled edit now. Callers with a DOM must call this when the
   * page is going away — a write still sitting on the timer is lost work —
   * and it is also how tests avoid leaving a timer pending. A no-op when
   * nothing is waiting.
   */
  flush() {
    if (this.#saveTimer === undefined) return;
    this.#save();
  }

  /** All documents as [id, doc] pairs — a snapshot, not the live collection. */
  list(): [string, Doc][] {
    return Object.entries(this.#docs);
  }

  get(id: string): Doc | undefined {
    return this.#docs[id];
  }

  getCurrentID(): string {
    return this.#currentID;
  }

  /** The open document. The constructor guarantees this always resolves. */
  getCurrent(): Doc {
    return this.#docs[this.#currentID];
  }

  setCurrent(id: string) {
    if (!(id in this.#docs)) {
      console.warn(`cannot open document ${id}: it doesn't exist`);
      return;
    }
    // Settle the outgoing document's edits before moving on. Only CURRENT_KEY
    // is written below, so a pending write left behind here would be lost if
    // the tab closed before its timer fired.
    this.flush();
    this.#currentID = id;
    this.#write(CURRENT_KEY, id);
  }

  /**
   * Replace the open document's content. Called on every editor update, so
   * the write is throttled — but the in-memory collection is updated straight
   * away, which is what every read goes through.
   */
  setContent(content: string) {
    this.#docs[this.#currentID].content = content;
    this.#scheduleSave();
  }

  /**
   * Remember where a document was left, so a reload lands there.
   *
   * Takes the id explicitly rather than assuming the open one, because the
   * two moments that matter most are the ones where "the open document" has
   * already moved on: switching documents (`setCurrent` runs before the
   * editor is rebuilt) and the page going away. Writing the outgoing pane's
   * position into the incoming document would be worse than not remembering
   * it at all — the operator would open a script and land somewhere they have
   * never been.
   *
   * Throttled with the content writes and through the same timer: both are
   * one synchronous serialisation of the whole collection, and scrolling
   * produces events as fast as content editing does.
   */
  setScrollFor(id: string, scroll: BlockPos) {
    const doc = this.#docs[id];
    if (!doc) return;
    doc.scroll = scroll;
    this.#scheduleSave();
  }

  #scheduleSave() {
    if (this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#save();
    }, this.#saveDelayMs);
  }

  /** Create an empty document and return its id. Does not open it. */
  create(name: string = newDocName()): string {
    // A UUID rather than themes.ts's readable slug: a theme's id doubles as
    // the CSS class a viewer wears, so it has to be a legible identifier and
    // needs a collision pass. A document id is never seen by anyone.
    const id = randomID();
    this.#docs[id] = { name, content: "" };
    this.#save();
    return id;
  }

  /**
   * Rename in place. The id — and so anything holding a reference to this
   * document — is untouched, and `current` is not moved: renaming a document
   * you are not editing must not redirect your edits into it.
   */
  rename(id: string, name: string) {
    const doc = this.#docs[id];
    if (!doc) throw new Error(`no document ${id} to rename`);
    // Names are display-only and need not be unique, but a blank one leaves
    // an unclickable row in the dropdown.
    doc.name = name.trim() || "Untitled";
    this.#save();
  }

  remove(id: string) {
    if (!(id in this.#docs)) return;
    delete this.#docs[id];

    const ids = Object.keys(this.#docs);
    if (ids.length === 0) {
      // There is no such thing as "no document": the editor always has one
      // open, so deleting the last one seeds a replacement rather than
      // leaving `current` dangling.
      const fresh = randomID();
      this.#docs[fresh] = { name: newDocName(), content: "" };
      this.#currentID = fresh;
    } else if (this.#currentID === id) {
      this.#currentID = ids[0];
    }
    this.#save();
  }
}
