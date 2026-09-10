// Small DOM helpers shared by the control page's dropdown/dialog controllers
// (docControls.ts, themeControls.ts) and by teleprompter.ts itself.
// Deliberately not in doc.ts or themes.ts — those are kept DOM-free so they
// can be unit-tested.

/**
 * Escape a user-supplied string for interpolation into innerHTML.
 *
 * Both controllers build their dropdown items as an innerHTML template with
 * the document/theme name in it. The name comes from a text input, so it can
 * contain `"` — which silently truncates an attribute and makes the item stop
 * matching its own id — or `<`, which is parsed as markup. It is the
 * operator's own name in their own browser, but the control page holds the
 * room key, so it is not a place to be relaxed about injection.
 */
export function escapeHtml(s: string): string {
  const el = document.createElement("div");
  el.textContent = s;
  return el.innerHTML;
}

/**
 * Run something when Enter is pressed in a text field.
 *
 * Used to give a single-field dialog and the message box the thing every
 * other text field on the web has: type, press Enter, done. Without it the
 * operator has to tab to the button or reach for the mouse, which mid-service
 * is the difference between sending a cue and missing it.
 *
 * A `keydown` listener rather than wrapping the field in a `<form>`, which is
 * the other obvious answer and worse here on three counts. `wa-dialog` slots
 * its footer buttons, so a form around the dialog's body would not contain
 * the Save button it is supposed to submit, and implicit submission needs the
 * button associated with the form. A form is also a block in the middle of a
 * flex column — `wa-card::part(body)` and the dialog body both are one — so
 * it would take the flex item's place and its children would stop being flex
 * items. And a native submit that ever escapes `preventDefault` navigates:
 * reloading the control page is survivable but it drops every display's link
 * for as long as renegotiation takes, which is not a risk worth taking for a
 * keypress. Clicking the button the operator would have clicked keeps one
 * path, which is the same reason the commands press controls rather than
 * calling handlers.
 *
 * Two guards, both load-bearing. `isComposing` is true while an IME candidate
 * window is open, where Enter accepts the candidate and must not also submit
 * — without it, typing a name in Japanese or Chinese would save the document
 * halfway through a word. And a chord is left alone: `Mod+Enter` is already
 * the "send message" shortcut, and it is `allowWhileTyping`, so plain Enter
 * has to be the only thing this claims or the two would both fire.
 */
export function submitOnEnter(field: Element, run: () => void) {
  field.addEventListener("keydown", (event) => {
    const e = <KeyboardEvent> event;
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // The field is the whole reason a dialog is open, so Enter belongs to it
    // rather than to anything listening further up.
    e.preventDefault();
    e.stopPropagation();
    run();
  });
}
