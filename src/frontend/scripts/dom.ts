// Small DOM helpers shared by the control page's two dropdown/dialog
// controllers (docControls.ts, themeControls.ts). Deliberately not in doc.ts
// or themes.ts — those are kept DOM-free so they can be unit-tested.

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
