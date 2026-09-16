// Applying tidy.ts's rules to a document.
//
// Split from tidy.ts because this half needs a DOM, so `deno test` cannot reach
// it — the same split contrast.ts/pasteColors.ts and clock.ts/timer.ts use.
// Every decision about what counts as blank lives next door and is tested; what
// is left here is the walk, and it must stay that way.

import {
  isBlankText,
  normaliseSpaces,
  TIDY_MAX_BLANK_BLOCKS,
  TIDY_MAX_BREAKS,
  trimLineEnd,
  trimLineStart,
} from "./tidy.ts";

const TEXT_NODE = 3;

/** A block that shows nothing, so it is a blank line and nothing more. */
function isBlankBlock(el: Element): boolean {
  // A rule or an image shows something without holding any text, and removing
  // one because `textContent` is empty would delete content rather than
  // spacing. This is the guard that stops a tidy eating a scene divider.
  if (el.tagName === "HR") return false;
  if (el.querySelector("img, hr, figure, video")) return false;
  return isBlankText(el.textContent ?? "");
}

/**
 * The block's contents in reading order, keeping only what a line is made of.
 *
 * Text nodes and `<br>`s, flattened out of whatever spans the marks have
 * wrapped them in — because a line is not a DOM subtree. `<em>one</em><br>two`
 * has its break between two different parents, so anything reasoning about
 * "the start of a line" has to look at this order rather than at siblings.
 */
function lineParts(block: Element): (Text | Element)[] {
  const parts: (Text | Element)[] = [];
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === TEXT_NODE) parts.push(<Text> node);
    else if ((<Element> node).tagName === "BR") parts.push(<Element> node);
  }
  return parts;
}

function isText(node: Text | Element): node is Text {
  return node.nodeType === TEXT_NODE;
}

/**
 * Collapse runs of line breaks, and drop the ones dangling at the end.
 *
 * A blank text node between two breaks does not interrupt the run — Docs emits
 * `<br> <br>` freely — so only text a reader would see resets the count. A
 * non-BR element does not reset it either: a `<span>` is just a mark's wrapper
 * and the next line's text may be inside it.
 */
function collapseBreaks(block: Element) {
  const parts = lineParts(block);
  const doomed: Element[] = [];
  let run = 0;
  for (const part of parts) {
    if (isText(part)) {
      if (!isBlankText(part.data)) run = 0;
      continue;
    }
    run++;
    if (run > TIDY_MAX_BREAKS) doomed.push(part);
  }
  // Trailing breaks put a blank line at the end of a block, where the next
  // block's own spacing already does that job.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (isText(part)) {
      if (!isBlankText(part.data)) break;
      continue;
    }
    doomed.push(part);
  }
  for (const br of doomed) br.remove();
}

/**
 * Trim each line's own leading and trailing whitespace.
 *
 * Per *line*, not per block, which is why this needs `lineParts`: a block can
 * hold several lines separated by breaks, and whitespace before a `<br>` is
 * trailing whitespace even though it sits in the middle of the block.
 */
function trimLines(block: Element) {
  const parts = lineParts(block);

  // Whether nothing a reader would see lies between this part and the start (or
  // end) of its line. **Blank text nodes are skipped rather than counted**, and
  // that is the whole reason these are loops instead of a look at the
  // neighbour. A mark that has been split leaves empty text nodes behind, and
  // Docs emits `<span></span>` freely — so `<p><span></span>   Indented</p>`
  // has a blank text node in front of the indent. Testing only the immediate
  // neighbour, that indent was not at the start of a line and survived the
  // tidy: it left 7 of 106 indented lines untouched in the measured document,
  // which is how this was found.
  const atLineStart = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isText(part)) return true; // a break: this is a new line
      if (!isBlankText(part.data)) return false;
    }
    return true;
  };
  const atLineEnd = (i: number) => {
    for (let j = i + 1; j < parts.length; j++) {
      const part = parts[j];
      if (!isText(part)) return true;
      if (!isBlankText(part.data)) return false;
    }
    return true;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isText(part)) continue;
    let text = normaliseSpaces(part.data);
    if (atLineStart(i)) text = trimLineStart(text);
    if (atLineEnd(i)) text = trimLineEnd(text);
    part.data = text;
  }
}

/**
 * Tidy a serialized document in place.
 *
 * Takes the fragment rather than an HTML string so the caller can hand over
 * exactly what `serialize()` produced, with no trip through the HTML parser to
 * reinterpret it.
 *
 * Nothing here touches `.pdf-page`, marks, or any attribute: a tidy changes
 * whitespace and empty space, never formatting. That is deliberate — an
 * operator reaches for this mid-preparation and must not find their sizes and
 * colours quietly rewritten.
 */
export function tidyFragment(root: DocumentFragment | Element) {
  const blocks = [...root.children];

  for (const block of blocks) {
    // Code blocks keep their whitespace: indentation is the content there, and
    // the schema marks them whitespace-preserving for the same reason.
    if (block.tagName === "PRE" || block.querySelector("pre")) continue;
    // Normalise first, so everything after it can reason in plain spaces.
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      (<Text> node).data = normaliseSpaces((<Text> node).data);
    }
    collapseBreaks(block);
    trimLines(block);
  }

  // Runs of blank blocks, counted across the document rather than within one.
  let run = 0;
  for (const block of blocks) {
    if (!isBlankBlock(block)) {
      run = 0;
      continue;
    }
    run++;
    if (run > TIDY_MAX_BLANK_BLOCKS) block.remove();
  }

  // Blank blocks at either end are spacing against nothing.
  while (
    root.firstElementChild && isBlankBlock(root.firstElementChild) &&
    root.children.length > 1
  ) {
    root.firstElementChild.remove();
  }
  while (
    root.lastElementChild && isBlankBlock(root.lastElementChild) &&
    root.children.length > 1
  ) {
    root.lastElementChild.remove();
  }
  // `children.length > 1` on both, because a document needs a block to put the
  // cursor in: tidying a script that is *only* blank lines down to nothing
  // would leave the schema with an empty document to parse.
}
