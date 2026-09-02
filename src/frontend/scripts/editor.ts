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

export function newEditor(
  el: Element,
  onUpdate?: (wg: Wordgard) => void,
): Wordgard {
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
  const parsed = JSON.parse(json);
  const config = buildConfig(onUpdate);
  const state = GardState.fromJSON(parsed, config, { history: history.field });
  return Wordgard.create({ parent: el, state });
}
