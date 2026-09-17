// The message shapes exchanged between the control page and a viewer
// (a popped-out window, a remote device, or the control page's own local
// preview iframe).
// The same shapes are used regardless of transport: a real viewer gets them
// over the WebRTC "control" data channel, the local preview iframe gets them
// via postMessage. Keeping one protocol for both means the sync logic in
// viewer.ts doesn't need to know which transport it's running over.

/**
 * The BroadcastChannel a display uses to ask "is the control page here?".
 *
 * Not part of the WebRTC protocol and deliberately outside it: a
 * BroadcastChannel reaches only other pages of this origin in this browser
 * profile, and that reach *is* the signal — an answer means the control page
 * is running on the same machine. A display sends `{type: "who"}`, the
 * control page replies `{type: "here"}`, and the display then reports itself
 * as local in its `dims`. Lives here because both pages have to agree on the
 * name.
 */
export const LOCAL_CHANNEL = "teleprompter.local";

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
/**
 * The pixel box every display lays its script out in.
 *
 * Displays are kept in step by making them *match* rather than by making the
 * sync maths cleverer. The scroll position everyone shares is a fraction of the
 * scrollable range, which `setRatio` maps to `r * (scrollHeight -
 * clientHeight)` — so the same fraction lands on a different line on a display
 * of a different height. Measured on a 30,295px script: a 1080-tall and a
 * 768-tall display sit 297px apart, about six lines, at ratio 0.95.
 *
 * So one display is the reference — the one the preview is attached to — and
 * every other lays out at *its* dimensions and scales the whole result to fit
 * its own screen, letterboxing if the shapes differ. Then one ratio is exact by
 * construction and the sync path needs to know nothing about any of this.
 *
 * These are the reference display's dimensions, not the receiver's. A display
 * that has not been told any yet uses its own, which is why a lone screen
 * behaves exactly as it did before this existed.
 *
 * See docs/roadmap.md for the general fix this defers: a content fraction that
 * would let every display use its whole screen.
 */
export type StageMessage = { type: "stage"; width: number; height: number };

export type PdfMessage = { type: "pdf"; name: string; data: ArrayBuffer };

// Leave PDF mode and go back to following the editor's content stream.
export type PdfClearMessage = { type: "pdf-clear" };

// The countdown's whole state, rather than a command to act on it.
//
// It used to be `start`/`stop`/`reset(time)`, which meant the running state
// existed nowhere but the live setInterval in each receiver: there was nothing
// for the controller to replay, so a display that joined or reloaded
// mid-service came back frozen at its markup's 00:00:00 while the operator's
// countdown ran on. One state, sent on every change and in the catch-up
// snapshot, is the fix — and every copy rendering the same two numbers is
// what stops them drifting.
//
// `remainingMs` and not an absolute deadline, deliberately: an epoch stamped
// by the control page is read against the *receiver's* clock, so a display
// whose clock is off — a phone, a Pi that has not reached NTP — would show
// nonsense. The receiver anchors the duration to its own clock on arrival and
// transit is milliseconds.
export type ClockMessage = {
  type: "clock";
  running: boolean;
  /** Milliseconds left. Negative once the countdown is past zero. */
  remainingMs: number;
};

// Sent by the controller to grant/revoke a viewer's ability to drive the
// shared scroll position for everyone else. Viewers always report their own
// scroll ratio; the controller decides whether to act on it.
export type SetDriverMessage = { type: "set-driver"; canDrive: boolean };

// A viewer reporting its own size, and whether it is a screen on the
// operator's own machine.
//
// `local` rides along here rather than in a message of its own because this is
// already sent on connect and on every resize, so a reconnect re-establishes
// it for free — the same reason the controller learns dimensions this way.
// What "local" means is decided at the viewer (see #detectLocal in viewer.ts):
// same browser profile as the control page. A remote display cannot claim it
// by accident, and nothing in the app grants a local viewer anything, so
// there is nothing here worth forging.
export type DimsMessage = {
  type: "dims";
  width: number;
  height: number;
  local: boolean;
};

// A viewer asking for a new text size, the second message that travels from a
// display back to the controller.
//
// Only the *driving* display may originate one — the same rule that governs
// hand-scrolling, and for the same reason: two displays resizing at once would
// fight with nothing to settle it. Both ends enforce it, the viewer by not
// listening for the gesture unless it holds drive and the controller by
// ignoring a scale from anyone but the driver, because a check at one end only
// is a check that vanishes the moment the other end is rewritten.
//
// The scale is a rem number, the unit SettingsMessage.textScale already uses,
// and the controller clamps it before it reaches anything: it ends up in a
// font-size on every display in the room, and textscale.ts records what a
// non-finite one does there — the script vanishes with nothing in any console.
//
// Nothing structurally stops the controller sending this back to a viewer; it
// simply never does, which is the same shape DimsMessage has. The reply is a
// SettingsMessage, so every display including the sender learns the new size
// the same way.
export type TextScaleMessage = { type: "text-scale"; scale: number };

// Scroll position, sent as a 0..1 ratio (not raw pixels) so it lands in the
// same place regardless of the receiving window's size — a popped-out window,
// a remote phone, and the control page's differently-sized preview iframe show
// the same content at different dimensions. Over WebRTC this travels on its
// own unreliable data channel as a bare `{r, s}` (see webrtc.ts); postMessage
// has no separate channels, so the local preview iframe gets it wrapped in
// this discriminated variant instead.
export type ScrollControlMessage = { type: "scroll"; r: number; s: number };

/**
 * Move the preview's viewport by a number of its own document pixels.
 *
 * Only ever posted to the preview iframe, and the one message that asks a
 * viewer to *move* rather than telling it where to be. The operator's wheel
 * and drag land on the control page — the iframe is transparent to pointer
 * events and stays that way, because making it clickable would focus it and
 * every keyboard shortcut is bound to the parent window (see paletteControls)
 * — so the control page forwards the gesture here, and the preview's own
 * ScrollSync samples the result and reports the ratio back.
 *
 * Pixels rather than a ratio because a gesture is a distance, not a
 * destination: converting to a ratio here would need the document height the
 * iframe has and the parent does not.
 */
export type ScrollByMessage = { type: "scroll-by"; px: number };

/**
 * The preview telling the control page where the operator just put it.
 *
 * The sole message that travels *up* from a viewer document to the control
 * page — `ControlMessage` is otherwise controller→viewer throughout, which is
 * why this is its own type and not a member of that union. (The untyped
 * `pop-hello` a popped-out screen sends its opener is the precedent.)
 *
 * The control page accepts it only while it is expecting one, i.e. while the
 * operator's own gesture is in progress. That gate is not politeness: a
 * `scroll` event also fires when a layout change clamps `scrollTop`, and the
 * preview relayouts on every keystroke with live editing on, on a PDF load
 * and on every re-fit — so a ratio volunteered outside a gesture is noise
 * that would otherwise be broadcast to every display.
 */
export type PreviewScrollMessage = { type: "preview-scroll"; r: number };

/**
 * Whether something that arrived on a `message` event is one of these.
 *
 * A guard rather than a cast, because this is the one direction where the data
 * is genuinely untrusted at the type level: `postMessage` carries `unknown`,
 * and an assertion would let a malformed payload through to `sendScroll` as a
 * `number` that isn't one. Narrowing here is also what ties the receiver to
 * the same declaration the sender is annotated with — the type was declared
 * for documentation and referenced by neither end, which is exactly how a
 * renamed field becomes a scrub that silently stops working.
 */
export function isPreviewScroll(data: unknown): data is PreviewScrollMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as Partial<PreviewScrollMessage>;
  return msg.type === "preview-scroll" && typeof msg.r === "number" &&
    Number.isFinite(msg.r);
}

/**
 * Whether a control-channel message is a viewer's request for a text size.
 *
 * The controller decodes the channel to a `ControlMessage`, so the discriminant
 * alone would satisfy the type system — but this arrives over WebRTC from
 * another machine, and the number goes on to become a font size. Finiteness is
 * checked here rather than trusted from the sender for the same reason
 * `isPreviewScroll` exists: a `null` or a string `"2"` narrows to the variant
 * on `type` alone and only stops looking like a number later, in CSS, where
 * being wrong costs the whole script rather than an error.
 */
export function isTextScale(data: unknown): data is TextScaleMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as Partial<TextScaleMessage>;
  return msg.type === "text-scale" && typeof msg.scale === "number" &&
    Number.isFinite(msg.scale);
}

export type ControlMessage =
  | ContentMessage
  | StageMessage
  | PdfMessage
  | PdfClearMessage
  | SettingsMessage
  | ThemeMessage
  | ClockMessage
  | ScrollByMessage
  | SetDriverMessage
  | DimsMessage
  | TextScaleMessage
  | ScrollControlMessage;

/**
 * What a display has to be told to agree with the ones already running.
 *
 * Built here, DOM-free and away from the control page, for two reasons. It has
 * two callers — a viewer joining over WebRTC, and the preview iframe's `load`
 * — and a message that reaches only one of them is a bug by construction: that
 * pair has drifted three times, first on the theme, then on the text scale,
 * then on the message and the scroll position, and every time the symptom was
 * a preview quietly showing something no display was showing. And keeping it
 * out of teleprompter.ts is what makes it testable at all; anything in there
 * imports Web Awesome and Wordgard, which `deno test` cannot resolve.
 *
 * Order is deliberate. The three that change the document's *height* — the
 * stage box, the theme and the text scale — go first, so `setContent`'s own
 * re-anchor lands against the final height rather than against an inherited
 * 16px. The trailing scroll
 * position re-anchors regardless, which makes the ordering a belt rather than
 * the only thing holding it up.
 *
 * A PDF is not in here: it travels as a file over its own channel, so each
 * caller substitutes it for the `content` message in the way its transport
 * allows.
 */
export function catchUpMessages(show: {
  stage: Omit<StageMessage, "type">;
  theme: ThemeMessage;
  /** Wire speed, forward positive — i.e. already negated from the slider. */
  speed: number;
  textScale: number;
  message: string;
  html: string;
  clock: Omit<ClockMessage, "type">;
  ratio: number;
}): ControlMessage[] {
  return [
    // First of all, because it is the box everything else is measured in: a
    // theme's container units and the content's own wrapping both resolve
    // against it, so arriving after them would relayout the lot.
    { type: "stage", ...show.stage },
    show.theme,
    {
      type: "settings",
      speed: show.speed,
      textScale: show.textScale,
      message: show.message,
    },
    { type: "content", html: show.html },
    { type: "clock", ...show.clock },
    { type: "scroll", r: show.ratio, s: 0 },
  ];
}
