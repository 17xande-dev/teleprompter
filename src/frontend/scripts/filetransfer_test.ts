// Round-trips chunkFile through makeReassembler. No DOM and no data channel
// involved — the framing is deliberately separable from the transport so the
// boundary cases can be checked here rather than by dropping ever-odder PDFs
// into a browser.
import { assertEquals } from "jsr:@std/assert";
import { chunkFile, makeReassembler } from "./filetransfer.ts";

const CHUNK = 64;

function pattern(n: number): ArrayBuffer {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
  return b.buffer;
}

interface Received {
  name: string;
  data: Uint8Array;
}

function roundTrip(name: string, bytes: ArrayBuffer): Received[] {
  const got: Received[] = [];
  const sink = makeReassembler((n, d) =>
    got.push({ name: n, data: new Uint8Array(d) })
  );
  for (const frame of chunkFile(name, bytes, CHUNK)) sink(frame);
  return got;
}

Deno.test("round-trips a file whose length is not a chunk multiple", () => {
  const bytes = pattern(CHUNK * 3 + 17);
  const got = roundTrip("script.pdf", bytes);
  assertEquals(got.length, 1);
  assertEquals(got[0].name, "script.pdf");
  assertEquals(got[0].data, new Uint8Array(bytes));
});

Deno.test("round-trips a length that is an exact chunk multiple", () => {
  // The trailing partial chunk is the easy case to get right; a file that ends
  // exactly on a boundary is the one that produces an off-by-one extra empty
  // chunk, or none at all.
  const bytes = pattern(CHUNK * 4);
  const got = roundTrip("exact.pdf", bytes);
  assertEquals(got.length, 1);
  assertEquals(got[0].data, new Uint8Array(bytes));
});

Deno.test("round-trips a length one byte over a chunk boundary", () => {
  const bytes = pattern(CHUNK + 1);
  const got = roundTrip("plus-one.pdf", bytes);
  assertEquals(got.length, 1);
  assertEquals(got[0].data, new Uint8Array(bytes));
});

Deno.test("delivers a zero-byte file rather than nothing", () => {
  const got = roundTrip("empty.pdf", new ArrayBuffer(0));
  assertEquals(got.length, 1);
  assertEquals(got[0].data.byteLength, 0);
});

Deno.test("a second transfer starts clean rather than splicing onto the first", () => {
  // The path this guards: a viewer rejoins, the controller re-sends the PDF,
  // and the reassembler is still holding state from the transfer that was cut
  // off. Appending there yields a plausible-looking buffer of the right length
  // full of the wrong bytes.
  const got: Received[] = [];
  const sink = makeReassembler((n, d) =>
    got.push({ name: n, data: new Uint8Array(d) })
  );

  const first = pattern(CHUNK * 3);
  const frames = [...chunkFile("first.pdf", first, CHUNK)];
  // Cut the first transfer off mid-flight: header plus one chunk, no trailer.
  sink(frames[0]);
  sink(frames[1]);

  const second = pattern(CHUNK + 5);
  for (const frame of chunkFile("second.pdf", second, CHUNK)) sink(frame);

  assertEquals(got.length, 1);
  assertEquals(got[0].name, "second.pdf");
  assertEquals(got[0].data, new Uint8Array(second));
});

Deno.test("drops a transfer that ends short of its declared length", () => {
  // Delivering this would hand pdf.js a buffer of the right size with a tail
  // of zero bytes — reported as a corrupt document, which sends you looking at
  // the PDF rather than at the transfer that lost bytes.
  const got: Received[] = [];
  const sink = makeReassembler((n, d) =>
    got.push({ name: n, data: new Uint8Array(d) })
  );

  sink(
    JSON.stringify({ k: "begin", name: "short.pdf", bytes: 128, chunks: 2 }),
  );
  sink(pattern(64));
  sink(JSON.stringify({ k: "end" }));

  assertEquals(got.length, 0);
});

Deno.test("drops a transfer whose bytes overrun its header", () => {
  const got: Received[] = [];
  const sink = makeReassembler((n, d) =>
    got.push({ name: n, data: new Uint8Array(d) })
  );

  sink(JSON.stringify({ k: "begin", name: "liar.pdf", bytes: 4, chunks: 1 }));
  sink(pattern(64));
  sink(JSON.stringify({ k: "end" }));

  assertEquals(got.length, 0);
});
