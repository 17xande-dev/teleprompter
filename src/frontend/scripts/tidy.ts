/**
 * The rules behind the toolbar's tidy button.
 *
 * There is no lint tool for a rich-text document to borrow — Wordgard has
 * nothing of the kind, and the well-known HTML tools (Tidy, sanitize-html,
 * DOMPurify) are *sanitizers*: they care about structure and safety, not about
 * whether a script reads well. So these rules are ours, and they were chosen by
 * measuring a real service script pasted out of Google Docs rather than by
 * imagining what a document might contain. In 471 blocks it had:
 *
 *   106 blocks with leading whitespace, 105 of them non-breaking spaces
 *    80 runs of two or more consecutive line breaks inside a block
 *    47 blocks with trailing whitespace
 *     6 runs of four consecutive blank blocks
 *     0 tabs, 0 double spaces, 0 empty spans
 *
 * Which is why "fix the indentation" turned out to be the easy one and not the
 * hard one: in this schema there is no indent level to reason about, so the
 * whole problem is a run of non-breaking spaces at the start of a line.
 *
 * DOM-free and dependency-free, like textscale.ts and sectionsize.ts. The walk
 * that applies these to a document needs a DOM and lives in tidyContent.ts;
 * everything that can be got wrong about *what counts as blank* is here, where
 * `deno test` can reach it.
 */

/**
 * How many consecutive line breaks survive.
 *
 * Two `<br>` render as one blank line, so this is "at most one blank line
 * between lines of the same block". Runs of three and four were the common case
 * in the measured document; a run of two is already the intended thing and is
 * left alone.
 */
export const TIDY_MAX_BREAKS = 2;

/**
 * How many consecutive blank blocks survive.
 *
 * One, for the same reason and to the same effect: an empty paragraph already
 * *is* a blank line, so it takes one of these rather than two to say what two
 * `<br>` say.
 */
export const TIDY_MAX_BLANK_BLOCKS = 1;

/**
 * Whitespace that should read as a plain space.
 *
 * The non-breaking space is the interesting one and the reason this function
 * exists. Google Docs uses runs of them where a person would use an indent, so
 * they are the indentation this tidies away — but one left in the middle of a
 * sentence also *stops the line wrapping there*, which on a display pushes a
 * word to the next line for no visible reason. From a paste they are an
 * artefact rather than an intent, so they become ordinary spaces everywhere and
 * the prompter is free to wrap where it likes.
 *
 * Tabs and the various Unicode spaces go the same way: none appeared in the
 * measured document, but they cost nothing to include and each one is a
 * character that would otherwise survive a trim and sit at the start of a line
 * looking like an indent.
 */
export function normaliseSpaces(text: string): string {
  return text.replace(/[\t  -   　]/g, " ");
}

/**
 * Whether a piece of text holds nothing a reader would see.
 *
 * Non-breaking spaces count as blank here, which is the whole point: a
 * paragraph containing one is visually empty, and a plain `trim()` would keep
 * it forever.
 */
export function isBlankText(text: string): boolean {
  return normaliseSpaces(text).trim() === "";
}

/** Trim the whitespace at the start of a line. */
export function trimLineStart(text: string): string {
  return normaliseSpaces(text).replace(/^ +/, "");
}

/** Trim the whitespace at the end of a line. */
export function trimLineEnd(text: string): string {
  return normaliseSpaces(text).replace(/ +$/, "");
}

/**
 * How many of a run of `run` identical things to keep.
 *
 * Trivial, and worth naming anyway: it is the one place the two limits above
 * are actually applied, so a test can pin the behaviour at the boundary —
 * a run of exactly the limit must not be touched, which is what stops the
 * button "fixing" a document that is already correct.
 */
export function keepFromRun(run: number, max: number): number {
  if (!Number.isFinite(run) || run <= 0) return 0;
  return Math.min(Math.floor(run), max);
}
