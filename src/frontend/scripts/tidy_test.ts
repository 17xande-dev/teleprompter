import { assertEquals } from "@std/assert";

import {
  isBlankText,
  keepFromRun,
  normaliseSpaces,
  TIDY_MAX_BLANK_BLOCKS,
  TIDY_MAX_BREAKS,
  trimLineEnd,
  trimLineStart,
} from "./tidy.ts";

Deno.test("a non-breaking space is whitespace, which is the whole feature", () => {
  // 105 of the 106 indented lines in the measured document were indented with
  // these, not with spaces — so anything treating them as ordinary characters
  // tidies nothing at all.
  assertEquals(normaliseSpaces("  Line"), "  Line");
  assertEquals(trimLineStart("   Line"), "Line");
  assertEquals(trimLineEnd("Line  "), "Line");
  assertEquals(isBlankText(" "), true);
  assertEquals(isBlankText("   "), true);
});

Deno.test("a non-breaking space inside a sentence becomes an ordinary one", () => {
  // Left alone it stops the line wrapping there, which on a display pushes a
  // word to the next line for no reason a reader can see.
  assertEquals(normaliseSpaces("Psalm 23"), "Psalm 23");
  assertEquals(normaliseSpaces("a b c"), "a b c");
});

Deno.test("tabs and exotic spaces are whitespace too", () => {
  // None appeared in the measured document, but each is a character that
  // survives a naive trim and then sits at the start of a line looking like an
  // indent.
  assertEquals(trimLineStart("\tLine"), "Line");
  assertEquals(trimLineStart("  Line"), "Line");
  assertEquals(trimLineStart("　Line"), "Line");
  assertEquals(isBlankText("\t "), true);
});

Deno.test("text a reader can see is never blank", () => {
  assertEquals(isBlankText("."), false);
  assertEquals(isBlankText(" a "), false);
  // A zero-width space is not stripped: it is invisible but it is also not
  // something a tidy should silently decide about.
  assertEquals(isBlankText("​"), false);
});

Deno.test("trimming touches one end only", () => {
  // Per line, so a line's leading whitespace and the previous line's trailing
  // whitespace are two separate decisions.
  assertEquals(trimLineStart("  a  "), "a  ");
  assertEquals(trimLineEnd("  a  "), "  a");
  assertEquals(trimLineStart(""), "");
  assertEquals(trimLineEnd(""), "");
});

Deno.test("a run already at the limit is left alone", () => {
  // What stops the button "fixing" a document that is already correct — and
  // with it, adding an undo step that changes nothing.
  assertEquals(keepFromRun(TIDY_MAX_BREAKS, TIDY_MAX_BREAKS), TIDY_MAX_BREAKS);
  assertEquals(keepFromRun(1, TIDY_MAX_BREAKS), 1);
  assertEquals(
    keepFromRun(TIDY_MAX_BLANK_BLOCKS, TIDY_MAX_BLANK_BLOCKS),
    TIDY_MAX_BLANK_BLOCKS,
  );
});

Deno.test("a longer run is cut to the limit", () => {
  // The measured document's runs: 17 triples and one quadruple of breaks, and
  // six runs of four blank blocks.
  assertEquals(keepFromRun(3, TIDY_MAX_BREAKS), 2);
  assertEquals(keepFromRun(4, TIDY_MAX_BREAKS), 2);
  assertEquals(keepFromRun(4, TIDY_MAX_BLANK_BLOCKS), 1);
  assertEquals(keepFromRun(99, TIDY_MAX_BLANK_BLOCKS), 1);
});

Deno.test("a nonsensical run keeps nothing rather than throwing", () => {
  assertEquals(keepFromRun(0, TIDY_MAX_BREAKS), 0);
  assertEquals(keepFromRun(-3, TIDY_MAX_BREAKS), 0);
  assertEquals(keepFromRun(NaN, TIDY_MAX_BREAKS), 0);
});

Deno.test("two breaks are one blank line, and that is the limit", () => {
  // The constants encode the decision, so they are worth asserting: the
  // operator asked for at most one blank line, and two <br> render as one.
  assertEquals(TIDY_MAX_BREAKS, 2);
  assertEquals(TIDY_MAX_BLANK_BLOCKS, 1);
});
