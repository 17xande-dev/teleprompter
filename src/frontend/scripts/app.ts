import { Teleprompter } from "./teleprompter.ts";
// TODO: this import is not working yet, do more research to figure out svg imports.
import _svgFavicon from "../icons/tv-solid-full.svg";

// Wrapped, because the control page wires itself up in its constructor and a
// throw part-way through leaves a page that looks like it is merely slow: an
// empty editor, no room id, a blank viewer link and a signalling badge stuck
// on "Connecting" for as long as anyone waits. That is what a missing
// `crypto.randomUUID` on an insecure origin used to produce, and the only
// trace was one line in a console nobody had open. A page that cannot come up
// should say so where the operator is looking.
try {
  globalThis.teleprompter = new Teleprompter();
} catch (err) {
  console.error("the control page failed to start", err);
  const bar = document.querySelector("#appBar");
  const note = document.createElement("div");
  note.id = "divStartupError";
  note.textContent = `This page could not start: ${
    err instanceof Error ? err.message : err
  }`;
  bar?.after(note);
  throw err;
}
