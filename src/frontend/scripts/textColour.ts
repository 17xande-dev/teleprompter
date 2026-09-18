// Applying a colour to the selected script, from outside the editor's toolbar.
//
// The shortcuts and the colour palette live on the control page, but the mark
// they set belongs to the document, so this is the seam between them. It
// imports Wordgard and therefore cannot be unit-tested at all (`deno test`
// cannot resolve it) — so it does no arithmetic and makes no decisions: the
// list, the search text and the contrast bar are in colours.ts, which is
// tested, and this file only dispatches. Same split as clock.ts / timer.ts.

import type { Wordgard } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { Color } from "wordgard/types";

/**
 * Colour the selection, or set the colour the next typing will carry.
 *
 * Both halves are needed and they are not the same transaction. With a range
 * selected the operator means "this text"; with a bare cursor they mean "what
 * I type next", which is a *stored mark* on the selection rather than a change
 * to the document — and without that branch, pressing Ctrl+Alt+Y before typing
 * a cue would appear to do nothing at all. This is the shape `applySectionSize`
 * already uses for the per-section size mark, deliberately: two marks applied
 * from two places should not behave differently.
 *
 * An empty `hex` clears the colour rather than setting one. `remove` takes a
 * mark of the type to strip, and the parameter is ignored for a plain
 * attribute mark — `Color.of("")` is how the value is spelled, not a colour
 * being applied. A cleared run inherits `--viewer-color` and so follows a user
 * theme, which is why "Default" is not simply white.
 *
 * Nothing here talks to the displays. The editor's own update listener fires
 * on the resulting transaction, which is what reaches `saveEditorContent` and,
 * with live editing on, the viewers — so a colour travels exactly as a typed
 * character does and cannot take a different path.
 */
export function applyTextColour(wg: Wordgard, hex: string) {
  const { state } = wg;
  const { selection } = state;
  if (state.readOnly) return;

  // A cursor with no selection means "what I type next", which is a *stored
  // mark* on the selection rather than a change to the document. Without this
  // branch, pressing Ctrl+Alt+Y before typing a cue would appear to do
  // nothing at all. `selection.marks || state.sel.head.marks()` is Wordgard's
  // own spelling in setColor: the selection's stored marks if it has any,
  // otherwise whatever the text at the cursor carries.
  if (selection instanceof GardSelection.Text && selection.empty) {
    const current = selection.marks || state.sel.head.marks();
    const marks = hex
      ? Color.of(hex).addToSet(current)
      : Color.removeFromSet(current);
    wg.dispatch({
      selection: GardSelection.Text.create({
        anchor: selection.anchor,
        headSide: selection.headSide,
        goalColumn: selection.goalColumn,
        marks,
      }),
      userEvent: hex ? "mark.add" : "mark.remove",
    });
    return;
  }

  if (hex) {
    wg.dispatch({
      changes: selection.ranges.map((r) => ({
        from: r.from,
        to: r.to,
        add: Color.of(hex),
      })),
      userEvent: "mark.add",
    });
    wg.focus();
    return;
  }

  // **Clearing is not "remove Color.of("")".** An attribute mark is matched by
  // its value, so removing an empty-valued Color leaves a `#ffd400` run
  // exactly as it was — verified in the browser, where the span survived the
  // shortcut with nothing reported. A range can also hold several different
  // colours at once. So the document is walked and each mark instance that is
  // actually present is removed, which is what Wordgard's own `setColor` does
  // for the clear option in its colour picker.
  const changes: {
    from: number;
    to: number;
    remove: ReturnType<typeof Color.of>;
  }[] = [];
  for (const { from, to } of selection.ranges) {
    state.doc.iterate(from, to, (node, pos) => {
      const has = Color.isInSet(node.marks);
      if (has) {
        changes.push({
          from: Math.max(from, pos),
          to: Math.min(to, pos + node.length),
          remove: has,
        });
      }
    });
  }
  wg.dispatch({ changes, userEvent: "mark.remove" });
  // The editor keeps focus deliberately: these are reached mid-sentence from
  // the keyboard, and a colour that stole focus would end the operator's
  // typing run. The palette closes itself before running a command, which is
  // what hands focus back here.
  wg.focus();
}
