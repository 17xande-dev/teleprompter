# CLAUDE.md

Guidance for Claude Code working in this repository.

## Commands

```sh
deno task build      # clean + bundle frontend -> src/backend/dist (before `go build`)
                     # = clean + bundle-app + bundle-pdfjs + bundle-pdfworker
                     #   + copy-pdfjs-assets + copy-icons
deno task dev        # watch-bundle the frontend AND run the Go server under air
deno task check      # type-check the frontend
deno task test       # frontend unit tests
deno lint src/frontend/scripts
cd src/backend && air              # server, rebuilt and restarted on .go changes
cd src/backend && go run . -dev    # or by hand, reading dist/ from disk
cd src/backend && go test -race ./...
cd src/backend && go vet ./... && gofmt -l .
```

**All three gates are clean — check, lint and test.** They were not for a long
time (one `setInterval`-returns-`Timeout` error in `clock.ts`, and 16
`no-import-prefix`/`no-unversioned-import` problems from `jsr:@std/assert` in
the test files), and this file used to tell you which failures to ignore. That
is worth not going back to: a gate with expected failures in it can't be read at
a glance, and a real failure hides among them. So **any** output from those
three is yours.

- `@std/assert` is declared in `deno.jsonc`'s `imports`; test files import it by
  bare specifier. A `jsr:`-prefixed import in a new test file puts two lint
  problems back.
- `clock.ts`'s `interval` is `ReturnType<typeof setInterval> | undefined`, the
  same shape `themeControls.ts` uses. `undefined` is the "not running" sentinel
  and it is load-bearing, not cosmetic: `start()` returns early on it, and with
  it defeated a second Start stacks a second interval and the countdown runs
  down two seconds per second.

`deno test` is run with `--no-check`: with the repo config, its type-check pass
pulls in the whole project graph including `teleprompter.ts`'s raw CSS imports,
which only the bundler knows how to resolve. Types are covered by
`deno task check` instead.

**Frontend source is `src/frontend/`. `src/backend/dist/` is generated** — never
edit it. `go:embed` bakes it into the binary at _compile_ time, which is why the
server takes `-dev` to read it from disk instead; without that, a rebundle is
invisible until the Go process restarts. This has cost real debugging time — if
a change isn't showing up in the browser, check whether the server is embedding
a stale copy.

**`deno task build` cleans `dist/` first, and has to.** `deno bundle`
content-hashes its output names, so every rebuild writes a new `index-<hash>.js`
plus its sourcemap (~3.6MB — it inlines the whole dependency graph) and leaves
every earlier one behind. Nothing serves them: `index.html` names exactly one.
But `go:embed` takes the whole directory, so they all land in the binary —
unchecked, this had grown `dist/` to 232MB and the binary to 227MB, of which
223MB was stale output. Cleaning first is why both are now 12MB and 22MB.
`clean` uses a glob, which skips dotfiles, so `dist/.gitkeep` (tracked so a
fresh checkout has something for `go:embed` to find) survives.

**The bundler emits JS and CSS and nothing else**, so static assets need
copying: `tools/copy-pdfjs-assets.ts` for pdf.js's font/wasm side-files and
`tools/copy-icons.ts` for `src/frontend/icons/`. The favicon 404'd on every page
load until the latter existed.

**`deno task dev` runs the Go server under air** (`src/backend/.air.toml`), so a
`.go` change rebuilds and restarts on its own — a rebuild is ~450ms. Two config
details are wrong in the obvious spelling: `-dev` goes in `args_bin`, because
air treats `entrypoint` as a single path and will look for a file named
`server -dev`; and `dist/` is excluded, or the bundler's writes restart the
server on every keystroke and drop every signaling socket. air is pinned in
`mise.toml`. Frontend changes need no Go rebuild at all — `-dev` reads `dist/`
off disk, so a browser refresh is the whole loop and connected viewers survive.

## Architecture

A control page drives N viewers over WebRTC. The Go server does signaling only.
Modelled on `~/dev/webrtc-go`, which is worth reading before changing the sync
path — it is the reference for why this feels smooth.

### Server (`src/backend/`)

`main.go` wiring + CSP + embed, `hub.go` rooms and peers, `signal.go` the
WebSocket relay, `ice.go` STUN/TURN config.

- `hub` owns `room`s; a room has at most one `controller` and any number of
  `viewers`, keyed by a server-assigned peer id.
- **Signaling is targeted, not broadcast.** A client sends
  `{to: "<peer id>", description|candidate}`; the server stamps `from` and
  relays to that one peer. It decodes the envelope as
  `map[string]json.RawMessage` so it can add `from` without ever parsing the
  SDP/ICE payload. _Forgetting the `from` stamp silently breaks everything_: the
  client can't route the message to the right per-peer connection, so
  negotiation never completes and the connection sits in "connecting" forever
  with no error anywhere.
- Server→client kinds: `welcome` (your id), `viewer-list`, `peer-joined`,
  `peer-left`, `waiting`, `denied`.
- **A new controller evicts the sitting one** so an operator's refresh
  reconnects instead of orphaning viewers. Two consequences that are easy to get
  wrong, both now covered by tests:
  - `leave()` must _not_ announce a controller that has already been replaced —
    the evicted socket's read loop notices late, and viewers would tear down the
    link they just built to the new controller.
  - Clients must ignore a `peer-left` whose `from` isn't the peer they're
    connected to, for the same reason from the other side.
- **`peer.send` is never closed.** Senders resolve a peer under the room lock
  and then write without it, so closing on departure races that write and panics
  the process. Departure closes `peer.done`, which `sendTo` and `writePump`
  select on.
- `leave()` holds `h.mu` then `r.mu` across both the empty check and the room
  delete. Taking them separately lets a peer join a room that's being discarded
  and vanish from the hub.
- **Control key**: the first controller claims a room with a key; later ones
  must match it (constant-time). Viewers need no key. Without this the room id
  alone would grant control, and eviction would make takeover free.

### Frontend (`src/frontend/scripts/`)

- `webrtc.ts` — `connectController(room, key, cb)` keeps a
  `Map<peerId,
  Link>`, one `RTCPeerConnection` per viewer, always impolite.
  `connectViewer(room, cb)` keeps one link to the controller, always polite.
  Both reconnect their signaling socket on drop. Three _negotiated_ channels
  with fixed ids: `scroll` (id 0, unordered + unreliable, latest-wins by seq),
  `control` (id 1, ordered + reliable) and `file` (id 2, ordered + reliable,
  `binaryType = "arraybuffer"`) for PDF transfer.
- `filetransfer.ts` — the framing for `file`: a JSON string header, raw
  ArrayBuffer chunks, a JSON string trailer, told apart by `typeof`. Kept
  separate from `webrtc.ts` so the boundary cases are unit-testable.
- `pdfview.ts` — renders a PDF as a plain column of page divs, which is all the
  sync layer needs; `pdfjs.ts` / `pdfworker.ts` are bundle entries, not modules
  anyone imports directly.
- `scrollsync.ts` — ratio conversion, one send per animation frame, and the
  `applyingRemote` echo guard. Ported nearly verbatim from webrtc-go. Also
  exports `ratioOf`/`setRatio` for callers that want the ratio maths without a
  running sync — `pdfview.ts` keeping its own copy is what prompted sharing
  them. `carryRemainder`/`scrollQuantum` live here for the same reason: both
  pages already import this module, and `viewer.ts`'s auto-scroll accumulator
  and `gamepadControls.ts`'s stick both need the same sub-pixel carry.
  **`carryRemainder` distinguishes the two reasons a viewport moves less than it
  was asked to**, and they need opposite treatment: pixel-grid quantising is
  carried (a slow speed's half-pixel would otherwise be rounded away every frame
  and never move at all), while running out of document is dropped. The old code
  banked both, bounded only by a screen height — and since a blocked frame
  consumes none of the debt, a viewer held against either end went on asking to
  scroll by it every frame _after the speed was back at zero_, undoing any
  position sent to it on the next frame. "Send my position" silently did nothing
  and the viewer sat pinned to one end.
- `textscale.ts` — the arithmetic behind matching the editor's font size to a
  viewer's, kept DOM-free and tested; `teleprompter.ts` does the measuring. What
  is matched is font size over content width, i.e. characters per line, because
  the panes are different widths and equal pixels would wrap differently.
- `protocol.ts` — the control-channel message union, shared by both transports.
- `settings.ts` / `settingsControls.ts` — the operator's own preferences for
  this browser (currently just the wheel direction), split DOM-free half from
  dialog half like the two below. Nothing in here is on the wire, and nothing in
  it belongs to a document or a room.
- `doc.ts` / `themes.ts` — the two localStorage-backed collections (script
  documents; user viewer layouts), both deliberately **DOM-free** so they can be
  unit-tested, both taking their `Storage` as a constructor argument.
  `docControls.ts` / `themeControls.ts` are the matching DOM halves (dropdown,
  dialogs, editor). `dom.ts` holds what the two DOM halves share. `cssEditor.ts`
  wraps CodeMirror, shaped like `editor.ts` wraps Wordgard. The shared shape of
  the two storage classes is worth keeping: a tolerant exported parser that
  drops one bad entry rather than the whole collection, `try/catch` on every
  read _and_ write, an id that is minted once and never changes so renaming
  can't invalidate a held reference, the active-item pointer stored as that id
  and validated on load, saving inside every mutator, and one idempotent
  `#renderItems()` rebuilt from storage after every mutation. `doc.ts` used to
  do the opposite of all six and had a silent delete no-op, a rename that
  overwrote an unrelated document, and four ways to throw out of page load.
- **`DocStorage.setContent` is throttled, and that makes `flush()`
  load-bearing.** It is called on every editor update, and each write serialises
  the whole collection, so it coalesces to one write per 500ms. Deliberately a
  throttle, not a debounce: a debounce restarts its window on each keystroke, so
  someone typing continuously would have minutes of work held only in memory.
  In-memory state still updates synchronously — every read goes through it.
  Anything that ends the page's life has to call `flush()` or the last
  half-second of typing is lost; `docControls.ts` wires `pagehide` and
  `visibilitychange`→hidden for that (not `beforeunload`/`unload`, which fire
  unreliably and disqualify the page from the back-forward cache). `#save()`
  cancels a pending throttle, since it has just persisted everything anyway. The
  window is injectable as the second constructor argument so tests don't sleep.
- `commands.ts` — the command mechanism: shortcut parsing, tinykeys translation,
  display formatting and the palette's search. DOM-free and so unit-tested;
  `paletteControls.ts` is the DOM half (the `#dlgPalette` dialog, the list,
  arrow-key nav) and also installs the tinykeys bindings. `controlCommands.ts`
  holds the table itself and binds it to the page. **One list feeds both the
  palette and the keyboard**, which is what keeps the shortcut shown next to a
  command identical to the one that fires — `validateCommands`, run over the
  real table by `commands_test.ts`, is what makes that checkable rather than
  merely intended.
- `gamepad.ts` / `gamepadControls.ts` — game-controller support, split the same
  way: the deadzones, the throttle→slider arithmetic, the button edge detection
  and `PAD_BINDINGS` are DOM-free, and the DOM half polls
  `navigator.getGamepads()` on a frame loop. **The one-shot buttons are bound as
  command _ids_**, resolved out of the same `Command[]` the palette gets, so the
  third input device joins the same "one list feeds both" rule — and
  `applyPadBindings` stamps the `pad` label onto the specs from that same map,
  so the palette can't advertise a button that isn't wired.
- `teleprompter.ts` — the control page. `viewer.ts` — the display, running
  either standalone (own WebRTC link) or embedded in the control page's preview
  iframe (postMessage), detected via `window.parent !== window`.
- The viewer document is `html/viewer.html` + `viewerApp.ts`, styled by
  `viewerBase.css` (unscoped, always applies) and `viewerThemes.css` (the
  built-in layouts). These were `pop*` and `.pop-clocks` until themes landed —
  the viewer is not always a popped-out window, and a class every theme is
  written against is not one to rename later. `#btnPop`/`listenPop` keep the
  name because they really are the `window.open` action.
- The control page's chrome is an **app bar** (`#appBar`) above the split panel,
  holding what is true of the session rather than of a pane: the document
  actions, the room id, a signaling badge, the viewer count, the gamepad
  indicator and the palette/popup buttons. The badge is the only consumer of the
  `data-signaling` attribute `onSignalingStatus` sets on `<html>`. Sidebar
  sections are `wa-card`s; paired buttons are `wa-button-group`s.

### Things that will bite

- **`wa-qr-code` paints its modules in the host's `color`** — its own `fill`
  attribute is deprecated in favour of that property — so on this page it
  inherited the dark theme's near-white text and drew near-white modules on the
  white quiet zone underneath. Measured at luminance 0.949 against 1.0: a
  contrast ratio of about 1.05:1, which no scanner can read, and it looks merely
  "faint" rather than broken. `#qrViewerLink` pins ink _and_ paper, and is the
  one place in the app deliberately light-on-dark's opposite — inverting a QR
  code stops some phones recognising it at all. The padding is the code's quiet
  zone and must clear four modules: the component draws the symbol edge to edge
  of its canvas, a viewer URL encodes to 44 modules (local and deployed alike),
  and at `size="200"` that is 4.55px a module — so 1rem would be 3.5 modules and
  fail where 1.5rem is 5.3. Check it by sampling the canvas, not by eye.
- **A `wa-button-group`'s slot is `flex-wrap: wrap`**, so a group short of width
  breaks its _own_ buttons onto a second row — which is what made the app bar
  spill out of a fixed height on a phone, its contents measuring `y: -14` inside
  a 48px bar. A group is a row by definition (its first/last-child rules round
  the ends of one), so the bar sets `::part(base) { flex-wrap: nowrap }` and
  wraps _between_ groups instead. `::part` is the only hook: the wrap is on the
  slot inside the shadow root and the host's own `flex-wrap` can't reach it.
- **`--app-bar-height` is measured from the bar, not assumed** —
  `#trackAppBarHeight` publishes its real height and `--pane-height` is the
  viewport minus that. The bar is allowed to wrap, so it can be taller than the
  3rem it is designed to be; a viewer's larger default font or browser zoom does
  the same thing (at a 26px root it becomes 151px). Either way the panes have to
  give up the space, or they hang off the bottom of the viewport. No loop is
  possible: the bar's height comes from its content and a **constant** floor in
  CSS, never from the property written back — the same discipline
  `#applyPreviewScale` follows.
- **The status badge means "a display is showing this", not "the socket is
  up".** It reports `connected` _and_ `viewers.size`, which is why
  `#renderStatus` is called from both the signaling callback and
  `#renderViewers`. It said "Live" on a bare signaling connection at first, and
  that reads as on-air with nothing plugged in — the operator's question is
  whether anything is showing their script, so with none it says "No viewers".
- **Both panes take their height from `--pane-height`**, one token in
  `style.css` (`100dvh` minus the app bar). `#pdfPane` reads it in CSS and the
  editor gets it through `Wordgard.scrolling()` in `editor.ts`, which drops the
  string straight into a `height:` declaration — so a `var()` works there, and
  the two modes cannot drift apart the way two separate `92vh`s could. `body` is
  `overflow: hidden` and each pane scrolls inside itself; when the _document_
  was the scroller, reaching the bottom of the sidebar dragged the script pane
  off screen mid-service.
- **A vertical `wa-slider`'s track is a fixed 200px** whatever you size the host
  to — measured at 176px, 300px and 360px, all with a 200px track. So a height
  on the host only adds empty space, and a height _under_ its natural size
  pushes the component's own label out through the bottom of whatever contains
  it. Let it size itself.
- **`wa-split-panel` writes `grid-template-columns` as an _inline_ style on the
  host**, computed from `position`. A stylesheet cannot beat that without
  `!important`, so don't try: set `position` instead. That is how the mobile
  layout gives one pane everything (0 or 100 — see `#wirePaneToggle`), and the
  desktop position is saved on the way into mobile and restored on the way out,
  or coming back leaves the script pane at zero width with no divider on screen
  to drag back.
- **`--max` caps the _primary_ (start) panel**, which is how you say "the
  sidebar never gets thinner than this". It clamps on window resize as well as
  on drag. Needed because the divider's position is a percentage: on a 900px
  window the sidebar's 25% share came out at 223px, narrower than its own cards,
  which then overflowed. There is deliberately no `--min` — the script pane
  reflows and a PDF just zooms out, so an operator may drag it to nothing.
- **Wordgard's colour scheme is `auto`, i.e. `prefers-color-scheme`** — so on a
  machine set to light it drew its light variant onto a page that is dark
  unconditionally (`<html class="wa-dark">`), which is what made the toolbar a
  white strip. `editor.ts` pins `Wordgard.colorScheme.of("dark")` and
  `style.css` sets `--wg-panel-color`/`--wg-border-color`/`--wg-highlight-color`
  on the editor element to line that variant up with the Web Awesome surface.
  **Theme it through those variables, not by overriding its rules**: an attempt
  at the latter gave `wg-menu-spacer` a background, and that element is a 7px
  _empty gap_, not a divider — every group separator became a solid block. The
  custom properties go on the editor element itself (`#editor wordgard-editor`),
  not an ancestor: Wordgard sets its own palette on that element via a generated
  class, and a property set on an ancestor loses to one set on the element.
- **The editor's toolbar lives _inside_ the editor element**, so it inherits
  `#editor`'s 2rem prompter font — it rendered at 28.8px, a "Paragraph" dropdown
  taller than the app bar, until `#mainEditor wg-menubar` reset it. The script
  wants that size; the chrome around it does not.
- **The transport readouts hang off `#pushSettings`, not the sliders' `input`
  event.** That is the one funnel every path to a new speed or scale already
  reaches — the `input` listeners (and so the commands and the gamepad, which
  dispatch a synthetic one), both wheel handlers, "match viewers' size" and the
  PDF's fit-to-width. `#renderTransport` reads the sliders, so the numbers
  cannot disagree with the thumbs however the value arrived. It shows the _wire_
  speed (`-rngSpeed.value`, forward positive), not the slider's own value — see
  the inversion below, which would otherwise put a minus sign in front of
  forward.
- **Wire speed is `-rngSpeed.value`, so forward is a _negative_ slider value.**
  That inversion is deliberate and load-bearing: Web Awesome's vertical slider
  is hardcoded max-at-top with no `invert`, and the negation is what puts
  `Forward` at the _bottom_ so the thumb travels the way the text does —
  `listenSpeedWheel`'s `value += -e.deltaY` is the same metaphor. (The old
  reason to believe otherwise, "wa-slider can't do negatives", no longer holds:
  as of 3.12 `min="-500"` is handled correctly.) Anything that means "faster"
  therefore steps _down_: the speed commands carry the sign, and they used not
  to, so "Scroll faster" ran the show backwards. `commands_test.ts` and
  `gamepad_test.ts` both guard the direction, because nothing about getting it
  wrong looks wrong until a service. **The keyboard's arrows are a separate
  question from the slider's geometry**, and they agree only by coincidence of
  metaphor: faster is `Mod+ArrowDown` because scrolling forward is scrolling
  _down_ the script. Two independent things to get backwards, so both are
  asserted.
- **Which way a wheel moves a slider is not knowable from the page**, so it is a
  setting rather than a constant someone has to be right about: whether a scroll
  away from the operator arrives as a positive or a negative `deltaY` is decided
  by the pointing device and the "natural scrolling" preference above the
  browser. The default has the thumb follow the fingers on a naturally scrolling
  system, and Settings' "Reverse slider scrolling" flips it. All three wheel
  handlers go through `wheelStep`, so the direction is one answer for the whole
  page — and the setting is read per event, never cached, or the switch and the
  sliders disagree until a reload.
- **A connected gamepad must not write the speed slider while untouched.**
  Polling is per-frame, so a pad sitting on the desk would broadcast a speed
  sixty times a second and stamp on the wheel or the arrow keys the moment the
  operator used either. `#applyThrottle` keeps a was-throttling flag rather than
  simply skipping idle frames, because one trailing write is still needed on
  release to put the final zero in. Its `#lastTime` sentinel is `-1`, not 0: a
  rAF timestamp of 0 tested for truthiness meant every later frame integrated no
  time and the stick moved nothing at all.
- **`textScale` is a unitless number on the wire and a `rem` length in CSS.**
  The slider reports tenths, `#pushSettings` sends `value / 10`, and `viewer.ts`
  assigns `--textScale` as `${scale}rem`. Do not register that property with
  `@property syntax: "<number>"` — two such rules used to sit in the
  stylesheets, declaring the literal ident `number`, which never parsed and so
  were ignored; correcting them would have made `setProperty` reject the `rem`
  value and compute `font-size: 0`. `--editor-scale`, the control page's own
  reading size, is the same shape and stays unregistered for the same reason.
- **The Editor Text slider is the one slider that is _not_ on the wire.** It is
  the operator's own reading size, so it goes through `#applyEditorScale`
  (custom property, `localStorage`, readout) and must never reach
  `#pushSettings` — sending it would resize every display because someone leaned
  into their own screen. It is still the single source of truth for how big the
  script is: "Match viewers' text size" drives the _slider_ rather than writing
  a font size onto the element, so the thumb, the readout and the remembered
  size cannot disagree with what is on screen.
- **The sliders' defaults are read out of the markup**, once, in the constructor
  — that is what a right-click (and the palette's "Reset sliders to defaults")
  returns them to. The capture has to happen _before_ `#restoreEditorScale`
  writes the stored editor size, or "reset" would put back whatever the operator
  last dragged to rather than the default. A reset dispatches a synthetic
  `input`, like `controlCommands.ts`'s `nudge`, so it travels the same path a
  drag does and cannot forget to tell the viewers.
- **`keyLabel` needs an entry for every physical key name a shortcut uses.**
  Anything carrying `Alt` is written as a `code` (`BracketRight`), and without a
  `KEY_LABELS` entry the palette advertises the chord as literally
  "Ctrl+Alt+BracketRight". Type-checking cannot see this; the palette can.
- **The preview iframe only knows what it is told on `load`.** It is not a
  WebRTC peer, so it misses `#onViewerJoined`'s catch-up snapshot entirely —
  anything a joining viewer is sent has to be posted to the iframe in that
  handler too, or the preview shows something no viewer is showing. It went a
  while inheriting a 16px script while every real viewer sat at 1.6px.
- **The control page's panes move only by explicit action.** They are not
  scroll-synced on purpose, so `goToViewerPosition`/`sendMyPosition` use the
  exported `ratioOf`/`setRatio` rather than a `ScrollSync` — making one of those
  also starts a per-frame pump and a scroll listener, which is what a
  continuously synced pane wants and these don't.
- **A key handler on `window` sees a retargeted event.** For a keypress inside a
  `wa-input`, `event.target` is the _host_ element, not the `<input>` in its
  shadow root — so `target.closest("input")` finds nothing and a focus guard
  written against `target` reads correctly while letting every shortcut fire as
  the operator types. `paletteControls.ts` uses `event.composedPath()[0]`.
- **Ctrl+0, Ctrl+= and Ctrl+- are browser zoom** and Chrome handles them above
  the page, so `preventDefault` does not stop them. A binding there looks right
  and never fires; the scale and speed-zero commands use `Ctrl+Alt+…` instead.
  `Ctrl+Shift+N/O/R/T/W` are likewise browser-owned.
- Anything in a shortcut carrying `Alt` is written as a _physical_ key (`KeyP`,
  `Digit0`, `Equal`), which tinykeys matches against `event.code`. Spelled as a
  letter it is matched against `event.key`, and on macOS `Option+P` is `π` — the
  binding would silently never match.
- `wa-dialog` reflects its `open` attribute on a microtask, so `wa-dialog[open]`
  is empty in the same task that opened one. The shortcut guard reads the `open`
  _property_ off each dialog rather than resting on another library's render
  timing.

- **An editor mounted inside a Web Awesome slot loses its own stylesheet.**
  CodeMirror and Wordgard (ProseMirror lineage — same author, same code) both
  inject their CSS at runtime via style-mod, and both pick the target with a
  `getRoot()` that walks `node.assignedSlot || node.parentNode`. A mount inside
  `<wa-dialog>` or `<wa-split-panel>` is _slotted_, so that walk climbs into the
  component's **shadow root**, style-mod takes its `adoptedStyleSheets` branch,
  and the whole base theme lands somewhere it can never apply: slotted content
  is styled by the document, not by the shadow tree it is projected into. The
  symptom is an editor with no `white-space`, no flex layout and no gutter — "a
  plain box with numbers in it".
  - CodeMirror accepts `root`, so `cssEditor.ts` passes `root: document`.
  - **Wordgard has no such option** (`this.root = getRoot(this.dom.parentNode)`
    in `setConnected`). The main editor gets away with it only by accident:
    `teleprompter.ts` builds it in its constructor, _before_ `wa-split-panel`
    upgrades and attaches its shadow root, so `assignedSlot` is still null and
    the walk reaches the document. Verified — its rules really are in
    `document.head`. If anything ever defers editor construction, or the mount
    moves, it will break with no error. The fix then is to copy the sheets the
    shadow root adopted onto `document.adoptedStyleSheets`.
  - This is invisible to type-checking _and_ to DOM-structure assertions —
    `.cm-editor`, `.cm-gutters` and 16 `.cm-line`s were all present and correct
    while the thing was completely unstyled. Assert **computed styles**, and
    look at a screenshot.
- **Custom elements here are autonomous (`<tp-clock>`), never customized
  built-ins (`<time is="tp-clock">`)**, because WebKit accepts the definition
  and then ignores it. Measured on iOS 18.7 / Safari 26.6 through the device's
  own inspector: `customElements.define(name, cls, {extends: "time"})` throws
  nothing, `customElements.get(name)` is truthy, and the `<time is=…>` elements
  already in the markup are simply never upgraded — `el instanceof TPClock` is
  false, no `connectedCallback` runs, and the element keeps whatever text the
  HTML gave it. So the wall clock (empty markup) was blank on every iPhone and
  the countdown sat frozen at the `00:00:00` in its own tag, with nothing in any
  console. An autonomous element registered and upgraded on the same device in
  the same test. Type-checking cannot see this and Chrome cannot either.
- **A stopped viewer must ask the viewport for nothing at all.** `scrollBy` on
  WebKit performs a sub-pixel scroll and then reports `scrollY` unchanged, so
  `carryRemainder` — which decides what to bank by comparing what was asked with
  what came back — re-banks the whole remainder every frame. While the speed is
  nonzero that debt churns harmlessly; at speed 0 nothing drains it, and a
  viewer whose speed the operator had just zeroed went on creeping at 0.84px a
  frame, about 50px/s, on iOS. `pendingScroll` is the guard: no speed, no
  request, remainder dropped. Under a pixel of owed movement is nothing to
  defend; a display that ignores "stop" is.
- **Don't throttle or ease the scroll fan-out.** It feels smooth _because_ the
  pacer's ratio goes out on every one of ~60 samples a second and is applied
  instantly at the far end. An earlier attempt here to send 4/sec and
  interpolate between samples was strictly worse. Two viewers measured under the
  current scheme track to within a pixel.
- **The auto-scroll accumulator must not bank movement the viewport refused.**
  It carries a sub-pixel remainder on purpose — at 6px/s a frame asks for a
  tenth of a pixel, which moves nothing and would be rounded away forever — but
  the shortfall at the end of a document is a different thing entirely and has
  to be dropped. See `carryRemainder` above for the failure that taught this.
  Verified in the browser both ways: a sent position now holds, and 6px/s still
  travels at 6px/s.
- **A data channel isn't open when it's created.** Anything sent between
  `createDataChannel` and negotiation completing is dropped unless queued —
  `makeLink` queues control sends, and `connectViewer` queues again for the
  window before a `Link` even exists. The "catch a newcomer up" snapshot hit
  this and silently sent nothing.
- **`Wordgard.create({parent})` appends, it does not replace.** Mount points
  must be cleared or editors stack up invisibly.
- **The preview fits the box CSS gives it, both axes, smaller factor wins.**
  `#divPreviewBox` is the space; `#applyPreviewScale` measures _that_ and never
  the container it writes to, which is what keeps the ResizeObserver from
  looping. A box measuring 0 hasn't been laid out yet and falls back to the old
  fixed maximums. The aspect ratio stays the previewed viewer's, so a portrait
  display letterboxes horizontally rather than being squeezed — the preview
  renders at that viewer's real pixel size and distorting it would defeat the
  point.
- The preview iframe is a _passive mirror_ — no auto-scroll loop of its own, no
  scroll reports. It renders at the previewed viewer's real pixel size and is
  CSS-scaled down; sizing it to the on-screen box reflows the content and stops
  it representing what the viewer shows.
- **Exactly one viewer drives**, and `#driverID()` is the only answer to which:
  the operator's pick if that viewer is still connected, else the first to
  connect. The rest get `autoScroll: false` — two viewers both integrating speed
  drift apart with nothing to correct them — and two viewers scrolled by hand
  would fight. The choice lives in one `#chosenDriverID` rather than a flag per
  viewer, which is what makes "only one" structural; as a checkbox per viewer it
  was possible to tick two and have the second silently ignored.
- **The driver's role goes out from `#applyScrollRoles` in both halves**, the
  `set-driver` grant and `settings{autoScroll}` together, because they are one
  decision. Sending the grant only from `#setDriver` meant the _derived_ driver
  — the first viewer, before the operator picks anyone — was never told it could
  drive, so it couldn't be scrolled by hand.
- **The driver and the previewed viewer are two different choices.**
  `#previewID()` is a separate pick because viewers can have entirely different
  sizes and aspect ratios and the preview renders at one viewer's _real_ pixel
  size. They were one function once, which meant granting drive silently
  reshaped the preview. Scroll is not part of the preview choice — every viewer
  sits at the same ratio, so the driver's position is right to show in a box
  shaped like any of them, and `#lastRatio` doubles as "where the previewed
  viewer is" for the sync buttons.
- **A viewer can only be scrolled by hand while it holds drive.**
  `viewerBase.css` locks the viewport and `viewer.ts` lifts it from the
  `set-driver` message via a class on `<html>`. The lock is `overflow: hidden`
  on `body`, which is subtler than it looks: `html` is `visible`, so the
  viewport takes its used overflow from the body element, and the whole page
  stops responding to wheel and touch. Programmatic movement is unaffected —
  `scrollTo` works fine on an overflow-hidden viewport — which is why nothing in
  the sync path ever noticed that "allow drive" granted nothing.
- The preview iframe is resized whenever that pick changes. Text reflows by
  itself; a PDF is laid out in pixels, so the previewer branch of `Viewer` needs
  its own `resize` listener — but _only_ for the PDF relayout, never
  `#reportDims`, or the preview would appear in the room as a viewer.

### PDF mode

A PDF dropped on the control page replaces the editor for the session (held in
memory only — `DocStorage`'s localStorage would not survive one).

- **A PDF page column must reach its final height before anything paints.**
  `pdfview.ts` fetches every page's viewport first and sizes all the boxes in
  one pass, then rasterizes lazily behind an `IntersectionObserver`. If boxes
  grew as canvases arrived, `scrollHeight` would change under `scrollsync.ts` —
  whose `maxScroll()` is recomputed every sample — and a ratio sent by one
  viewer would mean something else on another mid-load.
- **Page height _and_ the gap below it are set in pixels by JS, never in CSS.**
  A `rem` gap doesn't scale with the column, so viewers of different sizes would
  accumulate a different total height and drift apart by a little more per page.
  Nothing in CSS may affect `.pdf-page` height.
- **`GlobalWorkerOptions.workerSrc` must stay same-origin.** pdf.js falls back
  to a `blob:` wrapper for a cross-origin worker, which `default-src 'self'`
  refuses. That is why `pdfjs.ts`/`pdfworker.ts` get their own standalone
  `deno bundle` runs: the app bundle content-hashes its outputs (and
  `--code-splitting` hashes `.ts` entries too), and these two need URLs that can
  be written down. `script-src` carries `'wasm-unsafe-eval'` for pdf.js's
  decoders.
- `tools/copy-pdfjs-assets.ts` copies `standard_fonts/` and `wasm/` into
  `dist/pdfjs/`, because the bundler emits no static assets (see Commands).
  pdf.js is the case where that matters most: missing, they degrade quietly
  rather than erroring — the failure mode is a document that renders subtly
  wrong.
- A `textScale` arriving while `renderPdf` is still awaiting has no view to
  apply itself to, and the controller sends exactly that when it hands over a
  file (resetting zoom to fit-width). `setPdf` re-applies the width after
  assigning the view.
- The control page's own PDF pane is deliberately _not_ scroll-synced: the
  operator reads ahead or behind without moving the viewers.

### Viewer themes

Operators can author extra viewer layouts as plain CSS. A theme is `{name, css}`
in the _control page's_ localStorage (`teleprompter.themes`, active layout in
`teleprompter.layout`), and it **replaces** the built-in layout layer rather
than adding to it.

- **The CSS travels in its own `ThemeMessage`, not in `settings`.** A custom
  theme's stylesheet exists nowhere but the operator's browser, so viewers have
  to be _sent_ the text. The class name rides in the same message because a
  `layout` that arrived before its CSS would flash an unstyled screen. And
  `#pushSettings` coalesces to one message per animation frame to keep the
  reliable channel clear for scroll samples — a multi-KB stylesheet has no
  business in that path, so `#pushTheme` sends directly.
- **`#onViewerJoined` is the only way a viewer ever learns its theme.** Drop
  that `sendTo` and everything looks fine until a display reloads mid-service
  and comes back unstyled. Same for the preview iframe's `load` handler: it
  starts on the built-in default in its own markup.
- **Applied as an adopted stylesheet**, not an injected `<style>`. Adopted
  sheets cascade _after_ the document's own `<link>`, so a theme rule of equal
  specificity wins — which is what "replace" has to mean. One reused
  `CSSStyleSheet`, so switching themes doesn't pile them up.
- **Nothing needs unloading to make "replace" work.** The built-in layouts are
  `@scope`d to `.theme-default` / `.theme-big-clock`, so a `theme-user-*` body
  class stops them matching on its own. `viewerBase.css` is unscoped and
  survives underneath, which is deliberate: its rules are correctness, not
  looks.
- **`replaceSync` does not throw on bad CSS** (verified in Chrome) — it drops
  what it can't use, and merely warns about `@import`. That is the behaviour we
  want mid-service, so `findThemeCssProblems` warns the _author_ in the dialog
  instead. It flags `@import` and any rule touching `.pdf-page`'s box, the one
  mistake that produces no error at all: it desyncs differently-sized viewers a
  little more with every page.
- A slug is minted once at create and never changes, so renaming a theme can't
  invalidate the class a connected viewer is already wearing.
- The theme being edited is _applied while the dialog is open_ — that is what
  makes the preview a feedback loop — so Cancel has to undo the activation as
  well as the edit, and a brand-new theme is removed outright.
- **CodeMirror is control-page only.** The two HTML entries bundle separately;
  an import from `viewer.ts` would make every display download an editor it
  never opens. The viewer bundle is ~10KB and should stay that way.
- CodeMirror syncs contenteditable edits through a `MutationObserver`, so an
  update can land a microtask after the dialog closed. `#onCssChanged` returns
  early when there is no editing session for exactly that reason.

## Style

Match the surrounding code. Comments explain _why_ — the trade-off, the rejected
alternative, the non-obvious constraint — not what the line does. Tests ship
with the code that adds them, and a guard test is worth nothing until it has
been watched failing with the guard removed.

Verify UI changes in a real browser (Chrome DevTools MCP), not just by
type-checking: a handler test runs no JavaScript and enforces no CSP. Both of
the worst bugs in this codebase's WebRTC rework — the missing `from` stamp and
the dropped pre-open messages — were invisible to every other check and obvious
within a minute in the browser.
