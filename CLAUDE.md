# CLAUDE.md

Guidance for Claude Code working in this repository.

Everything here is about _changing_ the code: the trade-offs, the rejected
alternatives, and the constraints that produce no error when you break them. The
prose documentation lives in [docs/](docs/) and is a different job —
[operating.md](docs/operating.md) for running a service,
[architecture.md](docs/architecture.md) for the structural view,
[development.md](docs/development.md) for the build and the gates,
[deploying.md](docs/deploying.md), [themes.md](docs/themes.md), and
[shortcuts.md](docs/shortcuts.md), which is generated from the command table by
`deno task docs` and guarded by a test.

**Traps stay in this file rather than moving to docs/.** This one is loaded
automatically at the start of a session and those are not, so a constraint moved
out of here is a constraint nobody reads until after they have broken it. Where
the two overlap, docs/ explains the behaviour and this explains why it cannot be
otherwise.

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
- `clock.ts`'s `tickTimer` is `ReturnType<typeof setTimeout> | undefined`, the
  same shape `themeControls.ts` uses. `undefined` is the "not running" sentinel
  and it is load-bearing, not cosmetic: `#run()` returns early on it, and with
  it defeated a second Start stacks a second chain of redraws. (It was
  `interval` and a `setInterval` until the countdown became deadline-based — see
  Clocks below.)

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
- `controlframes.ts` — the framing for an oversized `control` message: JSON
  parts with a `k: "part"` envelope, reassembled in order. Split out of
  `webrtc.ts` for the same reason `filetransfer.ts` is, and see the trap below
  for why it exists at all.
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
- `colours.ts` / `textColour.ts` — the script's colour palette, split the usual
  way: the list, its search words and the ids are DOM-free and tested (including
  against the viewer's background — see the trap below), while the half that
  dispatches a mark imports Wordgard and so can only be checked in a browser.
- `textscale.ts` — the arithmetic behind matching the editor's font size to a
  viewer's, kept DOM-free and tested; `teleprompter.ts` does the measuring. What
  is matched is font size over content width, i.e. characters per line, because
  the panes are different widths and equal pixels would wrap differently.
- `protocol.ts` — the control-channel message union, shared by both transports.
- `settings.ts` / `settingsControls.ts` — the operator's own preferences for
  this browser (the wheel direction, and live editing), split DOM-free half from
  dialog half like the two below. Nothing in it belongs to a document or a room.
  `liveEditing` is the one preference that decides whether something reaches a
  viewer — see the Live editing section — and the one whose switch is not in the
  Settings dialog.
- `timer.ts` / `timer_test.ts` — the countdown's arithmetic and its stored form,
  DOM-free. It has to be: `clock.ts` imports Web Awesome components that
  `deno test` cannot resolve, so anything left in there is untestable by
  construction, which is why `TPClock` had none.
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
- The viewer document is `viewer.html` + `viewerApp.ts`, styled by
  `viewerBase.css` (unscoped, always applies) and `viewerThemes.css` (the
  built-in layouts). These were `pop*` and `.pop-clocks` until themes landed —
  the viewer is not always a popped-out window, and a class every theme is
  written against is not one to rename later. `#btnPop`/`listenPop` keep the
  name because they really are the `window.open` action, even though the button
  now reads "Screen" and toggles.
- **The two pages are served at `/control` and `/viewer`**, and both HTML
  entries are bundled to the **dist root** because of it. `deno bundle` emits
  _relative_ asset references (`./index-<hash>.js`), which resolve against the
  directory of the current URL — so a single-segment path resolves them at the
  root, and the viewer's old home in `dist/html/` would have had `/viewer` look
  for `/viewer-<hash>.js` and 404. A trailing slash breaks it the same way, so
  the routes are exact patterns. `main.go` _serves_ the file at those paths
  rather than redirecting to the bundler's own, so the clean path is the one in
  the address bar; `/` redirects to `/control`, keeping one address rather than
  two that drift. `#ensureRoomID` writes the room with `location.pathname`, so
  it preserves whichever path the page is on.
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
  of its canvas, and at `size="200"` a viewer URL's symbol works out around
  4.5px a module — so 1rem is under four modules and fails where 1.5rem clears
  it. (The count moved when the viewer moved to `/viewer`: a shorter URL is
  fewer, larger modules, so the existing padding clears it by more than it did.)
  Check it by sampling the canvas, not by eye.
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
  the two modes cannot drift apart the way two separate `92vh`s could. Each pane
  scrolls inside itself; when the _document_ was the scroller, reaching the
  bottom of the sidebar dragged the script pane off screen mid-service.
- **"The control page never scrolls" is a pinned height, not an `overflow`, and
  `overflow` alone is a trap that strands the operator.** It was
  `overflow:
  hidden` on `body` alone, which takes the scrollbar and the wheel
  away but leaves a scroll _range_ — and the viewport stays scrollable **by
  script**, which is the same fact the viewer's drive lock relies on, aimed at
  the wrong page. So anything that scrolled the document programmatically put
  the app bar off the top with no way back: nothing to drag, no wheel to answer,
  and both panes' own scrollers already where they were asked to be.
  `scrollIntoView` walks every ancestor up to the viewport, so pasting several
  pages into the editor gets there, and so does the palette's selected-item
  call. Measured all nine combinations of `overflow` on `html` and `body`
  against a forced 400px overflow: **every one** let `scrollTo(0, 99999)` put
  the bar at `top: -400`. What works is removing the range, and it takes both
  halves — `body` pinned to `100dvh` so an overflowing pane is clipped instead
  of growing body's box, and `overflow: clip` on `html` because the scrollable
  overflow region propagates to the viewport even through a clipped body (pinned
  body with `html` left `visible` still measured `scrollHeight` 1287 against
  `clientHeight` 887). With both, the range is 0 and the same forced overflow
  leaves `scrollY` at 0. `clip` over `hidden` on both, or the trap just moves
  down one element; the top layer is not clipped, so dialogs and dropdowns are
  unaffected (verified). **The viewer used to be the deliberate opposite and is
  not any more.** It locked `body` alone, precisely so the _document_ kept
  taking programmatic scrolls — that was how a position off the wire was
  applied. Since displays are matched to a reference by laying out in `#stage`
  (see the stage section), the stage is the scroller and the viewport has no
  business scrolling at all: `viewerBase.css` now clips `html` _and_ `body`, for
  the same reason the control page does and with the added one that a stage's
  layout box is deliberately allowed to exceed the screen. Neither page has a
  viewport scroll range now.
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
- **`--max` caps the _primary_ (start) panel**, which is how `#appSplit` says
  "the sidebar never gets thinner than this". It clamps on window resize as well
  as on drag. Needed because the divider's position is a percentage: on a 900px
  window the sidebar's 25% share came out at 223px, narrower than its own cards,
  which then overflowed. `#appSplit` deliberately has no `--min` — the script
  pane reflows and a PDF just zooms out, so an operator may drag it to nothing.
- **There are two split panels, and the knobs are _inherited_ custom
  properties.** `--min`, `--max` and `--divider-width` are read inside a `var()`
  in the `grid-template-rows`/`columns` the component writes as an inline style,
  so a rule matching `wa-split-panel` reaches the nested `#sidebarSplit` as
  well. Both are therefore addressed by id, and it matters in both directions:
  the desktop `--max` would have capped the preview's _height_ at the sidebar's
  height minus 20rem — computing negative on a shorter sidebar and collapsing
  the preview to nothing — and the mobile block's `--divider-width: 0` would
  have taken the preview's divider away on the one device where the sidebar has
  the whole screen. `#sidebarSplit` _does_ carry a `--min`, unlike the outer
  panel, because the preview's card spends ~124px on its own header, footer and
  padding before it can show a pixel of picture.
- **Anything scoped to `#controls` is only half the sidebar.** The preview's
  card lives in `#previewPane` now, so the tighter card `--spacing` is set on
  `#sidebarSplit` (both panes) while `flex: 0 0 auto` stays on `#controls` — the
  preview's card is the one that must _fill_ its pane. Those two selectors have
  equal specificity, so with both at sidebar scope the winner was whichever came
  later in the file, and the preview silently stopped growing.
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
- **Wordgard's menu overflow is a _count_, and it beats an explicit template.**
  `Menu.Group.inline` is defined with `overflow: {at: 5}`, so it wraps
  everything from its fifth item onwards into a submenu — measured, that happens
  even when a template names the items explicitly. The schema contributes about
  ten mark buttons, so which four were visible was decided by rank order, not by
  anyone's choice; underline, colour, highlight and super/subscript were hidden
  that way. `editor.ts` therefore puts the formatting controls in a group of its
  own, at the rank `inline` would have taken and with no overflow, and names the
  three that go behind the dots. Do not put items back into `Menu.Group.inline`
  expecting a template to hold them. Its `"..."` slot is still in the template
  so a mark from a future extension lands somewhere visible rather than
  vanishing.
- **A per-section size is a custom mark, and three things about it are
  load-bearing.** `SectionSize` in `sectionSizeMenu.ts` is shaped exactly like
  Wordgard's own `Color`: an attribute shape on `style/font-size`, registered
  through `GardState.schemaElement.of(...)` because the config array does not
  accept a bare `Mark.Type`. The three:
  - `spanning: true`. `editor.js` applies an attribute mark to text only when
    `mark.spanning || !tag.isText`, so without it the mark sits in the document
    JSON and renders nothing at all, on every screen, with nothing in any
    console.
  - `validate: "number"` is a _typeof_ check and must not become a range check.
    A throwing `validate` makes `GardState.fromJSON` reject the whole document,
    and `restoreEditor` catches that and starts a fresh blank editor — so one
    out-of-range number would silently replace the operator's script with "New
    Document". The range is enforced at render time by `clampMultiplier`, where
    being wrong costs a wrong size rather than the text.
  - It is registered **unconditionally**, outside the `textSize ?` guard in
    `buildConfig`. `buildConfig` is also what `fromJSON` is handed, and
    `marksFromJSON` throws on a mark the schema does not know — same blank
    editor. This is document state, not a preference.

  **The size is in `em` and must stay relative.** A px or rem value would
  override the Text Scale slider, which is the one control an operator changes
  per venue, on precisely the lines they cared enough to mark. `em` also needs
  no viewer CSS at all, which matters because a user theme replaces the layout
  layer wholesale — a size depending on a rule in `viewerThemes.css` would
  quietly stop working under a custom theme, and that rules out
  `calc(var(--textScale) * k)` as well. `sectionsize_test.ts` asserts the unit.
  Note a document saved with size marks is unreadable by a build whose schema
  lacks the mark, and falls back to a blank editor: the same one-way door as the
  Quill→Wordgard migration.
- **A toolbar control whose state is the _selection's_ cannot be a
  `CustomControl`.** `render` runs once and there is no update hook, which is
  survivable for `textSizeMenu`'s slider — its state is a stored preference it
  can `subscribe()` to — and not survivable for anything reading the current
  selection, which changes on every cursor move. It would show a stale value and
  the operator would set a size from a number that is not the one in front of
  them. `Menu.Button`'s `active` is re-evaluated on every document and selection
  change, so a set of buttons is also a radio group for free, and a submenu with
  no `label` takes the active child's.
- **Wordgard's textblock dropdown is parented to `Group.top`, which has no
  `"..."` in our template** — so Paragraph / Heading 1-3 / Code block had no
  button in the bar at all for a long time, while staying reachable by
  `Ctrl-Shift-0..6` and the `#␣` input rule. That is why it was possible to
  remember having had them. It is templated explicitly now.
  `Menu.Group.block.template("...")` does _not_ cover it: that group only ever
  receives alignment, direction, the two lists and blockquote.
- **A paste is recoloured through `Wordgard.clipboardInputHTMLFilter`**, which
  `readClipboard` runs on the raw `text/html` _before_ parsing it — so the
  script arrives already correct and nothing downstream, not the document, not
  `pushContent`, not a display, has to know. Three consequences worth knowing:
  `readClipboard` is shared with drop and drag, so those come free; the
  plain-text branch never reaches the filter, which is what makes `Ctrl+Shift+V`
  the way to paste colours untouched; and the filter takes a _thunk_, because
  the editor is built at page load, before `this.settings` exists, and the
  switch can be flipped afterwards. **Only inline
  `style="color:…"`/`background-color` produces a colour mark in this schema** —
  `Color` and `BackgroundColor` are defined with no `parseRules`, so their rule
  is derived from the attribute shape and reads `elt.style` only. So
  `class`-based colouring, `<font color>` and Word's `color: windowtext` all
  arrive with no colour and inherit the bright default, correct by accident. The
  target set is much narrower than it looks.
- **The paste walk uses a `<template>`, not a `div` and not `DOMParser`.** A
  `div` in the live document fetches Word's `<img>` side-files the moment the
  markup lands; `DOMParser` with `body.innerHTML` drops a bare `<tr>…</tr>` on
  the floor, which is why Wordgard carries its own `wrapMap`. A template's
  content is parsed in the "in template" insertion mode, keeps orphan rows, and
  is inert.
- **`contrast.ts` decides in WCAG luminance and moves in OkLCH**, and it needs
  both. Luminance is the metric the requirement is written in and catches what
  perceptual lightness misses — pure blue is 2.44:1 on black while its OkLab
  lightness is 0.452, so a lightness-only rule leaves it as unreadable as it
  found it. Luminance is useless as a transform axis, because scaling channels
  either desaturates or clips a hue. Two things not to "tidy":
  - **A grey is dropped, never replaced with white.** Dropping is what lets it
    inherit `--viewer-color` and follow a user theme; hard-coding white defeats
    the palette.
  - **`adaptBackgroundColor` tests darkness _before_ greyness**, and the order
    is what makes it idempotent. Darkening a barely chromatic colour lowers its
    chroma too: `#566` sits just above the achromatic threshold and darkens to
    `#223131`, just below it, so with the tests the other way round a second
    pass dropped what the first had kept. Found by the 4096-colour sweep in
    `contrast_test.ts`, not by reasoning.
- **The tidy button serializes, cleans and re-parses, rather than editing the
  document model.** Its rules are about lines and blank space, which are DOM
  shapes; expressed as positions in the model each fix would have to be mapped
  past every earlier fix in the same transaction, and one off-by-one there eats
  a character of somebody's script. The round trip costs a whole-document change
  and the cursor's place, which a deliberate one-off action can afford. Three
  things in `tidyMenu.ts` are load-bearing: `toDOM` is handed an inert
  `createHTMLDocument` so an `<img src>` does not fetch on the way through;
  `collapseWhiteSpace: false`, because this is Wordgard's own serialization
  coming back and the default would apply HTML whitespace collapsing on top of
  the tidy; and returning `false` when nothing changed, so pressing the button
  on a clean script adds no undo step. It is a round trip through the _same_
  schema, so nothing is lost — verified on a 465-block script with headings,
  links, colours, rules and size marks all intact.
- **A line's edge is not its neighbour in the DOM.** `trimLines` decides "is
  this text at the start of a line" by scanning past _blank_ text nodes rather
  than looking at the adjacent one, and that is not defensive coding: a split
  mark leaves empty text nodes behind and Docs emits `<span></span>` freely, so
  `<p><span></span>   Indented</p>` has a blank text node in front of the
  indent. Testing the immediate neighbour, that indent is not at a line start
  and survives — it left 7 of 106 indented lines untidied on a real script,
  which is how it was found. A line is also not a subtree: `<em>one</em><br>two`
  has its break between two parents, so the walk flattens the block first.
- **`textContent` is not a way to count a document's words.** It inserts nothing
  at a block or `<br>` boundary, so trimming the trailing space before a break
  _joins_ the two lines' words into one token. Measuring a tidy that way showed
  118 words "lost" on a 2217-word script when nothing had been lost at all.
  Count per line, joining lines with a separator.
- **`Wordgard.styles` keys are _element_ selectors, not classes.** That is the
  convention its own colour picker follows — `wg-color-picker-color` is a real
  element. A key that reads like a class name never matches and fails silently:
  the text-size slider kept Chrome's intrinsic 129px width and an `accent-color`
  of `auto` while its rule sat in the sheet doing nothing. Address descendants
  by nesting from the host element (`"& input"`). Declaring these through
  `Wordgard.styles` rather than `style.css` is deliberate — they then land
  wherever style-mod puts the rest of the editor's theme, which is the slot
  problem below.
- **A `Menu.CustomControl`'s `render` runs once, not per open.** The DOM is
  built on the editor's first layout and kept, so a control that reads its value
  in `render` goes stale — the text-size popup showed 4.0 while the slider said
  2.2, and the operator would have dragged from a number that was not the
  current size. Such a control has to be pushed to, and it gets no destroy hook:
  `textSizeMenu` drops its own listener when it notices its input is no longer
  `isConnected`, because every document switch builds a fresh editor and so a
  fresh control.
- **`#setEditorScale` is the funnel: it clamps, applies, persists and
  notifies.** Every route to a new reading size goes through it — the toolbar
  control, both nudge commands, "match viewers' text size", and the restore on
  load. Hang anything that must see every change off it rather than off a
  control, the same shape `#pushSettings` has for the transport. (The lesson was
  learnt the other way round: while there was still an Editor Text slider, its
  wheel handler moved it and applied the size _without_ dispatching `input`, so
  a listener on the event missed the wheel entirely.)
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
  browser. `wheelStep` subtracts by default — a conventional mouse wheel
  scrolled away from the operator walks the thumb _down_ the track — and
  Settings' "Reverse slider scrolling" flips it for a device reporting the other
  sign. The switch is defined against what the build ships rather than against a
  physical direction, so its default is `false` and a fresh page has every
  switch off. Both wheel handlers go through `wheelStep`, so the direction is
  one answer for the whole page — and the setting is read per event, never
  cached, or the switch and the sliders disagree until a reload.
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
- **The editor's reading size is the one size that is _not_ on the wire.** It is
  the operator's own, so it goes through `#setEditorScale` (custom property,
  `localStorage`, listeners) and must never reach `#pushSettings` — sending it
  would resize every display because someone leaned into their own screen.
  `#editorTenths` is the single source of truth for how big the script is:
  "Match viewers' text size" goes through the funnel rather than writing a font
  size onto the element, so the toolbar control and the remembered size cannot
  disagree with what is on screen.
- **Its range lives in `textscale.ts`, not in the markup, and `clampEditorScale`
  is what enforces it.** This used to be a `wa-slider` in the transport column,
  and the component was clamping every write — several call sites leaned on that
  without owning it, their comments reading "clamping is the component's". When
  the slider went, nothing would have. A `+9999` nudge lands on the maximum, and
  a non-finite value comes back as the default rather than reaching the custom
  property as an invalid length, which computes `font-size: 0` and makes the
  script vanish with nothing in any console.
- **The transport sliders' defaults are read out of the markup**, once, in the
  constructor — that is what a right-click (and the palette's "Reset sliders to
  defaults") returns them to. A reset dispatches a synthetic `input`, like
  `controlCommands.ts`'s `nudge`, so it travels the same path a drag does and
  cannot forget to tell the viewers. The reading size is deliberately _not_
  reset by it any more: it was, while it was a third slider in that column, but
  resetting the transport has no business changing how big the operator's own
  script looks.
- **`keyLabel` needs an entry for every physical key name a shortcut uses.**
  Anything carrying `Alt` is written as a `code` (`BracketRight`), and without a
  `KEY_LABELS` entry the palette advertises the chord as literally
  "Ctrl+Alt+BracketRight". Type-checking cannot see this; the palette can.
- **The catch-up list is built in one place, and it has to stay that way.**
  `catchUpMessages` in `protocol.ts` is what a display gets when it joins, and
  it has two callers: `#onViewerJoined` and the preview iframe's `load` handler.
  They were two hand-written sequences and drifted three times — the theme, then
  the text scale, then the message and the scroll position — each time leaving
  the preview showing something no display was showing, which is the one thing
  it exists not to do. It lives in `protocol.ts` rather than `teleprompter.ts`
  because that is what makes it testable: anything in the control page imports
  Web Awesome and Wordgard, which `deno test` cannot resolve. `protocol_test.ts`
  asserts the list and its order, and has been watched failing with a message
  removed. Add a viewer-visible thing and it goes in the builder, not in a call
  site.
- **`dims` reports the layout viewport, not `innerWidth`/`innerHeight`.** Those
  dimensions shape the preview iframe, and the ratio every display shares is
  computed against `document.scrollingElement` — the same element
  `makeScrollSync` binds to. Report the visual viewport instead and the
  preview's layout viewport is a different height from the display's, so the
  same ratio lands on a different line. `innerHeight` reads more natural and is
  what someone will change it back to: on a phone or tablet acting as a display
  it tracks the visual viewport and shrinks as the URL bar collapses, 60-110 CSS
  px away from the layout viewport, and a display with classic scrollbars does
  the same.
- **The preview iframe only knows what it is told on `load`.** It is not a
  WebRTC peer, so it misses `#onViewerJoined`'s catch-up snapshot entirely —
  anything a joining viewer is sent has to be posted to the iframe in that
  handler too, or the preview shows something no viewer is showing. It went a
  while inheriting a 16px script while every real viewer sat at 1.6px.
- **The control page's _script_ pane moves only by explicit action.** It is not
  scroll-synced on purpose, so `goToViewerPosition`/`sendMyPosition` use the
  exported `ratioOf`/`setRatio` rather than a `ScrollSync` — making one of those
  also starts a per-frame pump and a scroll listener, which is what a
  continuously synced pane wants and this doesn't. The preview is the deliberate
  exception: see the scrub section.
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
- **Enter-to-submit and Escape-to-cancel are the library's, not ours.**
  `wa-input` calls an internal `submitOnEnter` on keydown — guarding modifiers
  and IME composition — which finds the field's form owner and clicks its
  submitter, and `wa-dialog` wraps a native `<dialog>` so Escape closes it for
  free. What is needed is markup: a `<form>`, and `type="submit"` on the button,
  because **`wa-button`'s `type` defaults to `button`**, deliberately "opposite
  of how native `<button>` elements behave". A button slotted into a dialog's
  footer is not a descendant of the form, so it names it with `form="<id>"` —
  that attribute exists for exactly this. Both forms carry `display: contents`
  so they are not boxes: each sits in a flex column, and a form that were a box
  would become the single flex item with the field and button nested inside it.
  The `submit` handlers still `preventDefault`, since a form that submits
  navigates and reloading the control page drops every display's link for as
  long as renegotiation takes. `method="dialog"` would avoid that natively but
  only inside a real `<dialog>` ancestor, and these forms are slotted into
  `wa-dialog`'s light DOM rather than nested in the `<dialog>` in its shadow
  root. Nothing listens to either button's `click`, or it would fire twice.
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
    in `setConnected`). The editor built in `teleprompter.ts`'s constructor gets
    away with it by accident of timing — it is created _before_ `wa-split-panel`
    upgrades and attaches its shadow root, so the walk reaches the document.
    **Every _rebuilt_ editor does not, and that is every document switch and
    every New.** This was predicted here as hypothetical and then found in the
    running app: after a switch, `scrollDOM` computed `height: 32211px` instead
    of `var(--pane-height)`, so `Wordgard.scrolling()` was not in force, the
    script pane grew to the length of the document and **stopped scrolling at
    all** — with nothing in any console, and a reload appearing to fix it
    because a reload goes back through the lucky path. `createWithStyles` in
    `editor.ts` is the fix this file already prescribed: copy the sheets the
    shadow root adopted onto `document.adoptedStyleSheets`, **diffed** against
    what that root held before the editor was built, so it takes the editor's
    own sheets and none of the component's. Anything that builds an editor goes
    through it.
  - This is invisible to type-checking _and_ to DOM-structure assertions —
    `.cm-editor`, `.cm-gutters` and 16 `.cm-line`s were all present and correct
    while the thing was completely unstyled. Assert **computed styles**, and
    look at a screenshot.
- **Wordgard draws its own caret, so the script's gutter has to be padding.**
  `caret-color` is transparent and a `wg-cursor` element is positioned inside
  `wg-cursor-layer`, which is placed from the scroller and accounts for
  `wg-content`'s _padding_ but not for a margin added underneath it. This file
  used to recommend the opposite: `#editor wg-content` carried
  `margin-inline-start`, and every caret was drawn **12.9px left of the text** —
  at every position along the line, so an origin shift rather than a measurement
  error — which at prompter sizes sits on the last letter instead of after it.
  As padding the error is 0.9px, the caret's own border. The declared value
  absorbs Wordgard's own 0.75rem on that element, since a longhand replaces it,
  so the gutter stays where it was. `editorstyle_test.ts` guards it against the
  stylesheet on disk: nothing else can see this — no unit test renders CSS,
  type-checking cannot, and on screen it reads as a browser quirk rather than as
  something this repo did.
- **The editor states its own `::selection`.** Left to the browser, Chrome picks
  different colours when the document does not have focus — a grey that is
  nearly invisible against this near-black editor — and an operator's window
  loses focus constantly, not least to the display they popped out. The colours
  are named rather than taken from the theme, because the selection has to stay
  readable over a script carrying its own: pasted red, a yellow cue, a
  highlighted run.
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
- **Two connections can fail independently, and only one of them used to
  recover.** A display holds a signalling WebSocket _and_ an
  `RTCPeerConnection`. `scheduleRetry` re-opens the socket every 2s for both
  roles, which covers a server restart or a wifi blip — but a peer connection
  that failed while signalling stayed up had nothing trying to fix it: the
  display reported `disconnected` once and then sat frozen on whatever it last
  received, indistinguishable to the talent from a working screen showing a
  stationary script. `makeLink` now restarts ICE for exactly that case.
  - **Only the impolite peer restarts**, i.e. the controller. A restart _is_ an
    offer, so both ends doing it is the glare perfect negotiation exists to
    resolve, and the polite one would roll its own recovery back.
  - `restartIce()`, not a hand-built offer: it marks the connection as needing
    fresh credentials and lets the existing `onnegotiationneeded` send the
    offer, so the negotiation code does not have to know the feature exists.
  - **The wait before the first attempt is the point**, not politeness.
    `disconnected` heals on its own within a second or two — packet loss, a
    laptop roaming, a phone moving to cellular — so restarting instantly
    renegotiates over every blip. `failed` is terminal but is normally reached
    _through_ `disconnected`, so one grace period covers both.
  - **Unbounded in count, bounded in rate.** A display whose network returns
    after ten minutes should come back; giving up leaves a black screen in front
    of the talent with nothing trying. The backoff caps at 30s, and `close()`
    clears the timer so a viewer that really left stops being chased.
  - Each attempt re-arms the next from inside its own callback rather than
    waiting for another state change, because a restart that fails to connect
    may never transition again — and then nothing would be left trying.
- **Cloudflare injects a script the repo never wrote, and the CSP has to admit
  it.** Web Analytics is set up by the proxy, so the deployed HTML asks for
  `static.cloudflareinsights.com/beacon.min.js` even though nothing here
  references it — and under `script-src 'self'` it was refused on every load,
  logging a violation and collecting nothing. Two hosts, because they are two
  different things: the beacon is _fetched_ from `static.cloudflareinsights.com`
  and _reports_ to `cloudflareinsights.com/cdn-cgi/rum`, so allowing only the
  script leaves it loading and then failing to report — which looks like working
  analytics until the dashboard stays empty. `main_test.go` guards both hosts
  and, in the same file, the properties that make the relaxation affordable (no
  `'unsafe-inline'`, no `'unsafe-eval'`, no `blob:`), because nothing in this
  repo references those hosts and a later tightening would drop them with no
  other test noticing.
- **A data channel refuses a message past `max-message-size`, and the script
  goes past it.** 256KB in Chrome. `sendControl` used to hand the whole script
  to `send` as one JSON string, and over that size it throws
  `TypeError: Trying to send message larger than max-message-size` — measured on
  the running app at 143KB of pasted HTML going through and 333KB throwing. Two
  things made it expensive to diagnose. The throw lands _inside the editor's
  update listener_, so it takes the rest of that handler with it and the preview
  stops updating too; and it repeats on every later edit, so the display sits on
  the last script small enough to fit with nothing on screen saying why.
  `controlframes.ts` frames an oversized message as parts — `{k: "part"}`, never
  `type`, so a part can never be read as a `ControlMessage` — and `pumpControl`
  sends them with the same backpressure and generation `pumpFile` uses. **A
  message that fits is still sent unwrapped**, which is every message but the
  script and is what keeps them synchronous and in order. Two things not to
  simplify: a cut must not split a surrogate pair (a lone surrogate is not
  encodable as UTF-8, so the channel puts U+FFFD at both ends of the join and
  the script arrives mangled), and the part count is produced by walking the
  cuts rather than by dividing the length — a cut moved back off a pair makes a
  part shorter, so the arithmetic answer can be one short and the receiver then
  waits forever for a part that never comes. A theme's CSS travels the same
  channel and is the other message that can grow without limit.
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
  looping. A box measuring 0 **in both axes** hasn't been laid out yet and falls
  back to the fixed maximums — testing the axes separately fell back on a box
  that was laid out and merely short, which the operator can now produce by
  dragging `#sidebarSplit`'s divider up, and the preview then rendered at the
  fixed size and was clipped by its pane: a fragment of a screen rather than a
  small one. The aspect ratio stays the previewed viewer's, so a portrait
  display letterboxes horizontally rather than being squeezed — the preview
  renders at that viewer's real pixel size and distorting it would defeat the
  point.
- The preview iframe runs **no auto-scroll loop of its own** — its motion is
  entirely the controller's. It is no longer the wholly passive mirror it was,
  though: it reports its scroll ratio upward so the operator can scrub the show
  from it (see the scrub section), which is the one message that travels from a
  viewer document to the control page. It is still never scrolled _by hand_ and
  never a driver. It renders at the previewed viewer's real pixel size and is
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
  reshaped the preview. Scroll is not part of the preview choice, and
  `#lastRatio` doubles as "where the previewed viewer is" for the sync buttons.
  **The reason given here used to be that "every viewer sits at the same ratio,
  so the driver's position is right to show in a box shaped like any of them",
  and that is false in pixels.** A shared ratio means a shared _fraction of the
  scrollable range_, and `setRatio` maps it to
  `r * (scrollHeight -
  clientHeight)` — so two displays of different heights,
  given the same ratio, sit on different lines, by `r` times the difference.
  Everything downstream of that is still correct: the ratio is the right thing
  to show in any box. What is not true is that the displays agree with each
  other, which is why this looked like a preview bug when it is a sync one. See
  `#reportDims`.
- **Every display lays out in `#stage`, at the _reference_ display's size.**
  Displays are kept in step by making them match, not by making the sync maths
  cleverer: the shared scalar is a fraction of the scrollable range, which
  `setRatio` maps to `r * (scrollHeight - clientHeight)`, so the same fraction
  lands on a different line on a display of a different height — measured at
  297px, about six lines, between a 1080-tall and a 768-tall display on a
  30,295px script. So the previewed viewer is the reference, every other lays
  out at _its_ pixel dimensions and `transform: scale()`s the result to fit,
  letterboxing if the shapes differ. The transform is visual only, so
  `scrollTop` stays in the reference's pixel space and is identical everywhere —
  verified: a 1280x800 and a 900x1200 display both sat at scrollTop 20287 of
  scrollHeight 43683, on the same line. `docs/roadmap.md` records the general
  fix this defers.
  - **The stage is the scroller, not the viewport**, and its layout box is
    allowed to be larger than the screen. It is centred with `translate` rather
    than by a grid because an over-sized grid item's alignment is a subtler
    question than this needs.
  - **`#previewID()` is the reference**, so changing which viewer is previewed
    relayouts the whole room. That is the deliberate consequence of the two
    being one choice; `#stageDims()` feeds the preview and the stage together so
    they cannot disagree, which is what makes the preview's own scale exactly 1.
  - **Nothing in the viewer may size itself in viewport units.** `vi`/`vh`
    resolve against the real screen, so they differ per display and the
    documents stop agreeing. The stage is a size container and `cqi`/`cqh`
    resolve against it. This bit twice: the clock strip's `8vi`, and
    `--viewer-gutter`'s `2.5vi` — which gave a 900-wide display a 22px gutter
    against the reference's 32px, a content box 19px wider, and a scrollHeight
    352px apart. `findThemeCssProblems` warns a theme author about it.
  - **`html`'s font size is pinned to 16px.** `--textScale` is a `rem` length,
    so a display with a 20px default font wraps differently and desyncs. Nobody
    browses a prompter, so nothing is lost by pinning it.
  - Told no dimensions, the stage takes the screen's own and scales by 1 — so a
    lone display behaves exactly as it did before any of this existed.
  - A known cosmetic limit, measured rather than guessed: a scaled stage's edges
    can land on a fractional pixel, and the row scrolled behind the sticky
    header then bleeds through at 32/255 brightness on a single row. Gone at
    `scrollTop` 0, so it is the content behind the header, not a clipping
    failure.
- **A viewer can only be scrolled by hand while it holds drive.**
  `viewerBase.css` locks the scroller and `viewer.ts` lifts it from the
  `set-driver` message via a class on `<html>`. The lock is `overflow: hidden`
  on `#stage` — it was on `body` while the viewport was the scroller — so the
  stage stops responding to wheel and touch. Programmatic movement is unaffected
  — `scrollTo` works fine on an overflow-hidden viewport — which is why nothing
  in the sync path ever noticed that "allow drive" granted nothing. The preview
  is not an exception to this and must not become one: it is scrolled by the
  controller on the operator's behalf, never by hand, so it needs no
  `set-driver` and its `pointer-events: none` stays.
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

### Secure-context APIs, and the first visit

**Nothing on the startup path may assume a secure context.** The app is reached
over plain HTTP by LAN address as a matter of course — that is how a phone
becomes a display before there is TLS in front of it — and on such an origin
`crypto.randomUUID` and `navigator.clipboard` are simply absent.

- **`randomID()` in `ids.ts`, never `crypto.randomUUID` directly.** The latter
  threw out of the control page's constructor, which wires itself up in one
  pass, so the page came up looking merely slow: no editor, no room id, an empty
  viewer link, and a badge stuck on "Connecting". It failed only on a **first**
  visit, and that is the tell rather than a coincidence — the three seeding
  paths (no room id, no control key, no documents) are the only code that mints
  an id, so a browser past them once had the answers in storage. `#ensureRoomID`
  threw first, before the documents store was reached.
- The fallback is `getRandomValues`, not `Math.random`: no secure-context
  requirement, and one of these ids is the control key that stops a stranger on
  the same network claiming a room. It stamps the v4 version and variant bits,
  so an id minted on an insecure origin cannot be told from one minted on a
  secure one — they are stored, compared, and in the room's case sliced.
- **WebRTC data channels do _not_ need a secure context**, verified: on the LAN
  address a local screen negotiates and renders normally. Only the id generator
  and the clipboard did.
- **`app.ts` catches a startup throw and puts it on the page.** A constructor
  that dies half-way is indistinguishable from a slow connection, and that is
  what made this expensive to find. Any new work on the startup path inherits
  this safety net; don't remove it.

### The local screen, and local vs remote

`#btnPop` opens or closes **one** window, on this machine, and shows which.
Everything else in the room arrives by itself through the viewer link.

- **Closing a popup notifies nobody.** No event fires in the opener, and the
  popup's own `pagehide` cannot be relied on to run before it goes, so
  `#popWin.closed` is polled. That poll is the button's only way of being
  honest.
- **A control-page refresh loses the handle while the display keeps running.**
  The display posts `{type: "pop-hello"}` to its `opener` every two seconds and
  a fresh control page adopts `event.source`; `opener` survives the opener
  navigating, which is what makes this work. Without it the button reads
  "closed" for the rest of a session that still has a screen on. A refresh must
  _not_ close the popup — a new controller evicts the sitting one and the
  display rejoins by itself.
- **`getScreenDetails` throws _and_ rejects.** Missing outside Chromium, and
  refused when the permission is denied. Unguarded in an `async` click listener
  it escaped as an unhandled promise and the window silently never opened.
- **A window cannot fullscreen itself on load**, and the control page cannot do
  it for another window: `requestFullscreen` only acts on elements in your own
  document and needs an activation there, and `window.open` _consumes_ the
  opener's. Measured, not assumed — a click-opened display comes up with
  `document.fullscreenElement === null` every time. Three things cover it, in
  order: the `fullscreen` window feature (Chrome's fullscreen companion window,
  zero clicks, but only with the Window Management permission _and_ a second
  screen — it is a multi-screen feature and does nothing on one display);
  `moveTo`/`resizeTo` to the screen's available area, which script may do to a
  window it opened with no activation at all and which leaves only a thin URL
  strip on a `popup=true` window; and a click anywhere for true fullscreen.
  There was a click-to-fill prompt here and it was the wrong answer: the display
  is pointed at the talent, and a message they must look at until someone clears
  it is worse than the chrome it removes.
- **Size the window after `load`, not on construction.** Asked for while the
  window is still being placed, the resize is undone by the placement that
  follows — the same call measured at 1518px wide on load and 3072 a moment
  later. A window manager that owns geometry overrides it regardless.
- **Skip the doomed fullscreen call rather than catching it.** Chrome logs "API
  can only be initiated by a user gesture" _itself_, where no `catch` can reach
  it, so calling with no activation put a warning in the operator's console on
  every open. `navigator.userActivation?.isActive` is the guard.
- **A display decides for itself whether it is local**, on two same-origin
  signals: `opener` for a window this page opened, and a
  `BroadcastChannel(LOCAL_CHANNEL)` handshake for the rest — the channel reaches
  only pages of this origin in this browser profile, so an answer arriving _is_
  the evidence. That second signal is what covers a window the operator opened
  from the viewer link by hand, since the link carries `rel="noopener"`. The
  control page answers probes rather than announcing itself, because a display
  can start at any time. Honest limit: "same browser profile on this machine",
  so a second _browser_ on the same desk reads as remote. Nothing is granted on
  the strength of it, so being wrong is cosmetic.
- The flag rides on `DimsMessage`, which is already sent on connect and on every
  resize, so a reconnect re-establishes it for free.
- **The count says "2 local · 1 remote", and that is the point.** A bare total
  reads identically whether three people are watching on three devices or three
  windows are stacked on this laptop. The `Live` badge is unchanged and still
  answers its own one question.

### Live editing

The switch in the Sync card decides whether an edit reaches the displays as it
is typed; `pushContent` is the deliberate "show them now".

- **`#publishedHtml` is what the displays are showing; the editor is what the
  operator has.** Telling them apart is the load-bearing part. `#onViewerJoined`
  and the preview's `load` handler both read the editor directly, so without it
  a display reloading mid-service came back showing the draft while every other
  display showed the real script. Watched failing before it was fixed.
- **`closePdf` pushes the published script unconditionally.** Routed through the
  gate it would send nothing and leave every display blank, which is worse than
  a slightly old script.
- **The first content of a session is always published** (`#everPublished`).
  Nothing has been sent yet, so there is no earlier script for the displays to
  be showing instead, and holding it back would send them the empty string.
- **The switch is remembered, so the app bar says when it is off.** `#icnHeld`
  is amber and appears only when the displays are not tracking the editor,
  because a remembered "off" otherwise means a reload comes back quietly not
  live and the operator types into a screen showing something else.
- **Both shortcuts are `allowWhileTyping`.** They are reached from the editor
  with the cursor in the script; suppressed while typing — which is the default
  — they would be shortcuts that never fire when they are wanted.
- Dropping a PDF still goes out immediately: it is a deliberate action, not
  typing.

### Clocks

`ClockMessage` carries the countdown's **whole state** (`running`,
`remainingMs`), not a command. It used to be `start`/`stop`/`reset(time)`, and
that is why the timer restarted on every reload and the copies drifted:
"running" existed nowhere but a live `setInterval` in each receiver, stepping
its own `Date` back a second per tick. Nothing to replay, nothing to write down,
and a copy that missed ticks in a background tab simply ran slow.

- **A remaining duration, never an absolute deadline.** An epoch stamped by the
  control page is read against the _receiver's_ clock, so a display whose clock
  is off — a phone, a Pi that has not reached NTP — would show nonsense. The
  receiver anchors it to its own clock on arrival; measured transit is ~1–20ms.
- **Nothing caches the state.** `TPClockControl.state()` is asked every time one
  is needed, because a remembered `remainingMs` stops being true the instant it
  is taken: handing a 36-second-old "two minutes left" to a display that has
  just connected started it 36 seconds behind. Measured. It is the old
  protocol's mistake in miniature, and the reason `#setClock` takes no argument.
- **Redraws are aimed at the moment the text turns over, not fired on an
  interval.** An interval runs on whatever phase it was started on, so two
  copies redrew up to a period apart and read a whole second differently —
  measured between the operator's countdown and the preview's. `#msToNextChange`
  derives the next boundary from the deadline both copies were given, so they
  land together; 131 samples across three copies now show zero disagreements. It
  fires a few ms _late_ on purpose, or a redraw can land a hair before the
  boundary, paint the same text and then wait a whole second.
- **The state is replayed in both catch-up sites**, `#onViewerJoined` and the
  preview iframe's `load` handler. Both were one gap behind on the timer while
  theme and text scale were already handled.
- **`teleprompter.timer` in localStorage carries the moment it was written**, so
  the operator's own refresh resumes where the countdown _would have been_
  rather than where it was left. Elapsed time is clamped at zero: a clock that
  went backwards (NTP, a suspend) would otherwise lengthen the countdown.
- **The reset target is stored separately from where the countdown has got to.**
  The three fields are what Reset means, so restoring the running value into
  them would turn a five-minute countdown refreshed at 4:38 into a 4:38
  countdown from then on. `ResetTarget` carries the mode and _both_ fields'
  values whichever mode is live, so switching modes does not empty the other
  one.
- **The "time of day" mode resolves to a duration on the control page, and that
  is the whole of it.** `TPClockControl.resetMs` is where the two modes
  converge: a target time is turned into a remaining duration against _this_
  page's clock at the moment Reset is pressed, and nothing downstream — the
  wire, the storage, `TPClock`, every display — knows there are two modes at
  all. The obvious implementation is to send the target and let each display
  subtract, and it is the one thing this must never do: an epoch stamped here is
  read against the _receiver's_ clock, which is the hazard `ClockMessage`
  already documents. `ClockMessage` did not change to add this mode, and should
  not.
- **`msUntilTimeOfDay` is the one place building "today at HH:MM" out of a
  `Date` is correct**, and it looks exactly like the mistake below, so its
  comment says why it isn't. Two things there are load-bearing: `parseTimeOfDay`
  is strict where `parseDuration` is tolerant (an hour above 23 is a typo in a
  time of day and a legitimate ninety-nine hours in a duration), and "tomorrow"
  is `setDate(+1)`, never `+ 86_400_000` — across a daylight-saving boundary the
  same clock time is 23 or 25 hours away. The DST guard is asserted by where the
  rolled target _lands_ rather than by how far away it is, so the test holds in
  any timezone and fails in a DST one if the arithmetic regresses.
- **A `wa-radio` is light DOM; the flex container it sits in is not.** The mode
  switch needs two rules that read like they should be one:
  `#rdoTimerMode
  wa-radio` for the buttons and
  `#rdoTimerMode::part(form-control-input)` for the row. Nesting the first
  inside the second is the tidier-looking spelling and matches nothing — **a
  descendant selector cannot follow `::part`**, and the rule is dropped in
  silence. Measured: the two buttons kept their intrinsic 79px and 98px instead
  of splitting the card's width. Sized to fill, they also cannot be broken onto
  two lines by the slot's own `flex-wrap: wrap`, which is the `wa-button-group`
  trap in the app bar.
- **`parseDuration` sums fields; it does not build a time of day.** The old
  `parseTimer` set hours/minutes/seconds on a `Date`, so an hour field above 23
  rolled the date over. `formatDuration` rounds _up_ in absolute value, so a
  countdown started at thirty seconds reads 0:30 rather than flicking to 0:29.
- The `observedAttributes = ["countdown"]` path is gone: it only acted on a
  `type="countdown"` this app never used, so nothing on it ever ran.

### Scrubbing the show from the preview

A wheel or drag over the preview moves every display, armed by `previewScrub`
(off by default). It behaves like hand-scrolling the driver: it displaces the
position and the pacer carries on from there at the set speed.

- **The gesture is handled on the control page and forwarded _into_ the iframe**
  as `scroll-by`, rather than letting the iframe scroll itself. Two reasons,
  both measured and both silent:
  - `tinykeys` installs every binding on the control page's own window
    (`paletteControls.ts`). Giving the iframe `pointer-events` makes it
    focusable, so one click on the preview would send Space, `Mod+K` and every
    chord into _its_ document — using the scrub gesture would disarm the
    operator's keyboard for the rest of the session. `#ifrmPreview` keeps
    `pointer-events: none`; the topmost element at the preview's centre is
    `#divIFrameContainer`, and that is what the listeners are on.
  - A `scroll` event **also fires when a layout change clamps `scrollTop`**, and
    the preview relayouts on every keystroke with live editing on, on a PDF load
    and on every re-fit. So the previewer offers its ratio unconditionally and
    the control page accepts one **only while a gesture of its own is in
    flight**. Verified by moving the preview from inside itself with no gesture:
    it went 869 → 0 and the display stayed at 869.
- **`scroll-by` is applied outside `applyRemote`, deliberately.** The resulting
  scroll event has to be sampled and reported, which is the same reason
  `smoothScroll` uses a bare `scrollBy` to produce the driver's samples. Routing
  it through the echo guard would swallow the very thing that has to travel.
- **`deltaY` is only pixels when `deltaMode` says so.** Chrome on Windows sends
  pixels, about 100-120 a notch; Firefox on Windows sends _lines_, `deltaY: 3`
  for the same notch. Read as pixels that notch moved the show three pixels, so
  the scrub did almost nothing in one browser and worked in the other with
  nothing in any console. `wheelPixels` normalises it, and a line is a
  **constant** 40px rather than the script's own line height: that height
  changes with the Text Scale slider, so tying a notch to it would make the same
  gesture travel a different distance at every venue. Measured after: a
  line-mode notch and a pixel-mode notch both move 119px.
- **A wheel scrub is eased, and that is not the easing the sync path forbids.**
  The rule against throttling or interpolating the fan-out is about the pacer's
  ~60Hz samples: they describe where a display _is_ and must be applied the
  instant they land. `scrubStep` is on the other end of the wire — a gesture, on
  the control page, before anything has been sent — and it turns one coarse
  sample into a stream of fine ones, so viewers get _more_ positions, each still
  applied immediately. Easing the fan-out adds lag to someone else's motion;
  easing a gesture adds frames to your own. **Only the wheel.** A drag is direct
  manipulation and has to track the finger.
- **The scrub's easing is tuned for a _coarse_ wheel, and needs both a fraction
  and a cap.** The first attempt spent 28% of the remaining debt each frame,
  which settled in about ten frames and still read as jumpy on the cheap Windows
  mouse the feature exists for — a notch arrives as one 120px chunk and 28% of
  it is a 33px pop. It is 11% now: a notch spreads over ~31 frames with a 13px
  peak, and consecutive notches accumulate so velocity _builds_ (13, 23, 29)
  into one continuous movement instead of five separate pops. The fraction alone
  is not enough, though: a fling puts hundreds of pixels of debt in within a few
  frames and 11% of that is the jump the easing exists to remove, so
  `SCRUB_MAX_STEP` caps a frame at 80px — measured engaging at exactly 80 on a
  1440px fling, where the uncapped first step would have been 158. The cap never
  bites on a single notch, so ordinary scrolling is governed by the fraction.
- **Every drained scrub frame renews `#scrubUntil`.** The hold is 300ms and a
  glide can run longer, so renewing it only on the wheel event lets the
  operator's authority lapse mid-gesture — and the driver's in-flight samples
  then fight the tail of every scroll, which is exactly the judder the constant
  exists to prevent. It is also why a debt that cannot be spent is dropped
  rather than carried: a frame loop kept alive for a hundredth of a pixel keeps
  suppressing the driver with it.
- **`SCRUB_HOLD_MS` is not about the echo guard.** The gesture never passes
  through `applyRemote`, so it cannot be swallowed. The window drops the
  driver's _in-flight_ samples, which for about a round trip still describe the
  position it held before the scrub reached it — relayed, they fight the gesture
  on every other display. Two round trips plus a frame. Shortening it brings the
  judder back.
- **The ratio goes to _every_ viewer including the driver**, so the driver moves
  and its own loop carries on from the new position. Nothing is posted back to
  the preview, for the same reason the pacer is never sent its own position.
  `#lastRatio` is updated too, or a display joining after a scrub would catch up
  to the last pacer sample instead.
- **A `driverID` sentinel was the wrong shape** and is worth not retrying:
  `#applyScrollRoles` derives `settings{autoScroll}` from `#driverID()`, so a
  sentinel would revoke the real driver's auto-scroll — the opposite of the
  behaviour wanted. Suppressing only the echo _into_ the preview is also wrong;
  the driver's stale samples would still fight the scrub on every other display.
- **Wheel deltas are not scaled; drag deltas are.** A notch means what it means
  on the display itself, and dividing by the ~0.2 preview scale would send half
  a page per click. A drag is the opposite — direct manipulation has to track
  the finger — so `movementY` is divided by `#previewScale`. Neither goes
  through `wheelStep`: `invertWheel` is about which way a wheel moves a slider
  _thumb_, and routing a document scroll through it would make the preview run
  backwards for anyone who has that switch on.
- **The armed state is marked on the preview itself.** The switch is a
  remembered preference inside a dialog and what it arms moves what the audience
  reads, so the surface whose behaviour changed carries the outline and the
  cursor, plus an app-bar icon. Same reasoning as `#icnHeld`.
- `touch-action: none` on the armed container, or a touch-drag scrolls the
  sidebar out from under the gesture.
- **The end-of-document guard stops the pacer early**, by design but
  imprecisely: it compares `innerHeight + scrollY` against
  `document.body.offsetHeight` while the scrollable range comes from
  `scrollingElement.scrollHeight`, so a display parks tens of pixels short of
  its real maximum. Pre-existing, and visible now that a scrub can put a display
  anywhere. Also note the guard is permanently true when the document is shorter
  than the viewport, so such a display never auto-scrolls at all.

### Colouring the script

Ctrl+Alt+C opens a searchable colour list, Ctrl+Alt+H repeats the last colour,
and Ctrl+Alt+Y/R/B/N are the direct ones. `colours.ts` holds the palette,
`textColour.ts` applies it, and the picker is the command palette in a third
mode.

- **Ctrl+Alt, not bare Alt.** Bare Alt+letter opens the browser's menus on
  Windows and Linux and _inserts a character_ on macOS (Option+Y is ¥), and
  these are pressed with the cursor in the script — a chord that fights the
  editor is worse than no chord. It is also the family the rest of the table
  uses. All six are `allowWhileTyping`, or they would be suppressed exactly when
  they are wanted.
- **There is no standard to follow for per-colour chords** — no major editor
  ships them, checked before choosing. What _is_ conventional is repeat-last
  (Notion `Ctrl+Shift+H`, Docs `Ctrl+Alt+H`, hence `H`) and a searchable list
  (Notion's `/red`). Worth knowing before someone "corrects" these to match
  another app.
- **Clearing a colour is not `remove: Color.of("")`.** An attribute mark is
  matched by its _value_, so removing an empty-valued Color leaves a `#ffd400`
  run exactly as it was — verified in the browser, where the span survived the
  shortcut with nothing reported anywhere. The document has to be walked over
  the selection and the instance actually present removed, which is what
  Wordgard's own `setColor` does, and a range can hold several colours at once.
- **A bare cursor needs the stored-marks branch.** Colouring with no selection
  means "what I type next", which is a mark on the selection rather than a
  change to the document; without it, pressing a colour chord before typing a
  cue does nothing at all.
- **`wa-dialog` returns focus but not the caret.** After picking from the
  palette the editor reported `hasFocus` while the browser's selection was still
  inside the closed dialog's markup, so the next keystroke landed at the _top_
  of a 200-block script. `PaletteControls` takes a `restoreFocus` callback and
  calls it on `wa-after-hide` — after the hide, because the dialog restores
  focus as part of hiding and anything done before is undone — and the control
  page re-asserts `state.selection`, which is what writes the caret back.
  `state.selection`, not `state.sel`: the latter is the resolved selection and
  `dispatch` wants the plain one.
- **The palette is contrast-checked, not chosen by taste.** `colours_test.ts`
  runs every entry through `contrastOnBlack` and `MIN_TEXT_LUMINANCE` — the same
  bar `brightenTextColor` applies to a _pasted_ colour. Shipping a list is only
  worth anything if the list passes it: plain blue is 2.44:1 on black, which is
  why the blue here is a pale cornflower. The operator can still reach any
  colour through the editor's own picker.
- **"Default" clears the mark rather than setting white**, so the run inherits
  `--viewer-color` and follows a user theme — the same reasoning as
  `contrast.ts` dropping a grey instead of replacing it. It is also the one
  choice not remembered by "repeat last colour", which would otherwise come to
  mean "clear it again".

### Remembering where the operator was

The control page's own pane is stored per document as a `BlockPos` on `Doc`, and
restored a frame after the editor is built.

- **A block and a fraction, never pixels or a ratio**, for the reason the Sync
  buttons already carry: the reading size and the pane's width both change
  between sessions, and a bigger font wraps long paragraphs more than short
  ones, so neither survives. The block index is the same document either way.
- **`setScrollFor` takes the id explicitly.** `setCurrent` moves before the
  editor is rebuilt, so writing against "the current document" files the
  outgoing pane's position under the script just opened — the operator then
  opens a script and lands somewhere they have never been. `#loadedDocID` is
  what the control page measures against.
- **Restored after a frame, not immediately.** The editor is built synchronously
  but has no geometry until layout, and `#blockMetrics` measured before that
  returns zero-height blocks, which resolves to the top — silently losing the
  place this exists to keep.
- Shares `DocStorage`'s throttle and its timer: a wheel produces events as fast
  as typing does, and each write serialises the whole collection. The control
  page measures _and_ flushes on `pagehide`/hidden rather than leaving it to
  `DocControls`' own handler, which was registered first and so would write
  before the measurement.
- PDFs are excluded: held in memory for the session, so there is nothing to come
  back to.

### The Sync buttons, and the coordinate space their offsets live in

`goToViewerPosition`/`sendMyPosition` translate **by block index, not by
ratio**: the editor's document is not a scaled copy of a display's (measured,
32,252px at 33.6px text against 51,460px at 48px), because a bigger font wraps
long paragraphs more than short ones, so the same fraction is a different place
— about 49 lines out on a real script. Both documents come from the same
published HTML, so the index is a coordinate they share exactly, and the preview
supplies the displays' half of the geometry.

**`#blockMetrics`'s offsets have to be in the same space as the `scrollTop` they
are paired with**, and `offsetTop` is not: it is measured from the offset
parent, which in a display is `#stage` with the sticky `#header` above `#main`.
It used to subtract the first block's own `offsetTop`, which moves that error
rather than removing it — that zeroes the first block instead of locating it —
and the comment defending it claimed to be taking the gutter out, which no
_horizontal_ padding can do to a _vertical_ offset. Measured through rects
against the scroller now, and `#previewBlockMetrics` measures from `#stage`
rather than `#main` for the same reason. See the viewer's `#offsetInStage` for
why the opposite spelling is right there.

**The clock strip is sticky and opaque, so the readable top is
`scrollTop + strip height`, not `scrollTop`.** Both Sync buttons translate
through `#previewFold`, and a display's own re-anchor through `#foldOffset`,
because the operator's pane has no such strip: without it every translation
landed the block _behind_ the strip, 118px or about two lines out in the same
direction — which is the "off by about the clock height" first reported against
the position sync. Both read the header's computed `position` rather than
assuming, since a user theme may make it static or leave it out.

### Resizing from the driving display

A pinch or a Ctrl+wheel on the display that holds drive resizes the script for
the whole room: the viewer applies it locally, sends a `text-scale`, and the
controller moves the Text Scale slider and broadcasts the result like any other
size change.

- **There is no zoom event**, and the three things the platform does offer are
  not interchangeable. `wheel` with `ctrlKey` is both a trackpad pinch and a
  mouse's Ctrl+scroll, so one handler covers every non-touch device. A
  touchscreen pinch produces no `wheel` at all — WebKit has `gesturestart`/
  `gesturechange`, whose `scale` is already the ratio from the start of the
  gesture, and everywhere else it is two Pointer Events. Feature-detected, so
  the two paths can never both fire. The third, `visualViewport` resizing
  because the _browser_ zoomed, is the one to **withhold**: browser zoom moves
  the visual viewport while `#reportDims` reports the layout one, so a
  pinch-zoomed display silently stops matching the stage box every other display
  lays out in — which is the invariant that makes one ratio exact everywhere.
  `touch-action: pan-y` on `html.can-drive #stage` and `preventDefault` on a
  non-passive `wheel` are what withhold it.
- **The gesture is a ratio, never a pixel delta.** `#stage` carries
  `transform: scale()`, so pointer coordinates are in screen pixels while the
  script is laid out in the reference display's — a "pixels apart to tenths"
  mapping would make the same physical pinch mean different things on a
  letterboxed display and on the reference one.
- **The base scale is frozen at gesture start** (`#gestureBase`). The controller
  echoes each new size back as `settings`, and a cumulative ratio applied to a
  base that has already moved multiplies with its own echo.
- **The guard is at both ends, and the viewer's is explicit.** The preview
  iframe is excluded by `!this.isPreviewer`, not by the fact that nothing posts
  it a `set-driver` and that `#ifrmPreview` takes no pointer events — those are
  two coincidences elsewhere, and the preview must never become an exception to
  the drive rule. The controller checks `#driverID()` as well, and clamps
  _before_ anything else: the number arrives from another machine and ends as a
  `font-size` on every display, where a non-finite one computes 0.
- **No scroll message is sent for a resize, and that is what makes it safe.**
  Every display re-anchors on the block it was showing, independently, because
  they all lay out in the same reference box and wrap identically. The
  alternative — the driver reporting a ratio — has a race that no amount of
  timing fixes: `settings` travels the reliable ordered channel and a scroll
  sample the unreliable unordered one, so a follower can apply the ratio against
  pre-scale geometry, then re-anchor from the wrong block, **permanently**.
- **The anchor is the block's element, not an index into an array.** A rebuilt
  offsets array is a walk of every block on a script that runs to hundreds;
  `offsetTop` after the relayout is one read. `#offsetInStage` walks
  `offsetParent` rather than using rects, the **opposite** of `#blockMetrics` on
  the control page, and both are right for their own case: the stage is
  transform-scaled so rects are in the wrong space here, while over there
  nothing is scaled and the editor's scroller is not positioned, so it is not in
  the offsetParent chain at all.
- **A display's re-anchor is never reported.** `ScrollSync.applySilently` puts
  it through the same echo guard `applyRemote` uses, and it is not a nicety: the
  driver's re-anchored position describes its _new_ geometry and travels the
  unreliable channel while the size travels the reliable one, so a follower that
  got it first applied it to a document it had not rescaled — measured two
  blocks, about 600px, and it stayed there because the follower then re-anchored
  from the wrong block. The preview is the deliberate exception; its report is
  how the control page learns where the room ended up.
- **`SCALE_HOLD_MS` drops the driver's in-flight samples**, like `SCRUB_HOLD_MS`
  and for a related reason: for about a round trip after a resize the driver is
  reporting positions in a document only it has relaid out. The preview's own
  re-anchor is accepted during that window to keep `#lastRatio` fresh — it feeds
  `catchUpMessages` and `goToViewerPosition` — but deliberately **not** fanned
  out, for the ordering reason above.
- In PDF mode the gesture stops where the zoom stops. `#pdfWidth` clamps to
  0.25–4 against a wire range of 0.1–10, so past that the shared number and the
  operator's slider would go on moving with nothing changing on any screen. The
  block re-anchor is skipped there too: `PdfView.setWidth` does its own ratio
  re-anchor and a second one only fights it.

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
- **The viewer's palette is seven custom properties in `viewerBase.css`.**
  `--viewer-bg` and `--viewer-color` are applied _there_, on `html`, which is
  the layer under every theme — so a theme that overrides just those two
  recolours the screen without restating a layout, which is the only reason a
  token is worth having. The five accents (`--clocks-bg`, `--clock-color`,
  `--timer-color`, `--timer-negative-color`, `--message-color`) are read by the
  built-in layouts and by `THEME_TEMPLATE`, so they follow a theme that keeps
  those rules and are taken over by one that rewrites them. Both halves are
  verified in the browser. The list is documented to authors in the template's
  own comment; change it in one place and change it in the other.
- **A viewer is white-on-black, and that lives in the base layer, not a
  layout.** Nothing set either until now — `viewerBase.css` had the `html` rule
  commented out — so the default layout put a black script on a white page: a
  lamp pointed at the talent through the glass.
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
