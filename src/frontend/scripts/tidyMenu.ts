// The tidy button, and the transaction it dispatches.
//
// The Wordgard half of the feature: the rules are in tidy.ts and the walk in
// tidyContent.ts, neither of which imports this. Kept apart because anything
// importing Wordgard is untestable under `deno test`, so this file holds no
// rules and no arithmetic — only the round trip through the document model.

import { type Command, Menu } from "wordgard/command";
import { parse, serialize } from "wordgard/doc";
import type { GardState } from "wordgard/state";

import { tidyFragment } from "./tidyContent.ts";

/**
 * A broom, as an SVG path in a 100-by-100 box, which is all a `Menu.Label`
 * icon can be. Filled shapes rather than strokes, like the other icons here:
 * the handle is a parallelogram and the head a splayed trapezoid.
 */
const ICON =
  "M74 8 92 26 62 56 44 38zM40 42 58 60 48 92 8 78zm6 22-7 20 5 2 7-20z";

/**
 * Tidy the whole document in one transaction.
 *
 * **Serialize, clean, re-parse, replace** — rather than walking the model and
 * emitting a change per fix. The rules are about lines and blank space, which
 * are DOM shapes; expressed as positions in the document model each one would
 * have to be mapped past every earlier change in the same transaction, and a
 * single off-by-one there silently eats a character of somebody's script. The
 * round trip costs a whole-document change and the cursor's place, which for a
 * deliberate one-off action is a fair price.
 *
 * It is a round trip through *the same schema*, so nothing is lost in it: the
 * size marks, colours, headings and links all serialize to markup their own
 * parse rules read back. Verified in the browser by tidying a document that had
 * all of them.
 *
 * Three details that are load-bearing:
 *
 * - `toDOM` is given an inert document, so an `<img src>` in the script does
 *   not fetch anything on its way through. `createHTMLDocument` has no browsing
 *   context, which is the same reason pasteColors.ts uses a `<template>`.
 * - `collapseWhiteSpace: false`, because this is Wordgard's own serialization
 *   coming back in, not foreign HTML. Left at its default the parser would
 *   apply HTML whitespace collapsing on top of the tidy and the result would
 *   depend on rules nobody here chose. It is the same distinction
 *   `readClipboard` draws with its `wg-content` check.
 * - Returning `false` when the clean produced nothing changes the meaning of
 *   the button press: no transaction, so no undo step, so pressing it twice on
 *   a tidy document does not fill the history with no-ops.
 */
const tidyDocument: Command = (wg) => {
  const { state } = wg;
  if (state.readOnly) return false;

  const inert = document.implementation.createHTMLDocument();
  const fragment = serialize(state.doc).toDOM(inert);
  const before = fragment.children.length;
  const beforeText = fragment.textContent ?? "";

  tidyFragment(fragment);

  // Nothing to do. Compared on the text and the block count rather than on
  // serialized HTML, which would mean serializing twice.
  if (
    fragment.children.length === before &&
    (fragment.textContent ?? "") === beforeText
  ) {
    return false;
  }

  const { slice, context } = parse.slice(state.schema, fragment, {
    collapseWhiteSpace: false,
  });

  return {
    changes: { from: 0, to: state.doc.length, insert: slice, fit: context },
    userEvent: "tidy",
  };
};

/**
 * The button.
 *
 * In the formatting group with the other document-shaping controls, after the
 * size submenu. `parent` is passed in rather than imported so this module never
 * depends on editor.ts, which imports it — the same reason textSizeMenu.ts and
 * sectionSizeMenu.ts take one.
 */
export function tidyMenu(parent: Menu.Group): GardState.Extension {
  return Menu.Button.define({
    run: tidyDocument,
    label: { icon: ICON },
    description: "Tidy the script",
    parent,
    // After the size submenu (125) and before the overflow dots (150).
    rank: 130,
    enable: (state) => !state.readOnly,
  });
}
