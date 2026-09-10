import { menuBar, Wordgard } from "wordgard/editor";
import { Menu } from "wordgard/command";
import {
  backgroundColor,
  code,
  color,
  emphasis,
  fullSchema,
  link,
  strikethrough,
  strong,
  subscript,
  superscript,
  underline,
} from "wordgard/schema";
import { history } from "wordgard/history";
import { GardState } from "wordgard/state";
import { type TextSizeAccess, textSizeMenu } from "./textSizeMenu.ts";

// The editor pane's height, matching #pdfPane so the two modes occupy the same
// box — and now literally the same declaration, since both read the token
// style.css defines. Wordgard.scrolling() drops the string straight into a
// `height:` in a rule it injects into document.head, where a :root custom
// property is in scope, so a var() reference resolves normally.
const EDITOR_HEIGHT = "var(--pane-height)";

/**
 * Where the three-dots overflow submenu comes from.
 *
 * Wordgard defines one internally but does not export it, so the same path is
 * declared here — the icon is an SVG path in a 100-by-100 box, which is all a
 * `Menu.Label` icon can be.
 */
const OVERFLOW_ICON =
  "M57 77a8 8 0 1 1-16 0 8 8 0 0 1 16 0m0-26a8 8 0 1 1-16 0 8 8 0 0 1 16 0m0-26a8 8 0 1 1-16 0 8 8 0 0 1 16 0";

/**
 * The group the formatting controls actually live in.
 *
 * Not `Menu.Group.inline`, and that is the whole trick. That group is defined
 * with `overflow: {at: 5}`, which wraps everything from its fifth item
 * onwards into a submenu — and it does so *even when a template names the
 * items explicitly*, which was measured: promoting the marks by template left
 * underline and the colour picker in the bar and swallowed highlight,
 * superscript, subscript and the size control into an automatic wrapper. So
 * the count, not anybody's choice, was what hid them in the first place.
 *
 * A group of our own, with no overflow, is what makes the bar's contents a
 * decision rather than a consequence of how many marks the schema happens to
 * define.
 */
const formatting = Menu.Group.define({
  parent: Menu.Group.top,
  // The slot `Menu.Group.inline` would have taken, so the bar reads in the
  // same order as before: commands, formatting, block, insert.
  rank: 50,
  margin: true,
});

/**
 * The marks a prompter script reaches for least, kept out of the bar.
 *
 * Named explicitly rather than left to a count, so the bar cannot reshuffle
 * as marks are added.
 */
const overflow = Menu.Submenu.define({
  label: { icon: OVERFLOW_ICON },
  description: "More",
  arrow: false,
  parent: formatting,
  rank: 150,
});

/**
 * The toolbar, written out rather than resolved from the items' own ranks.
 *
 * `"..."` is where the resolver drops anything it has not been given an
 * explicit place for, so a mark added by a future schema extension still
 * lands somewhere visible instead of vanishing.
 */
function menuTemplate() {
  return Menu.Group.top.template(
    Menu.Group.commands.template("..."),
    formatting.template(
      strong.button,
      emphasis.button,
      underline.button,
      color.button,
      backgroundColor.button,
      superscript.button,
      subscript.button,
      // Anything parented to this group and not named above — the text-size
      // control, and any mark a future schema extension contributes.
      "...",
      overflow.template(strikethrough.button, code.button, link.button),
    ),
    // Still templated, so a mark that arrives parented to Wordgard's own
    // inline group has somewhere to appear rather than vanishing. Empty in
    // practice, since every button the schema defines is placed above.
    Menu.Group.inline.template("..."),
    Menu.Group.block.template("..."),
    Menu.Group.insert.template("..."),
  );
}

function buildConfig(
  onUpdate?: (wg: Wordgard) => void,
  textSize?: TextSizeAccess,
) {
  return [
    fullSchema(),
    history(),
    menuBar({ template: menuTemplate() }),
    // The size control is the operator's own reading size, so it is only
    // offered when the page has a slider to drive — an editor built without
    // one (a test, or a second mount) simply has no such button.
    ...(textSize ? [textSizeMenu(textSize, formatting)] : []),
    // Wordgard's palette is "auto", i.e. it follows prefers-color-scheme — so
    // on a machine set to light it drew its toolbar from the light variant
    // and put a white bar across the top of a page that is dark
    // unconditionally (<html class="wa-dark">). Pinned rather than left to the
    // OS, and style.css lines the resulting dark variant's --wg-* colours up
    // with the Web Awesome surface around it.
    Wordgard.colorScheme.of("dark"),
    // Without this the editor grows to fit its content, the whole control page
    // scrolls instead, and scrollDOM's scrollHeight equals its clientHeight —
    // so the pane has no scroll position of its own to read or set, which the
    // sync-position actions need. It also keeps the right-hand controls on
    // screen while the script is long.
    Wordgard.scrolling(EDITOR_HEIGHT),
    ...(onUpdate
      ? [
        Wordgard.updateListener.of((update) => {
          if (update.docChanged) onUpdate(update.editor);
        }),
      ]
      : []),
  ];
}

// Wordgard.create appends to its parent rather than replacing what's there,
// so an editor swapped in over another one (load a document, or hit New)
// would stack a second editor beside the first. Clear the mount point.
function clearMount(el: Element) {
  el.replaceChildren();
}

export function newEditor(
  el: Element,
  onUpdate?: (wg: Wordgard) => void,
  textSize?: TextSizeAccess,
): Wordgard {
  clearMount(el);
  const wg = Wordgard.create({
    parent: el,
    doc: `<p>New Document</p>`,
    config: buildConfig(onUpdate, textSize),
  });
  return wg;
}

export function saveEditor(wg: Wordgard): unknown {
  return wg.state.toJSON({ history: history.field });
}

export function restoreEditor(
  el: Element,
  json: string,
  onUpdate?: (wg: Wordgard) => void,
  textSize?: TextSizeAccess,
): Wordgard {
  // A document that has never been edited has empty content (Doc's default),
  // which is not parseable state — start a fresh editor rather than throwing
  // out of the load handler and leaving the page with no document at all.
  if (!json.trim()) return newEditor(el, onUpdate, textSize);

  const config = buildConfig(onUpdate, textSize);
  let state;
  try {
    state = GardState.fromJSON(JSON.parse(json), config, {
      history: history.field,
    });
  } catch (err) {
    // Same reasoning as the empty case, for content this editor can't read at
    // all: browsers still carry documents seeded before the Wordgard migration
    // (a Quill delta, which fromJSON rejects as "Invalid document JSON"), and
    // throwing here leaves the page with no editor rather than a usable one.
    // Nothing is overwritten by this — a save only happens on the next edit.
    console.warn("unreadable document content, starting a fresh editor", err);
    return newEditor(el, onUpdate, textSize);
  }
  clearMount(el);
  return Wordgard.create({ parent: el, state });
}
