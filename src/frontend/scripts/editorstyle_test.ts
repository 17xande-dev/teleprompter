// A CSS rule whose failure mode is a caret in the wrong place.
//
// Wordgard draws its own caret — `caret-color` is transparent and a
// `wg-cursor` element is positioned inside `wg-cursor-layer` — and that layer
// is placed from the scroller, accounting for the content's *padding* but not
// for a margin put on it afterwards. So indenting `wg-content` with a margin
// moves the text and leaves the caret behind: measured in the browser at 12.9px
// left of the text, at every position along the line, which at prompter sizes
// draws the caret on top of the last letter instead of after it.
//
// Checked against the stylesheet on disk because there is nowhere else it
// could be checked: no unit test renders CSS, type-checking cannot see it, and
// in a screenshot it reads as a rendering quirk rather than as something this
// repo did. `docs_test.ts` reads a file for the same kind of reason.
import { assert } from "@std/assert";

const STYLE_PATH = "src/frontend/styles/style.css";

/** The declarations inside the first rule block with this selector. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector + " {");
  assert(at >= 0, `${STYLE_PATH} has no \`${selector}\` rule`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

Deno.test("the editor's gutter is padding, never margin", async () => {
  const css = await Deno.readTextFile(STYLE_PATH);
  const body = ruleBody(css, "#editor wg-content");

  assert(
    /padding-inline-start|padding-left|padding:/.test(body),
    "the script's left gutter has to be padding — a margin leaves the drawn " +
      "caret behind the text",
  );
  assert(
    !/margin-inline-start|margin-left|margin:/.test(body),
    "margin on wg-content puts every caret to the left of where it belongs; " +
      "use padding, which Wordgard's cursor layer accounts for",
  );
});

Deno.test("the editor states its own selection colour", async () => {
  const css = await Deno.readTextFile(STYLE_PATH);
  const body = ruleBody(css, "#editor ::selection");
  // Left to the browser, an unfocused document is given a grey selection that
  // is nearly invisible against this near-black editor — and an operator's
  // window loses focus constantly, not least to the display they popped out.
  assert(
    /background-color/.test(body),
    "the selection needs a stated background, or an unfocused window paints " +
      "it in a grey that vanishes on a dark editor",
  );
  assert(
    /color:/.test(body),
    "the selection needs a stated text colour: the script carries its own " +
      "colours, and pasted red on a blue selection is unreadable",
  );
});
