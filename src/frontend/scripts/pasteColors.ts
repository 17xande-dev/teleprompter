// Applying contrast.ts to a pasted HTML fragment.
//
// Split from contrast.ts because this half needs a DOM and CSSOM, so `deno
// test` cannot reach it — the same reason clock.ts is separate from timer.ts.
// Everything that can be got wrong about a *colour* is next door and tested;
// what is left here is attribute plumbing, and it must stay that way. Nothing
// in this file should do arithmetic or decide anything about a colour.

import {
  adaptBackgroundColor,
  brightenTextColor,
  type ColorVerdict,
  parseCssColor,
} from "./contrast.ts";

/** Apply one verdict to one property of one element's inline style. */
function applyVerdict(
  style: CSSStyleDeclaration,
  property: string,
  verdict: ColorVerdict,
) {
  if (verdict.kind === "keep") return;
  if (verdict.kind === "drop") {
    style.removeProperty(property);
    return;
  }
  style.setProperty(property, verdict.value);
}

/**
 * Rewrite the colours in a pasted HTML fragment so it reads on a dark screen.
 *
 * Called from Wordgard's `clipboardInputHTMLFilter`, which runs on the raw
 * `text/html` *before* it is parsed — so the content arrives in the document
 * already correct and nothing downstream, not the editor, not `pushContent`,
 * not a single display, has to know this happened.
 *
 * **A `<template>`, not a `div` and not `DOMParser`.** All three parse HTML;
 * only one of them is right here. A `div` in the live document would fetch
 * Word's `<img>` side-files the moment the markup lands. `DOMParser` with
 * `body.innerHTML` drops a bare `<tr>…</tr>` fragment on the floor, because a
 * table row outside a table is not allowed there — which is exactly why
 * Wordgard carries a `wrapMap` of its own. A template's content is parsed in
 * the "in template" insertion mode, which keeps orphan rows and cells, and it
 * is inert, so nothing loads.
 */
export function brightenPastedHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;

  // Our own content, coming back in. Wordgard stamps this on the first element
  // of anything copied *out* of an editor and looks for it on the way in, so a
  // copy-paste within the script is left byte-identical rather than put through
  // a transform it has already been through. contrast.ts is idempotent anyway;
  // this makes the common case free as well as safe.
  if (template.content.querySelector("[wg-content=true]")) return html;

  for (const el of template.content.querySelectorAll<HTMLElement>("*")) {
    // Only what the browser's own CSS parser accepted. An unreadable
    // declaration is already gone by this point, which is how Word's
    // `color: windowtext` handles itself.
    const color = el.style.getPropertyValue("color");
    if (color) applyVerdict(el.style, "color", brightenTextColor(color));

    // Read as `background-color`, but cleared as both: Word writes
    // `background: yellow`, CSSOM expands the shorthand so the longhand is
    // readable, and removing only the longhand leaves the shorthand to win.
    const background = el.style.getPropertyValue("background-color");
    if (background) {
      const verdict = adaptBackgroundColor(background);
      if (verdict.kind !== "keep") {
        el.style.removeProperty("background");
        el.style.removeProperty("background-color");
      }
      if (verdict.kind === "replace") {
        el.style.setProperty("background-color", verdict.value);
      }
    }

    // The legacy presentational attributes, promoted to inline styles.
    //
    // Worth doing rather than ignoring: this schema has no parse rule for
    // either, so `<font color="red">` currently loses its red altogether — a
    // pre-existing gap, but this is the one place in the codebase that is
    // already looking at pasted colours. Promoting them means the colour
    // survives *and* gets corrected. Black text in a <font> tag was already
    // fine by accident (it arrived unstyled, so it inherited the bright
    // default), so only the coloured cases change.
    upgradeAttribute(el, "color", "color", brightenTextColor);
    upgradeAttribute(el, "bgcolor", "background-color", adaptBackgroundColor);

    // A style attribute emptied by the above is noise in the document and in
    // every `content` message that follows.
    if (el.hasAttribute("style") && !el.getAttribute("style")) {
      el.removeAttribute("style");
    }
  }

  // Deliberately nothing for `class`-based colouring, and this is the first
  // question a reader will have. It cannot be resolved: the colour lives in a
  // stylesheet we do not have, the `<style>` block Word ships alongside cannot
  // apply in a detached fragment, and `class` produces no mark in this schema
  // anyway. So class-coloured text arrives with no colour at all and inherits
  // the viewer's ink — which is the outcome we would have wanted.

  return template.innerHTML;
}

function upgradeAttribute(
  el: HTMLElement,
  attribute: string,
  property: string,
  decide: (value: string) => ColorVerdict,
) {
  const raw = el.getAttribute(attribute);
  if (!raw || !parseCssColor(raw)) return;
  const verdict = decide(raw);
  el.removeAttribute(attribute);
  // "keep" means the colour was already fine, which for an attribute still
  // means moving it — unmoved it is a colour this schema silently discards.
  if (verdict.kind === "keep") el.style.setProperty(property, raw);
  else applyVerdict(el.style, property, verdict);
}
