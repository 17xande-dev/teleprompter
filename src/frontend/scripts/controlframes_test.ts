// No DOM and no RTCDataChannel: the point of splitting this out of webrtc.ts
// is that the boundary cases — a surrogate pair on a cut, a superseded
// message, a straggler — can be checked without a browser, the same way
// filetransfer_test.ts checks the file framing.
import { assert, assertEquals } from "@std/assert";

import {
  chunkControl,
  CONTROL_CHUNK_SIZE,
  isPart,
  makeControlReassembler,
} from "./controlframes.ts";

/** Send a message through the framing and back, as the channel would. */
function roundTrip(json: string, chunkSize?: number, id = 1) {
  const got: string[] = [];
  const reassemble = makeControlReassembler((m) => got.push(m));
  const frames = [...chunkControl(json, id, chunkSize)];
  for (const f of frames) reassemble(f);
  return { got, frames };
}

Deno.test("a message that fits is sent unchanged, with no envelope", () => {
  const json = JSON.stringify({ type: "settings", textScale: 3 });
  const { got, frames } = roundTrip(json);
  assertEquals(frames, [json]);
  assertEquals(got, [json]);
  // Which is what keeps every message but the script a single send — and what
  // a viewer built before this framing existed still understands.
  assertEquals(isPart(JSON.parse(frames[0])), false);
});

Deno.test("an oversized message survives the round trip", () => {
  // The case this exists for: Chrome refuses a single send over 256KB, and a
  // pasted service script is past that. Measured on the real app, 143KB of
  // HTML went through and 333KB threw.
  const html = "<p>Line of a script that someone will read aloud.</p>".repeat(
    12_000,
  );
  const json = JSON.stringify({ type: "content", html });
  assert(json.length > 512 * 1024, "the test script has to be over the limit");
  const { got, frames } = roundTrip(json);
  assert(frames.length > 30, `expected many parts, got ${frames.length}`);
  for (const f of frames) {
    assert(
      f.length < CONTROL_CHUNK_SIZE * 2,
      `a part must stay well inside the limit, got ${f.length}`,
    );
  }
  assertEquals(got.length, 1);
  assertEquals(got[0], json);
  assertEquals(JSON.parse(got[0]).html, html);
});

Deno.test("a surrogate pair is never split across two parts", () => {
  // A lone surrogate is not encodable as UTF-8, so a cut through a pair would
  // put U+FFFD at both ends of it — a parse error at best, and a mangled
  // character in front of the talent at worst. Emoji in a pasted script are
  // exactly where this turns up.
  // The odd leading character is what makes this test sharp: an emoji is two
  // code units, so a cut every 8 lands between pairs and splits nothing at
  // all. Offset by one and every cut falls *inside* a pair — without the
  // guard the assertions below fail, which is how this was checked.
  const json = "a" + "😀".repeat(50);
  const { got, frames } = roundTrip(json, 8);
  assert(frames.length > 5, "the message has to be split to test the cut");
  for (const f of frames) {
    const s = JSON.parse(f).s as string;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      const high = code >= 0xd800 && code <= 0xdbff;
      const low = code >= 0xdc00 && code <= 0xdfff;
      if (high) assert(i + 1 < s.length, "a part ends on half a character");
      if (low) assert(i > 0, "a part starts on half a character");
    }
  }
  assertEquals(got, [json]);
});

Deno.test("every part is accounted for, and the count is not guessed", () => {
  // Cuts moved back off a surrogate pair make parts shorter, so a count
  // derived by dividing the length can be one short — and a receiver waiting
  // for a part that never comes never delivers the message at all.
  const json = "a😀b😀c😀d😀e😀".repeat(20);
  const frames = [...chunkControl(json, 7, 6)];
  const parts = frames.map((f) => JSON.parse(f));
  assertEquals(parts.length, parts[0].n);
  assertEquals(parts.map((p) => p.i), parts.map((_, i) => i));
  assertEquals(parts.map((p) => p.s).join(""), json);
});

Deno.test("a newer message supersedes one still arriving", () => {
  // With live editing on, a keystroke queues a fresh copy of the script while
  // the last is still going out, and the sender abandons it mid-flight.
  const got: string[] = [];
  const reassemble = makeControlReassembler((m) => got.push(m));
  const first = JSON.stringify({ type: "content", html: "old".repeat(4000) });
  const second = JSON.stringify({ type: "content", html: "new".repeat(4000) });
  const firstFrames = [...chunkControl(first, 1, 1024)];
  const secondFrames = [...chunkControl(second, 2, 1024)];

  for (const f of firstFrames.slice(0, 2)) reassemble(f);
  assertEquals(got, [], "an incomplete message must not be delivered");
  for (const f of secondFrames) reassemble(f);
  assertEquals(got.length, 1);
  assertEquals(JSON.parse(got[0]).html, "new".repeat(4000));

  // And a straggler is dropped rather than resetting the assembly *underneath
  // a message already arriving* — which is the case that matters, because the
  // message being assembled would then never complete and would be lost with
  // nothing reporting it. Interleaved deliberately: a late part of the
  // abandoned first message lands in the middle of a third one.
  const third = JSON.stringify({ type: "content", html: "third".repeat(4000) });
  const thirdFrames = [...chunkControl(third, 3, 1024)];
  reassemble(thirdFrames[0]);
  for (const f of firstFrames.slice(2)) reassemble(f);
  for (const f of thirdFrames.slice(1)) reassemble(f);
  assertEquals(got.length, 2);
  assertEquals(JSON.parse(got[1]).html, "third".repeat(4000));
});

Deno.test("a whole message arriving between parts is still delivered", () => {
  // Settings and scroll roles keep flowing while the script is going out.
  const got: string[] = [];
  const reassemble = makeControlReassembler((m) => got.push(m));
  const big = JSON.stringify({ type: "content", html: "x".repeat(8000) });
  const frames = [...chunkControl(big, 1, 1024)];
  const settings = JSON.stringify({ type: "settings", textScale: 3 });

  reassemble(frames[0]);
  reassemble(settings);
  assertEquals(got, [settings]);
  for (const f of frames.slice(1)) reassemble(f);
  assertEquals(got, [settings, big]);
});

Deno.test("junk on the channel is dropped rather than thrown", () => {
  const got: string[] = [];
  const reassemble = makeControlReassembler((m) => got.push(m));
  reassemble("not json at all");
  reassemble("");
  assertEquals(got, []);
  // And the channel still works afterwards.
  const msg = JSON.stringify({ type: "pdf-clear" });
  reassemble(msg);
  assertEquals(got, [msg]);
});

Deno.test("isPart accepts a part and refuses a control message", () => {
  assertEquals(isPart({ k: "part", id: 1, i: 0, n: 2, s: "x" }), true);
  // The key is `k`, never `type`, so no ControlMessage can be read as a part.
  assertEquals(isPart({ type: "content", html: "x" }), false);
  assertEquals(isPart({ k: "part", id: 1, i: 0, n: 2 }), false);
  assertEquals(isPart(null), false);
  assertEquals(isPart("part"), false);
});
