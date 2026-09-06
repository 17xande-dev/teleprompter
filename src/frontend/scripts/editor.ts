import { menuBar, Wordgard } from "wordgard/editor";
import { fullSchema } from "wordgard/schema";
import { history } from "wordgard/history";
import { GardState } from "wordgard/state";

function buildConfig(onUpdate?: (wg: Wordgard) => void) {
  return [
    fullSchema(),
    history(),
    menuBar(),
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

  const parsed = JSON.parse(json);
  const config = buildConfig(onUpdate);
  const state = GardState.fromJSON(parsed, config, { history: history.field });
  clearMount(el);
  return Wordgard.create({ parent: el, state });
}
