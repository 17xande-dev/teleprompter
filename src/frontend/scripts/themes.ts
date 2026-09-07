// User-authored viewer layouts, held as plain CSS text.
//
// A theme is stored in the *operator's* browser and shipped to viewers over
// the control channel as a ThemeMessage (see protocol.ts) — viewers keep
// nothing. That is why this module is deliberately free of DOM: it is the
// control page's storage and validation layer, and staying DOM-free is what
// makes it testable in this repo's style (see themes_test.ts; DocStorage has
// no tests precisely because it reaches for localStorage in its constructor).

export type Theme = {
  // Display name, editable. Identity is the slug, not this.
  name: string;
  css: string;
};

// The slice of localStorage this needs, injected so tests can hand it a
// plain object instead of a real Storage.
export interface ThemeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Namespaced, matching #ensureControlKey's convention rather than
// DocStorage's bare "documents"/"currentDocument" keys.
const THEMES_KEY = "teleprompter.themes";
const LAYOUT_KEY = "teleprompter.layout";

export const DEFAULT_LAYOUT = "theme-default";
export const BUILTIN_LAYOUTS: readonly string[] = [
  DEFAULT_LAYOUT,
  "theme-big-clock",
];

// Every user theme's class name starts here. Two things depend on it: a user
// theme can never collide with a built-in (so it can never accidentally
// inherit the bundled @scope'd rules it is supposed to replace), and
// `isUserLayout` can tell the two apart from the class name alone.
export const USER_LAYOUT_PREFIX = "theme-user-";

export function isUserLayout(layout: string): boolean {
  return layout.startsWith(USER_LAYOUT_PREFIX);
}

/**
 * Derive a class name from a display name. Identity, not decoration: a slug
 * is minted once when a theme is created and then never changes, so renaming
 * a theme cannot invalidate the class a connected viewer is already wearing.
 */
export function themeSlug(name: string): string {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A name that is entirely punctuation or non-Latin script kebabs to nothing,
  // which would leave a bare prefix — and a second such theme would collide
  // with the first. Fall back to something that at least parses as a class.
  return USER_LAYOUT_PREFIX + (kebab || "theme");
}

/** Mint a slug for `name` that isn't already in `taken`. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = themeSlug(name);
  if (!used.has(base)) return base;
  for (let n = 2;; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Read a stored theme map, tolerating anything. Corrupt or half-written
 * localStorage yields an empty map rather than an exception — the lesson
 * recorded in doc.ts, where a stale pre-migration value threw out of the
 * page-load handler and broke every first load of the app.
 */
export function parseThemes(raw: string | null): Record<string, Theme> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("stored themes are not valid JSON, starting empty");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const themes: Record<string, Theme> = {};
  for (const [slug, value] of Object.entries(parsed)) {
    // Drop entries individually: one bad theme shouldn't cost the operator
    // the rest of them.
    if (typeof value !== "object" || value === null) continue;
    const { name, css } = value as Partial<Theme>;
    if (typeof name !== "string" || typeof css !== "string") continue;
    if (!isUserLayout(slug)) continue;
    themes[slug] = { name, css };
  }
  return themes;
}

// Properties that change how tall a .pdf-page box is. See findThemeCssProblems.
const HEIGHT_PROPS =
  /(?:^|[;{\s])(height|min-height|max-height|padding|padding-block|padding-block-start|padding-block-end|padding-top|padding-bottom|margin-block|margin-block-start|margin-block-end|margin-top|margin-bottom|border|border-width|border-block|border-top|border-bottom|box-sizing|aspect-ratio)\s*:/;

/**
 * Warn about the two ways a theme breaks something no error would surface.
 * A pure text scan, not a parse — it has to run in the same DOM-free module
 * the tests can reach, and it only needs to be good enough to catch the
 * shapes an author actually writes.
 */
export function findThemeCssProblems(css: string): string[] {
  const problems: string[] = [];

  if (/(?:^|[;}\s])@import\b/.test(css)) {
    problems.push(
      "@import will be dropped without applying: a theme is installed as an " +
        "adopted stylesheet, which has no base URL to resolve one against. " +
        "Paste the imported rules in instead.",
    );
  }

  // .pdf-page's height and the gap below it are set in pixels by pdfview.ts so
  // the whole column stays proportional — that is what makes a scroll ratio of
  // 0.4 land on the same line on a phone and on a 4K display. A rule here that
  // changes the box height desyncs differently-sized viewers by a little more
  // with every page, and nothing errors: the document just drifts.
  for (const block of ruleBlocksFor(css, ".pdf-page")) {
    if (HEIGHT_PROPS.test(block)) {
      problems.push(
        "This theme changes the height of .pdf-page. Page boxes are sized in " +
          "pixels by pdfview.ts to keep the PDF column proportional; altering " +
          "the height silently drifts viewers of different sizes apart. Style " +
          "its color or border-radius, not its height or spacing.",
      );
      break;
    }
  }

  return problems;
}

/**
 * The declaration blocks of every rule whose selector mentions `needle`.
 * Brace-counted so a nested rule doesn't truncate the block.
 */
function ruleBlocksFor(css: string, needle: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const hit = css.indexOf(needle, from);
    if (hit === -1) return blocks;
    from = hit + needle.length;

    const open = css.indexOf("{", hit);
    if (open === -1) return blocks;
    // Anything between the needle and the brace that ends the selector means
    // the needle was in a *different* selector (or a comment), not this rule's.
    if (/[{};]/.test(css.slice(from, open))) continue;

    let depth = 1;
    let i = open + 1;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    blocks.push(css.slice(open + 1, i - 1));
  }
}

export class ThemeStorage {
  #store: ThemeStore;
  #themes: Record<string, Theme>;
  #layout: string;

  constructor(store: ThemeStore = localStorage) {
    this.#store = store;
    this.#themes = parseThemes(this.#read(THEMES_KEY));
    const layout = this.#read(LAYOUT_KEY);
    // A stored layout naming a theme that has since been deleted (or a build
    // that dropped a built-in) would leave viewers wearing a class no
    // stylesheet matches — a blank screen with nothing to explain it.
    this.#layout = layout && this.has(layout) ? layout : DEFAULT_LAYOUT;
  }

  #read(key: string): string | null {
    try {
      return this.#store.getItem(key);
    } catch {
      // Private mode or blocked storage. Themes are a convenience, so run
      // without them rather than failing the page load.
      return null;
    }
  }

  #write(key: string, value: string) {
    try {
      this.#store.setItem(key, value);
    } catch (err) {
      // Over quota, or storage blocked. In-memory state is deliberately left
      // as it is: the operator keeps working this session and only loses the
      // theme on reload, which beats reverting an edit under their hands.
      console.warn(`could not persist ${key}`, err);
    }
  }

  #save() {
    this.#write(THEMES_KEY, JSON.stringify(this.#themes));
  }

  /** Is this a layout anyone can actually wear? */
  has(layout: string): boolean {
    return BUILTIN_LAYOUTS.includes(layout) || layout in this.#themes;
  }

  /** User themes only, as [slug, theme] pairs in insertion order. */
  list(): [string, Theme][] {
    return Object.entries(this.#themes);
  }

  get(slug: string): Theme | undefined {
    return this.#themes[slug];
  }

  /** Store a new theme under a freshly minted slug, and return that slug. */
  create(name: string, css: string): string {
    const slug = uniqueSlug(name, Object.keys(this.#themes));
    this.#themes[slug] = { name, css };
    this.#save();
    return slug;
  }

  /** Update an existing theme in place. The slug — and so the class a viewer
   * is wearing — is left alone, including on rename. */
  update(slug: string, theme: Theme) {
    if (!(slug in this.#themes)) {
      throw new Error(`no theme ${slug} to update`);
    }
    this.#themes[slug] = theme;
    this.#save();
  }

  remove(slug: string) {
    delete this.#themes[slug];
    this.#save();
    if (this.#layout === slug) this.setLayout(DEFAULT_LAYOUT);
  }

  getLayout(): string {
    return this.#layout;
  }

  setLayout(layout: string) {
    this.#layout = layout;
    this.#write(LAYOUT_KEY, layout);
  }
}

// Seed CSS for a brand-new theme. A theme replaces the built-in layout layer
// outright, so an empty one is a blank screen — starting from the default
// layout's rules gives the author something to edit rather than to invent.
//
// Duplicated from viewerThemes.css by hand: the bundler emits JS and CSS but
// has no text loader, so the stylesheet cannot be imported as a string (see
// the unresolved TODO on the SVG import in app.ts). If you change the
// theme-default block there, change it here.
export const THEME_TEMPLATE = `/* A viewer theme is plain CSS, and while it is
   active it is the only layout stylesheet the viewer has — the built-in
   layouts stop applying entirely, so there is no need to scope anything.

   The markup you are styling is fixed:

     body
       header#header.viewer-clocks
         time#timeTimer.left    the countdown
         span#message.mid       the operator's message
         time#timeClock.right   the wall clock
       main#main.content        the script, or the PDF page column

   Three things are not yours to set:
     - #message's font-size, which the viewer recomputes to fit its box
     - --textScale, which the Text Scale slider drives
     - the height or spacing of .pdf-page, which keeps the PDF column
       proportional so every viewer scrolls to the same line

   Everything else is fair game. Note that url() can only reach this server:
   the page runs under default-src 'self'. */

.viewer-clocks {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 8vi;
  position: sticky;
  top: 0;
  z-index: 10;
  background: black;

  .left,
  .right {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .mid {
    text-align: center;
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: normal;
    color: red;
  }

  time[type="timer"] {
    color: yellow;
  }

  time[type="timer"].negative {
    color: red;
  }
}

.content {
  font-size: var(--textScale);
  color: white;
}
`;
