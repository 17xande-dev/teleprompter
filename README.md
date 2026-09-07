# teleprompter

An open source teleprompter running in your browser. What a time to be alive.

A **control** page holds the script and the controls; one or more **viewer**
displays show it — a popup on a second monitor, a tablet on the floor, a laptop
across the room. Scroll position, content, speed, text size, layout, messages
and clocks all stay in sync between them, peer-to-peer.

The control page's own pane is deliberately _not_ scroll-synced. The operator
reads ahead of, or behind, the audience; the **Sync** buttons close that gap on
purpose, in either direction.

## Run

The frontend is TypeScript bundled by [Deno](https://deno.com) into
`src/backend/dist`; the Go server embeds that and serves it alongside the
signaling endpoint.

```sh
deno task build            # frontend -> src/backend/dist
cd src/backend && go run . # serve + signaling on :8080
```

Or, while developing, both together with live rebuilds:

```sh
deno task dev              # watch-bundle the frontend AND run the Go server
```

`deno task dev` passes `-dev` to the server, which then reads `dist/` from disk.
The embedded copy is fixed at compile time, so without that flag a rebundle
stays invisible until the Go process restarts. `-addr` moves it off `:8080`.

Open <http://localhost:8080>. The control page gives itself a room and shows a
viewer link — open that on any device on the network, or hit **Popup** for a
viewer window on this machine. Double-click a viewer to go fullscreen.

## Operating it

### The script

Type into the editor and every viewer updates as you go. Documents live in the
control page's browser storage — the **Documents** dropdown switches, renames
and deletes them, and whatever you were typing survives a refresh (writes are
coalesced to one every 500ms, and flushed when the page is hidden).

**Or drop a PDF on the editor.** It takes over the pane for the session, renders
as a plain column of pages, and travels to the viewers over its own data
channel. Text Scale becomes a zoom where 1.0 is fit-to-width, which is where a
freshly opened PDF lands. **Close PDF** returns to the script. A PDF is held in
memory only — it is deliberately never written to browser storage, whose quota
it would blow through, taking the text documents with it.

### Scrolling

**Scroll Speed** is a two-way slider: down is forward, matching the direction
the text travels, and up is reverse. Space starts and stops the scroll without
forgetting the speed, which is a different thing from setting the speed to zero
— zero leaves the pacer running for a cue you are about to jump to.

The **Sync** buttons close the gap between your pane and the audience's:

- **Go to viewers** pulls your pane to where they are.
- **Send my position** pushes them to where you are. Audience-visible.
- **Match viewers' size** / **Send my size** do the same for text size, so both
  ends put the same words on each line and the position buttons land somewhere
  recognisable.

Exactly one viewer paces the scroll. **Allow drive** picks which; without a pick
it is the first to connect. Only that viewer can also be scrolled by hand, and
only it integrates the speed — two viewers each running their own clock drift
apart within a minute with nothing to pull them back.

### Keyboard

**Ctrl+K** opens the command palette, **Ctrl+/** lists every binding. One table
feeds the palette, the keyboard and the gamepad, so what is shown next to a
command is what actually fires.

| Command                     | Key                             | Pad   |
| --------------------------- | ------------------------------- | ----- |
| Start / stop scrolling      | `Space`                         | Cross |
| Scroll faster / slower      | `Ctrl+↑` / `Ctrl+↓`             |       |
| — in large steps            | `Ctrl+Shift+↑` / `Ctrl+Shift+↓` |       |
| Set scroll speed to zero    | `Ctrl+Alt+0`                    |       |
| Go to viewers' position     | `Ctrl+Alt+G`                    | L1    |
| Send my position to viewers | `Ctrl+Alt+J`                    | R1    |
| Bigger / smaller text       | `Ctrl+Alt+=` / `Ctrl+Alt+-`     |       |
| Send message                | `Ctrl+Enter`                    |       |
| Pop out viewer window       | `Ctrl+Alt+P`                    |       |
| Command palette / shortcuts | `Ctrl+K` / `Ctrl+/`             |       |

Everything else — matching text size, the countdown, new document, close PDF,
copying the viewer link, switching document or layout — is in the palette. There
are no bindings on `Ctrl+0`, `Ctrl+=` or `Ctrl+-`: Chrome handles browser zoom
above the page, so a binding there looks right and never fires.

### Game controller

Plug in a controller and a pad icon appears next to **Controls**. Chrome only
admits a pad exists once a button is pressed, so give it one.

| Control          | Does                                                     |
| ---------------- | -------------------------------------------------------- |
| **R2**           | scroll forward, 0 → full speed, proportional to pressure |
| **L2**           | the same, in reverse                                     |
| **Left stick ↕** | scroll your own pane — find a place in the script        |
| **Cross**        | pause / resume, speed remembered                         |
| **R1**           | send my position to the viewers                          |
| **L1**           | go to the viewers' position                              |

The throttles are absolute, not incremental: the slider follows your finger and
letting go stops. Squeeze both and they cancel. Pausing with Cross leaves the
speed where it was, so resuming picks up where you left off — and a pad you are
not touching never writes the slider, so the wheel and the arrow keys keep
working with one plugged in.

Buttons are read as commands, so a pad press, a palette row and a shortcut are
the same action. Button numbering comes from the Gamepad API's `"standard"`
mapping; a controller the browser can't fit to that mapping is ignored rather
than guessed at.

### Messages and clocks

A message overlays every viewer at whatever size fits its box — for "wrap up" or
"mic 2 is off". The countdown and wall clock are part of the viewer layout.

## Architecture

The Go server only does **signaling**. Once two peers have found each other,
scroll position and content travel directly between them over WebRTC data
channels; the server never sees either.

```
                   ┌──────────── Go server (:8080) ────────────┐
                   │ /ws   signaling relay, one room per session │
                   │ /ice  STUN/TURN config                      │
                   │ /     the embedded frontend                 │
                   └───────────────────┬─────────────────────────┘
                                       │ SDP/ICE only
      ┌────────────────────────────────┼────────────────────────────────┐
      ▼                                ▼                                ▼
[Control page]                  [Viewer: window]              [Viewer: another device]
 one RTCPeerConnection ───── scroll (unreliable) + control (reliable) ─────┘
 per viewer, plus a local
 preview iframe over postMessage
```

**Star topology.** The control page holds one `RTCPeerConnection` per viewer and
is always the WebRTC perfect-negotiation _impolite_ side; viewers are always
_polite_ and only ever talk to the controller, never to each other. That keeps a
viewer's job simple no matter how many others are connected.

**Sync state, not pixels.** Both ends render the same HTML; what crosses the
wire is a `0..1` scroll ratio, not video. A ratio rather than a pixel offset is
what lets a phone, a 4K display and the control page's scaled-down preview all
sit on the same line.

**One pacer, at full rate.** The driving viewer's position goes out on every one
of ~60 samples a second and is applied instantly at the far end. That is why it
feels smooth; an earlier attempt to send 4/sec and interpolate between samples
was strictly worse. Two viewers measured under the current scheme track to
within a pixel.

**The preview is a real miniature.** The iframe renders at the previewed
viewer's actual pixel size and is CSS-scaled down, so text wraps exactly as it
does on that display. Sizing it to the small on-screen box instead would reflow
the content and show the operator something no viewer is rendering. Which viewer
it mirrors is a separate choice from which one drives, because they need not be
the same shape or the same device.

## Rooms, links and control

A room id identifies a session and is in the control page's URL, so a refresh
rejoins the same room. The viewer link carries only that id.

Control of a room is held with a separate **key**, generated by the control page
and kept in `localStorage` — never in the viewer link. The first controller into
a room claims it; any controller afterwards must present the same key. Without
this, since a reconnecting controller displaces the sitting one, anybody who was
sent a viewer link could take over the session and push their own content to
every display.

## Viewer layouts and themes

Two layouts ship built in — **Clocks & Text** and **Big Clocks** — and the
**Viewer Layout** dropdown beside the preview switches every display at once.

Beyond those, **New Theme…** creates a layout you write yourself in plain CSS. A
theme starts as a copy of the default layout's rules, with the markup contract
commented at the top, and the dialog's editor pushes each change straight to the
preview _and_ to every connected display, so you style against the real thing
rather than guessing. Save keeps it; Cancel puts back whatever was on screen
before.

A theme replaces the built-in layout entirely — it isn't layered on top — so
what you see is what your CSS says. Three things stay out of your hands: the
message's font size (recalculated to fit its box), `--textScale` (the Text Scale
slider), and the height and spacing of `.pdf-page`, which is what makes a scroll
position land on the same line on a phone and on a 4K display. The editor warns
you if a rule touches that last one, and if you use `@import` — which won't
apply, since a theme is installed as a constructed stylesheet with no base URL.
`url()` can only reach this server, per the page's CSP.

Themes live in the **control page's** browser storage, and the operator's
machine ships the CSS to each display over the same data channel as everything
else — so viewers need no setup, and a display that reloads mid-service comes
back wearing the right theme. Nothing is stored server-side yet; clearing that
browser's storage loses them.

## TURN (NAT/firewall fallback)

STUN gets peers connected in most co-located cases; TURN is the fallback for
networks that block direct peer traffic (guest wifi, client isolation). The
client fetches ICE config from `GET /ice` at connect time — credentials are
never hardcoded in the frontend. The server issues short-lived HMAC credentials
following coturn's `use-auth-secret` scheme:

```sh
TURN_URLS="turn:turn.example.com:3478" \
TURN_SECRET="<same static-auth-secret as coturn>" \
TURN_TTL=3600 \
go run .
```

With no `TURN_URLS`/`TURN_SECRET` set, `/ice` returns STUN only (`STUN_URLS`,
default `stun:stun.l.google.com:19302`). WebRTC in production needs HTTPS/WSS.

## Development

```sh
deno task check                         # type-check the frontend
deno task test                          # frontend unit tests
cd src/backend && go test -race ./...   # signaling hub: join/leave/evict, races
cd src/backend && go vet ./... && gofmt -l .
```

`src/backend/dist/` is generated — never edit it. The frontend source is
`src/frontend/`.

The frontend is split so the parts worth testing can be: each module that holds
arithmetic or state is DOM-free and has a `_test.ts` beside it, with the DOM
half in a separate file (`commands.ts` / `paletteControls.ts`, `doc.ts` /
`docControls.ts`, `gamepad.ts` / `gamepadControls.ts`). `CLAUDE.md` documents
each module and, more usefully, the constraints that are invisible until you
break them.

Being green here is not the same as working: a handler test runs no JavaScript
and enforces no CSP. The two worst bugs in this codebase's WebRTC rework were
invisible to every automated check and obvious within a minute in a browser.

## Decisions still open

| Question                                                                | Where it stands                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything stronger than a room id + control key?                         | Fine for a trusted LAN or a private tunnel. Exposed publicly, this wants real accounts.                                                                                                                                                                 |
| Content is re-sent whole on every keystroke                             | Fine for a script; a very long document may want debouncing or diffing.                                                                                                                                                                                 |
| Viewer renders pushed content with `innerHTML`                          | Acceptable while only the control key holder can push. Revisit if rooms ever become semi-public.                                                                                                                                                        |
| CSP carries `'unsafe-inline'` for styles and allows the fontawesome CDN | Forced by the Web Awesome component library, which applies inline styles and fetches icon SVGs at runtime. Self-hosting the icons would let both be dropped.                                                                                            |
| Theme CSS is applied unsandboxed, and warnings are advisory             | The author is the operator, who already holds the control key, so this is their own foot. The one rule that breaks sync silently (`.pdf-page` height) is warned about but not blocked — worth revisiting if themes ever become shareable between users. |
| Clock state isn't restored on reconnect                                 | A viewer that reconnects gets content and settings back, but its countdown restarts. Needs a serialisable clock (start time + duration) rather than start/stop events.                                                                                  |
| The gamepad mapping is fixed                                            | Standard-mapping pads only, no remapping, no deadzone tuning, D-pad and right stick unused. Enough for one operator with one controller; a second pad shape is the thing that would force a settings dialog.                                            |

## TODO

- [x] Multiple layouts (Text & Clock, Big Clock, etc)
- [x] Layout selection interface
- [x] Prompter themes/layouts (CSS based)
- [x] Keyboard shortcuts and a command palette (Ctrl+K, with Ctrl+/ listing
      every binding)
- [x] Game controller (triggers for speed, stick to scroll, buttons for
      pause/sync)
- [ ] Server-side themes for signed-in users (today they are per-browser)
- [ ] Detect screen layout - display on second screen on full screen
- [ ] Keep clocks running when refreshing the viewer window
- [ ] Automatically invert dark text on paste
- [ ] Font colour control
- [ ] User accounts
- [ ] Export/import documents
- [ ] Gamepad remapping and deadzone tuning, if a second pad shape needs it

## Bugs

- [ ] `deno task check` reports one pre-existing type error (`clock.ts`
      `setInterval` returning `Timeout` rather than `number`)
- [x] "Scroll faster" (`Ctrl+↑`) nudged the speed slider toward _reverse_ — its
      label and its effect disagreed, and held long enough it ran the show
      backwards
- [x] A viewer held against either end of its script banked the scroll the
      viewport refused, up to a screen height, and never shed it — so it went on
      undoing any position sent to it, and "Send my position" silently did
      nothing

## Thoughts

### Rendering

Should I render the prompter in a canvas and then stream it to the prompter?
Might have to do this anyway for the BMD integration. #future
