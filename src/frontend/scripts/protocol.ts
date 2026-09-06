// The message shapes exchanged between the control page and a viewer
// (popup, remote device, or the control page's own local preview iframe).
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
  layout?: string;
  message?: string;
};

export type ClockMessage =
  | { type: "clock"; action: "start" | "stop" }
  | { type: "clock"; action: "reset"; time: string };

// Sent by the controller to grant/revoke a viewer's ability to drive the
// shared scroll position for everyone else. Viewers always report their own
// scroll ratio; the controller decides whether to act on it.
export type SetDriverMessage = { type: "set-driver"; canDrive: boolean };

export type DimsMessage = { type: "dims"; width: number; height: number };

// Scroll position, sent as a 0..1 ratio (not raw pixels) so it lands in the
// same place regardless of the receiving window's size — a popup, a remote
// phone, and the control page's differently-sized preview iframe all show
// the same content at different dimensions. Over WebRTC this travels on its
// own unreliable data channel as a bare `{r, s}` (see webrtc.ts); postMessage
// has no separate channels, so the local preview iframe gets it wrapped in
// this discriminated variant instead.
export type ScrollControlMessage = { type: "scroll"; r: number; s: number };

export type ControlMessage =
  | ContentMessage
  | SettingsMessage
  | ClockMessage
  | SetDriverMessage
  | DimsMessage
  | ScrollControlMessage;
