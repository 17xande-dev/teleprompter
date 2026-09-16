// A per-section text size, in the editor's own toolbar.
//
// The Text Scale slider sets how big the whole script is on the displays. This
// is the other half an operator expects from anything that looks like a word
// processor: select a line and make *that* line bigger. It is a custom Wordgard
// mark, because nothing in fullSchema() carries a size — `Color` and
// `BackgroundColor` are the shape to copy, and `Mark.Type.define` with an
// attribute shape is the seam Wordgard provides.
//
// Unlike textSizeMenu.ts next door, this one *does* reach the displays: the
// mark is part of the document, so it travels in the published HTML like any
// other formatting. That is the point — the operator is marking up the script,
// not adjusting their own screen.
//
// All the arithmetic is in sectionsize.ts, which imports nothing: this module
// imports Wordgard and so cannot be unit-tested at all (`deno test` cannot
// resolve it), the same split clock.ts/timer.ts and docControls.ts/doc.ts use.
// Keep it that way — nothing in here should do sums or build format strings.

import { type Command, Menu } from "wordgard/command";
import { Mark, parse } from "wordgard/doc";
import { Dialog, type Wordgard } from "wordgard/editor";
import { GardSelection, GardState } from "wordgard/state";

import {
  clampMultiplier,
  cssFontSize,
  formatMultiplier,
  parseFontSize,
  SECTION_SIZE_DEFAULT,
  SECTION_SIZE_MAX,
  SECTION_SIZE_MIN,
  SECTION_SIZES,
} from "./sectionsize.ts";

/**
 * The mark itself.
 *
 * The name is the key this ends up under in the saved document JSON, so it is
 * a forever decision — and it is prefixed because `Schema.define` refuses two
 * marks of the same name. A future Wordgard release shipping its own
 * `FontSize` or `TextSize` would otherwise fail at editor construction, on
 * every document, rather than merely clashing.
 */
export const SectionSize = Mark.Type.define<number>("tpTextSize", {
  // Between Color (30) and BackgroundColor (35)'s neighbourhood. Attribute
  // marks never nest, so this only orders the declarations inside the one
  // merged style attribute.
  rank: 35,
  // Required, not decoration. editor.js applies an attribute mark to text only
  // when `mark.spanning || !tag.isText`, so without this the mark sits in the
  // document and renders nothing at all — present in the JSON, invisible on
  // every screen.
  spanning: true,
  // A typeof check, deliberately not a range check. A throwing validate makes
  // GardState.fromJSON reject the *whole* document, and restoreEditor turns
  // that into a fresh blank editor — so a single out-of-range number would
  // lose the operator's script. The range is enforced at render time by
  // clampMultiplier instead, where getting it wrong costs a wrong size rather
  // than the text.
  validate: "number",
  shape: {
    // "style/font-size" rather than "style": an attribute shape with a
    // readAttribute has its parse rule derived automatically, so the format is
    // written down once. Alignment uses a bare "style" and needs explicit
    // parseRules to match; this does not.
    attribute: "style/font-size",
    value: (m) => cssFontSize(m),
    readAttribute: (v) => parseFontSize(v) ?? parse.Reject,
  },
});

/**
 * The toolbar control: a submenu of one button per size.
 *
 * Buttons rather than a `Menu.CustomControl` — which is what the editor's own
 * reading-size slider next door uses — because a CustomControl's `render` runs
 * exactly once and it has no update hook. That is survivable for a control
 * whose state is a stored preference it can subscribe to; it is not survivable
 * here, where the state is *the current selection's* size and changes on every
 * cursor move. Such a control would show a stale number and the operator would
 * set a size starting from a value that is not the one they are looking at.
 * A button's `active` is re-evaluated on every document and selection change,
 * which also makes the set behave as a radio group for free.
 *
 * The submenu takes no `label`, so Wordgard labels it from whichever child is
 * active and falls back to `defaultLabel` — the same way its own textblock
 * dropdown reads "Paragraph" or "Heading 1". `width` is in ch, so the bar does
 * not resize as that label changes.
 *
 * `parent` is passed in rather than imported so this module never depends on
 * editor.ts, which imports it — the same reason textSizeMenu.ts takes one.
 */
/**
 * Set a size over the selection, or arm it for what is typed next.
 *
 * Two branches because a mark is two different things depending on the
 * selection, and this is the shape Wordgard's own `setColor` uses. With a range
 * selected the mark is added over it; with a bare cursor there is nothing to
 * mark, so it goes into the selection's stored marks and applies to the next
 * thing typed. `addToSet` is documented to *overwrite* an existing instance of
 * the same mark type, which is why setting 200% over a 150% run replaces it
 * rather than nesting — verified in the browser.
 *
 * `close` is dispatched in the same transaction as the change, which the Dialog
 * docs ask for: left to close itself the dialog fires a second transaction
 * immediately afterwards, and that lands in the undo history as a separate step.
 */
function applySectionSize(
  wg: Wordgard,
  multiplier: number,
  close: ReturnType<typeof Dialog.show>["close"],
) {
  const { state } = wg;
  const mark = SectionSize.of(clampMultiplier(multiplier));
  const { selection } = state;
  if (selection instanceof GardSelection.Text && selection.empty) {
    wg.dispatch({
      selection: GardSelection.Text.create({
        anchor: selection.anchor,
        headSide: selection.headSide,
        goalColumn: selection.goalColumn,
        marks: mark.addToSet(state.sel.activeMarks),
      }),
      userEvent: "mark.add",
      effects: close,
    });
    return;
  }
  wg.dispatch({
    changes: selection.ranges.map((r) => ({
      from: r.from,
      to: r.to,
      add: mark,
    })),
    userEvent: "mark.add",
    effects: close,
  });
}

/**
 * Ask for a size the presets do not offer.
 *
 * `Dialog.show` rather than a popup of our own: it is the mechanism Wordgard
 * uses for its own image insertion, it builds the labelled form and the input
 * from this config, and it wires up submit and Escape itself. Nothing here has
 * to know how the editor's panels are laid out or styled.
 *
 * The command returns `true` before the operator has typed anything, because a
 * Command must answer synchronously and the answer is "yes, this was handled" —
 * the dialog is open. The work happens when the promise resolves, and a
 * cancelled dialog resolves to null, which is why the `form` is checked rather
 * than assumed.
 */
const promptForSectionSize: Command = (wg) => {
  if (wg.state.readOnly) return false;
  const existing = SectionSize.isInSet(wg.state.sel.activeMarks);
  const current = Math.round((existing?.value ?? SECTION_SIZE_DEFAULT) * 100);

  const { close, result } = Dialog.show(wg, {
    label: "Text size (%)",
    input: {
      type: "number",
      min: `${SECTION_SIZE_MIN * 100}`,
      max: `${SECTION_SIZE_MAX * 100}`,
      step: "5",
      value: `${current}`,
      // The presets are round numbers; this box exists for the ones that are
      // not, so it accepts anything in range rather than snapping to the step.
      "aria-label": "Text size, percent",
    },
    submitLabel: "Set",
    class: "wg-tp-size-dialog",
    focus: true,
  });

  result.then((form) => {
    if (!form) return; // Escaped or dismissed: nothing to apply, nothing to close.
    const raw = form.querySelector("input")?.value ?? "";
    const percent = Number(raw);
    if (!Number.isFinite(percent) || raw.trim() === "") {
      // An empty or unreadable box is not a size. Close without touching the
      // document — clampMultiplier would turn NaN into 100% and silently
      // "apply" a change the operator did not ask for.
      wg.dispatch({ effects: close });
      return;
    }
    applySectionSize(wg, percent / 100, close);
  });

  return true;
};

export function sectionSizeMenu(parent: Menu.Group): GardState.Extension {
  const buttons = SECTION_SIZES.map((m, i) =>
    Menu.Button.toggleMark({
      mark: SectionSize.of(clampMultiplier(m)),
      label: formatMultiplier(m),
      rank: 10 + i,
    })
  );

  const custom = Menu.Button.define({
    run: promptForSectionSize,
    // Short, because this label can end up in the bar: a submenu with no
    // `label` of its own shows whichever child is active, so a 137% run shows
    // this one. "Custom size…" would be truncated at the submenu's width.
    label: "Other…",
    // After the presets, so the common choices stay under the pointer.
    rank: 100,
    enable: (state) => !state.readOnly,
    // Active when a size is set that no preset offers. Without this the bar
    // read "100%" with the cursor in a 1.37em run — the submenu falls back to
    // its defaultLabel when no child is active, so it claimed a size that was
    // not set. Measured; it is the one thing a size control must not do.
    active: (state) => {
      const mark = SectionSize.isInSet(state.sel.activeMarks);
      if (!mark) return false;
      return !SECTION_SIZES.some((m) => m === mark.value);
    },
  });

  const submenu = Menu.Submenu.define({
    // What the bar reads when the selection carries no size, which is most of
    // the time — so it says the size the text actually is, not the name of the
    // control.
    defaultLabel: formatMultiplier(SECTION_SIZE_DEFAULT),
    width: 5,
    parent,
    // After the editor's own text-size control (120) and before the
    // three-dots overflow (150).
    rank: 125,
    // Resolved directly from here rather than through the facet and a "..."
    // hole, so which sizes are offered is a decision in this file instead of a
    // consequence of rank ordering.
    content: [...buttons, custom],
  });

  // The mark has to be *in the schema*, and the config array does not accept a
  // bare Mark.Type: it goes through this facet. Wordgard's own color() does
  // exactly this — `[GardState.schemaElement.of(Color), color.button, ...]`.
  return [GardState.schemaElement.of(SectionSize), submenu];
}
