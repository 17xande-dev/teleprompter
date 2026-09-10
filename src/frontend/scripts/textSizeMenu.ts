// A text-size slider that lives in the editor's own toolbar.
//
// A Wordgard menu extension rather than a Web Awesome control in a popup of
// our own, because it has to sit *in* that bar: the bar is Wordgard's DOM, it
// manages its own focus and keyboard navigation, and a `wa-dropdown` anchored
// to a button inside it would be a second popup system with its own styling,
// its own idea of what "open" means and no share of the menu's arrow-key
// walk. `Menu.CustomControl` is the seam Wordgard provides for exactly this —
// the colour picker is built the same way — and `Wordgard.styles` reaches the
// same `--wg-*` variables style.css already lines up with the Web Awesome
// surface around it, so the popup matches the bar rather than approximating
// it.
//
// It controls the *operator's own* reading size, never the viewers'. That is
// the whole reason it is safe to have under a mouse mid-service: nothing here
// reaches a display. See #applyEditorScale in teleprompter.ts.

import { Menu } from "wordgard/command";
import { Wordgard } from "wordgard/editor";
import type { GardState } from "wordgard/state";

/** What the control needs in order to be the same knob as the slider. */
export interface TextSizeAccess {
  /** Current size, in the tenths of a rem the Editor Text slider uses. */
  get(): number;
  /** Move it. Expected to travel the same path a drag of that slider does. */
  set(tenths: number): void;
  /**
   * Be told when the size changes by any other route, returning an
   * unsubscribe.
   *
   * Needed because `render` runs **once** — measured: the control's DOM is
   * built on the editor's first layout and kept, so the popup does not
   * re-read anything when it is reopened. Without this it showed 4.0 while
   * the transport slider said 2.2, and the operator would have dragged from
   * a number that was not the current size.
   */
  subscribe(listener: (tenths: number) => void): () => void;
  min: number;
  max: number;
  step: number;
}

/**
 * The icon: a large A beside a small one, the usual "text size" glyph.
 *
 * An SVG path drawn inside a 100-by-100 box, which is the only shape
 * `Menu.Label` accepts for an icon — so it cannot be a `wa-icon`, and a
 * `<img>` would not take the bar's `currentColor`.
 */
const ICON =
  "M38 12 12 78h10l7-18h26l7 18h10L46 12zm4 14 10 26H32zM72 44 58 78h7l4-9h14l4 9h7L80 44zm4 9 5 11h-9z";

/**
 * Styles for the popup's contents.
 *
 * Through `Wordgard.styles` rather than style.css because these rules have to
 * land wherever the editor's own stylesheet lands. The editor is mounted
 * inside a `wa-split-panel` slot, and style-mod picks its target by walking
 * `assignedSlot || parentNode` — see the note in CLAUDE.md. Declaring them
 * here means they follow the rest of the theme whatever that walk decides,
 * instead of being a separate rule in the document that might apply to an
 * editor whose own base theme does not.
 */
const theme = Wordgard.styles({
  "wg-text-size": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    // The bar's own size, not the script's. The toolbar lives inside #editor,
    // whose font-size is the prompter's 2rem, and this popup hangs off the
    // toolbar — so without this the readout renders at 32px. Same reason
    // #mainEditor wg-menubar resets it.
    fontSize: "1rem",

    // Descendants are addressed from here rather than by their own class.
    // Wordgard's style keys are *element* selectors — that is the convention
    // its colour picker follows, with `wg-color-picker-color` being a real
    // element — and a key that looks like a class name simply never matches.
    // Measured: the slider kept Chrome's intrinsic 129px width and an
    // `accent-color` of `auto` while its rule sat there doing nothing.
    "& input": {
      // px, not the inherited em: an em would grow as the operator dragged
      // this very slider.
      width: "120px",
      accentColor: "var(--wg-highlight-color)",
    },
    "& span": {
      minWidth: "2.5em",
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
    },
  },
});

/**
 * Build the menu extension.
 *
 * Takes accessors rather than reading storage or the DOM itself, so the
 * toolbar and the Editor Text slider cannot disagree about the size: the
 * slider stays the single source of truth, this moves it, and the same
 * `input` path a drag takes does the rest. The size also changes from the
 * transport slider, its wheel and the two `Mod+Alt+[`/`]` commands, so this
 * subscribes rather than re-reading — see `subscribe`.
 */
export function textSizeMenu(
  access: TextSizeAccess,
  parent: Menu.Group,
): GardState.Extension {
  const control = Menu.CustomControl.define({
    render: () => {
      const dom = document.createElement("wg-text-size");

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = `${access.min}`;
      slider.max = `${access.max}`;
      slider.step = `${access.step}`;
      slider.value = `${access.get()}`;
      slider.setAttribute("aria-label", "Editor text size");

      const readout = document.createElement("span");
      readout.className = "wg-text-size-readout";

      // Tenths of a rem on the wire of this control, the same unit the slider
      // reports, shown as the rem value the operator sees in the transport
      // readout — so the two numbers are the same number.
      const show = () => {
        readout.textContent = (Number(slider.value) / 10).toFixed(1);
      };
      show();

      slider.addEventListener("input", () => {
        access.set(Number(slider.value));
        show();
      });

      // Follow the size when it is changed anywhere else. Unsubscribing on
      // the first callback that finds this input detached is what keeps a
      // session of document switches — each of which builds a fresh editor,
      // and so a fresh control — from accumulating listeners writing to DOM
      // nobody can see. Wordgard offers a custom control no destroy hook, so
      // the control has to notice for itself.
      const off = access.subscribe((tenths) => {
        if (!slider.isConnected) {
          off();
          return;
        }
        slider.value = `${tenths}`;
        show();
      });
      // The menu closes on Enter and Escape by itself; a range input handles
      // its own arrow keys, and stopping propagation is what keeps the menu's
      // own left/right walk from stealing them while this has focus.
      slider.addEventListener("keydown", (e) => {
        if (e.key.startsWith("Arrow")) e.stopPropagation();
      });

      // Without this the popup shut the instant you touched the slider.
      // `MenuBar` listens for `mousedown` on the whole bar and walks up from
      // the target looking for one of its own items; from inside this control
      // that walk arrives at the submenu, which reads as clicking the submenu
      // button a second time — so the menu collapsed and the slider never got
      // the drag.
      //
      // Stopped rather than prevented, though the bar checks
      // `defaultPrevented` first and that would also work: `preventDefault`
      // on a range input's mousedown is what starts a thumb drag, so
      // cancelling it would trade a popup that closes for a slider that
      // cannot be dragged. Stopping propagation leaves the default action
      // alone — the input still takes focus and still drags — and simply
      // keeps the bar from hearing about a gesture that was never aimed at
      // it. `pointerdown` as well, for touch and pen.
      for (const type of ["mousedown", "pointerdown"]) {
        dom.addEventListener(type, (e) => e.stopPropagation());
      }

      dom.append(slider, readout);
      // `focus` is what the menu moves focus to when the submenu opens, which
      // is what makes the slider keyboard-reachable rather than a thing only
      // a pointer can use.
      return { dom, focus: slider };
    },
  });

  const button = Menu.Submenu.define({
    label: { icon: ICON },
    description: "Editor text size",
    arrow: false,
    // The group is passed in rather than named here: editor.ts owns the bar's
    // layout, and taking it as an argument is what keeps this module from
    // importing that one and closing a cycle.
    parent,
    // After the marks and before the overflow submenu, which sits at 150.
    rank: 120,
    content: [control],
  });

  return [button, theme];
}
