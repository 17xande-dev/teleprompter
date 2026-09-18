// controlframes.ts — splitting an oversized control message across several
// data-channel sends, and putting it back together.
//
// **A data channel refuses a message larger than the SCTP association's
// max-message-size**, and in Chrome that is 256KB: `send` throws
// `TypeError: Trying to send message larger than max-message-size`. The
// control channel carries the whole script as one JSON string, and a pasted
// service script goes past 256KB easily — measured, 143KB of HTML went through
// and 333KB threw. The throw is worse than the failure it reports: it happens
// inside the editor's update listener, so it takes the rest of that handler
// with it (the preview never learns either), and it repeats on every later
// edit. The display simply stays on the last script small enough to fit, with
// nothing on screen saying so.
//
// Same shape as filetransfer.ts, and apart from webrtc.ts for the same reason:
// the boundary cases are worth testing without a DOM or a real channel. The
// difference is that this carries *strings* — the file channel's framing tells
// bytes from metadata with `typeof`, which a JSON-only channel cannot do — so a
// part is a JSON envelope of its own and the key is `k`, never `type`, so a
// part can never be mistaken for a `ControlMessage`.

/**
 * How much of a message goes in one part, in UTF-16 code units.
 *
 * 16K code units is at most 64KB of UTF-8 even if every character were
 * four-byte, so a part is comfortably inside every browser's limit without
 * depending on SCTP fragmentation having been negotiated — the same reasoning
 * as `CHUNK_SIZE` in filetransfer.ts, and the same number for the same reason.
 */
export const CONTROL_CHUNK_SIZE = 16 * 1024;

type Part = {
  k: "part";
  /** Which message this belongs to; a new one supersedes whatever was in flight. */
  id: number;
  i: number;
  n: number;
  s: string;
};

/** Whether a decoded control-channel payload is one piece of a larger message. */
export function isPart(data: unknown): data is Part {
  if (!data || typeof data !== "object") return false;
  const p = data as Partial<Part>;
  return p.k === "part" && typeof p.id === "number" &&
    typeof p.i === "number" && typeof p.n === "number" &&
    typeof p.s === "string";
}

/**
 * Where to cut a string so a surrogate pair is never split.
 *
 * A lone surrogate is not encodable as UTF-8: the channel would replace it with
 * U+FFFD at each end of the cut, and the rejoined JSON would be corrupt — in
 * the best case a parse error, in the worst a script with a mangled character
 * in front of the talent. Emoji and anything outside the BMP hit this, and a
 * pasted script is exactly where those turn up.
 */
function cutAt(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  // A high surrogate at the end of the slice owns the character that follows.
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Split a control message's JSON into parts, or yield it whole.
 *
 * A generator, like `chunkFile`, so the caller can stop between parts when the
 * channel's buffer fills and resume without a second copy in memory.
 *
 * A message that fits is yielded **unchanged**, so the common case — every
 * message but the script — stays a single send with no envelope, and a viewer
 * built before this existed still understands everything it used to.
 */
export function* chunkControl(
  json: string,
  id: number,
  chunkSize: number = CONTROL_CHUNK_SIZE,
): Generator<string> {
  if (json.length <= chunkSize) {
    yield json;
    return;
  }
  // Counted by walking the same cuts the loop will make, rather than by
  // dividing: a cut moved back off a surrogate pair makes a part shorter, so
  // the arithmetic answer can be one part short of the truth.
  const cuts: number[] = [];
  for (let at = 0; at < json.length;) {
    const end = cutAt(json, at + chunkSize);
    cuts.push(end);
    at = end;
  }
  for (let i = 0; i < cuts.length; i++) {
    const part: Part = {
      k: "part",
      id,
      i,
      n: cuts.length,
      s: json.slice(i === 0 ? 0 : cuts[i - 1], cuts[i]),
    };
    yield JSON.stringify(part);
  }
}

/**
 * A sink for control-channel payloads that calls `onMessage` with whole JSON.
 *
 * The channel is ordered and reliable, so parts cannot arrive out of order or
 * go missing — but a message can be **superseded**, which is the case worth
 * handling: with live editing on, a keystroke queues a fresh copy of the script
 * while the last one is still going out, and the sender abandons the old one
 * mid-flight. A part carrying a new `id` therefore discards what was in
 * progress rather than appending to it, and a part whose `id` is older than the
 * one being assembled is a straggler from an abandoned message and is dropped.
 */
export function makeControlReassembler(
  onMessage: (json: string) => void,
): (raw: string) => void {
  let id = -1;
  let parts: string[] = [];
  let have = 0;

  return (raw: string) => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Not our framing and not a message either. Dropping is the only option
      // that leaves the channel usable for whatever comes next.
      return;
    }
    if (!isPart(data)) {
      onMessage(raw);
      return;
    }
    if (data.id !== id) {
      // Only ever forward: a straggler from a superseded message would
      // otherwise reset the one now being assembled and strand it forever.
      if (data.id < id) return;
      id = data.id;
      parts = new Array(data.n).fill("");
      have = 0;
    }
    if (data.i < 0 || data.i >= parts.length || parts[data.i]) return;
    parts[data.i] = data.s;
    have++;
    if (have < parts.length) return;
    const json = parts.join("");
    parts = [];
    have = 0;
    onMessage(json);
  };
}
