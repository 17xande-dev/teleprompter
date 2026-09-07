// The message shapes exchanged between the control page and a viewer
// (a popped-out window, a remote device, or the control page's own local
// preview iframe).
// The same shapes are used regardless of transport: a real viewer gets them
// over the WebRTC "control" data channel, the local preview iframe gets them
// via postMessage. Keeping one protocol for both means the sync logic in
// viewer.ts doesn't need to know which transport it's running over.

export type ContentMessage = { type: "content"; html: string };

export type SettingsMessage = {
  type: "settings";
  speed?: number;
  // Pause/resume the auto-scroll loop without changing the configured
  // speed (the space-bar behavior) — independent of `speed` itself.
  autoScroll?: boolean;
  textScale?: number;
  message?: string;
};

// Which viewer layout to wear, and — for a user-authored one — its stylesheet.
// A custom theme's CSS lives only in the operator's browser (localStorage), so
// a viewer in a different browser has no way to fetch it; the controller ships
// the text alongside the class name. `css: null` means a built-in layout:
// discard any installed theme and fall back to the bundled stylesheet.
//
// The class name travels *with* the CSS rather than staying in `settings` for
// two reasons. Ordering: a `settings{layout}` landing before its stylesheet
// would flash an unstyled screen, and a single message cannot arrive out of
// order with itself. And `settings` is coalesced to one message per animation
// frame to keep the reliable channel clear for scroll samples (see
// #pushSettings) — a multi-KB blob has no business in that path.
export type ThemeMessage = {
  type: "theme";
  layout: string;
  css: string | null;
};

// A PDF to render in place of the `content` HTML. Both transports deliver the
// same shape but arrive at it differently: the preview iframe is handed the
// bytes verbatim (postMessage structured-clones an ArrayBuffer), while a real
// viewer receives them chunked over the "file" data channel and webrtc.ts
// rebuilds this message on the far side. viewer.ts sees one case either way.
export type PdfMessage = { type: "pdf"; name: string; data: ArrayBuffer };

// Leave PDF mode and go back to following the editor's content stream.
export type PdfClearMessage = { type: "pdf-clear" };

export type ClockMessage =
  | { type: "clock"; action: "start" | "stop" }
  | { type: "clock"; action: "reset"; time: string };

// Sent by the controller to grant/revoke a viewer's ability to drive the
// shared scroll position for everyone else. Viewers always report their own
// scroll ratio; the controller decides whether to act on it.
export type SetDriverMessage = { type: "set-driver"; canDrive: boolean };

export type DimsMessage = { type: "dims"; width: number; height: number };

// Scroll position, sent as a 0..1 ratio (not raw pixels) so it lands in the
// same place regardless of the receiving window's size — a popped-out window,
// a remote phone, and the control page's differently-sized preview iframe show
// the same content at different dimensions. Over WebRTC this travels on its
// own unreliable data channel as a bare `{r, s}` (see webrtc.ts); postMessage
// has no separate channels, so the local preview iframe gets it wrapped in
// this discriminated variant instead.
export type ScrollControlMessage = { type: "scroll"; r: number; s: number };

export type ControlMessage =
  | ContentMessage
  | PdfMessage
  | PdfClearMessage
  | SettingsMessage
  | ThemeMessage
  | ClockMessage
  | SetDriverMessage
  | DimsMessage
  | ScrollControlMessage;
