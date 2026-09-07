// The CSS editor behind the viewer-theme dialog. Deliberately shaped like
// editor.ts (the Wordgard wrapper) so the two read the same way, but a
// different library: Wordgard is a rich-text system whose state is a JSON
// document, and what a theme needs is a plain string of code.
//
// Control page only — see the note on the CodeMirror imports in deno.jsonc.

import { css } from "@codemirror/lang-css";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";

// Same trap as Wordgard's clearMount: an editor created over another one
// leaves both in the DOM, stacked. The theme dialog is reused for every
// theme, so its mount is guaranteed to be dirty on the second open.
function clearMount(el: Element) {
  el.replaceChildren();
}

export function newCssEditor(
  el: Element,
  doc: string,
  onUpdate?: (text: string) => void,
): EditorView {
  clearMount(el);
  return new EditorView({
    parent: el,
    // Not optional. CodeMirror decides where to inject its stylesheet with a
    // getRoot() that walks `node.assignedSlot || node.parentNode` — and this
    // mount is a light-DOM child of <wa-dialog>, which projects it through a
    // <slot> into a <dialog> in its shadow root. So the walk lands on that
    // shadow root, style-mod takes its adoptedStyleSheets branch, and the
    // whole base theme plus oneDark gets adopted somewhere it can never apply:
    // slotted content is styled by the document, not by the shadow tree it is
    // projected into. The symptom is an editor with no `white-space: pre`, no
    // flex layout and no gutter — a plain box with numbers stacked in it.
    // The content really does live in the document, so this is also the right
    // root for CodeMirror's selection and activeElement handling.
    root: document,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        css(),
        // The control page runs wa-dark; a light editor in it would glare.
        oneDark,
        EditorView.lineWrapping,
        ...(onUpdate
          ? [
            EditorView.updateListener.of((update) => {
              if (update.docChanged) onUpdate(cssText(update.view));
            }),
          ]
          : []),
      ],
    }),
  });
}

export function cssText(view: EditorView): string {
  return view.state.doc.toString();
}
