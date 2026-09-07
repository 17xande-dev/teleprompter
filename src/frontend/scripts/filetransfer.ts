// filetransfer.ts — framing for sending a whole file over a data channel.
//
// A data channel carries strings and ArrayBuffers on the same stream, and the
// receiver can tell them apart with `typeof`. That's the whole framing: a JSON
// string header, then the bytes in chunks, then a JSON string trailer. No
// length prefixes, no base64 (which would inflate a PDF by a third for
// nothing), no per-chunk metadata.
//
// This lives apart from webrtc.ts so it can be tested without a DOM or a real
// RTCDataChannel — webrtc.ts is left owning only the channel and its
// backpressure.

// 16 KiB. Larger messages work on modern browsers but rely on SCTP
// fragmentation being negotiated; this size needs no such agreement and still
// moves a multi-megabyte PDF in well under a second on a LAN.
export const CHUNK_SIZE = 16 * 1024;

type Header = { k: "begin"; name: string; bytes: number; chunks: number };
type Trailer = { k: "end" };

export type Frame = string | ArrayBuffer;

/**
 * Frames a file for sending. A generator rather than an array so the caller
 * can stop pumping when the channel's buffer fills up and resume later
 * without holding a second copy of the file in memory.
 */
export function* chunkFile(
  name: string,
  bytes: ArrayBuffer,
  chunkSize: number = CHUNK_SIZE,
): Generator<Frame> {
  const chunks = Math.ceil(bytes.byteLength / chunkSize);
  const header: Header = { k: "begin", name, bytes: bytes.byteLength, chunks };
  yield JSON.stringify(header);
  for (let i = 0; i < chunks; i++) {
    yield bytes.slice(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.byteLength));
  }
  const trailer: Trailer = { k: "end" };
  yield JSON.stringify(trailer);
}

/**
 * Returns a frame sink that calls `onFile` once a complete file has arrived.
 *
 * The channel is ordered and reliable, so frames can't arrive out of order or
 * go missing — but a transfer can be *superseded* (the controller drops a
 * second PDF, or re-sends to a viewer that rejoined). A "begin" therefore
 * always discards whatever was in flight rather than appending to it.
 */
export function makeReassembler(
  onFile: (name: string, data: ArrayBuffer) => void,
): (frame: Frame) => void {
  let name = "";
  let expected = 0;
  let received = 0;
  let buf: Uint8Array | null = null;

  return (frame: Frame) => {
    if (typeof frame === "string") {
      const msg = JSON.parse(frame) as Header | Trailer;
      if (msg.k === "begin") {
        name = msg.name;
        expected = msg.bytes;
        received = 0;
        buf = new Uint8Array(msg.bytes);
        return;
      }
      // "end": only deliver a transfer that actually completed. A truncated
      // one would otherwise surface as a PDF with a tail of zero bytes, which
      // pdf.js reports as a corrupt document rather than a lost transfer.
      if (buf && received === expected) onFile(name, buf.buffer as ArrayBuffer);
      buf = null;
      return;
    }

    if (!buf) return; // bytes with no header — a transfer we already dropped
    const chunk = new Uint8Array(frame);
    // Guard the copy rather than trusting the header: a lying or buggy sender
    // would otherwise throw out of the channel's onmessage handler.
    if (received + chunk.byteLength > expected) {
      buf = null;
      return;
    }
    buf.set(chunk, received);
    received += chunk.byteLength;
  };
}
