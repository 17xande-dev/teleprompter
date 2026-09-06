import { Teleprompter } from "./teleprompter.ts";
import { Viewer } from "./viewer.ts";

// These are same-window debugging conveniences only (app.ts/pop.ts assign
// their own instance to their own globalThis). Sync between the control
// page and a viewer no longer reaches across windows at all — it goes over
// WebRTC/postMessage — so there is deliberately no `Window.teleprompter`/
// `Window.viewer` cross-window typing here anymore.
declare global {
  var teleprompter: Teleprompter;
  var viewer: Viewer;
}

export {};
