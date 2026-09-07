import { menuBar, Wordgard } from "wordgard/editor";
import { fullSchema } from "wordgard/schema";
import { history } from "wordgard/history";
import { GardState } from "wordgard/state";

// The editor pane's height, matching #pdfPane so the two modes occupy the same
// box — and now literally the same declaration, since both read the token
// style.css defines. Wordgard.scrolling() drops the string straight into a
// `height:` in a rule it injects into document.head, where a :root custom
// property is in scope, so a var() reference resolves normally.
const EDITOR_HEIGHT = "var(--pane-height)";

function buildConfig(onUpdate?: (wg: Wordgard) => void) {
  return [
    fullSchema(),
    history(),
    menuBar(),
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
): Wordgard {
  clearMount(el);
  const wg = Wordgard.create({
    parent: el,
    doc: `<p>New Document</p>`,
    config: buildConfig(onUpdate),
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
): Wordgard {
  // A document that has never been edited has empty content (Doc's default),
  // which is not parseable state — start a fresh editor rather than throwing
  // out of the load handler and leaving the page with no document at all.
  if (!json.trim()) return newEditor(el, onUpdate);

  const config = buildConfig(onUpdate);
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
    return newEditor(el, onUpdate);
  }
  clearMount(el);
  return Wordgard.create({ parent: el, state });
}
