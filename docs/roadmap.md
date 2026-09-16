# Roadmap

## Decisions still open

Each of these is a known limit rather than an oversight, recorded with where it
stands so the reasoning does not have to be reconstructed.

| Question                                                                              | Where it stands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything stronger than a room id + control key?                                       | Fine for a trusted LAN or a private tunnel. Exposed publicly, this wants real accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Content is re-sent whole on every keystroke                                           | Fine for a script; a very long document may want debouncing or diffing. Live editing can now hold edits back entirely, which takes the pressure off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Viewer renders pushed content with `innerHTML`                                        | Acceptable while only the control key holder can push. Revisit if rooms ever become semi-public.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CSP carries `'unsafe-inline'` for styles and allows the fontawesome CDN               | Forced by the Web Awesome component library, which applies inline styles and fetches icon SVGs at runtime. Self-hosting the icons would let both be dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Theme CSS is applied unsandboxed, and warnings are advisory                           | The author is the operator, who already holds the control key, so this is their own foot. The one rule that breaks sync silently (`.pdf-page` height) is warned about but not blocked — worth revisiting if themes ever become shareable between users.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pasted colours are corrected against pure black                                       | `brightenPastedText` decides whether a colour reads by its contrast with `--viewer-bg`'s default of black, because the transform runs in the editor at paste time — before any display has connected and before a theme that might set a light background exists. A theme with light ink would see pasted text brightened away from its own page. Unfixable at paste time by construction; a render-time filter in the viewer is the alternative, at the cost of not being what the operator sees while editing.                                                                                                                                                     |
| Displays of different shapes are kept in step by matching them, not by the sync maths | The synced scalar is a fraction of the _scrollable range_, so `setRatio` maps it to `r * (scrollHeight - clientHeight)` and the same `r` lands on a different line on a display of a different height. Measured on a 30,295px script: a 1080-tall and a 768-tall display sit 156px apart at `r` 0.5 and 297px — about six lines — at `r` 0.95, worst exactly where a service spends its time. Rather than change what the number means, secondary displays are made to match the primary, so one `r` is exact by construction. The general fix is written up below.                                                                                                  |
| A display that freezes looks exactly like one that is working                         | A display writes its WebRTC status to `data-rtcStatus` on `<html>` and nothing reads it — no CSS, no markup — so a link that dies mid-service leaves a stationary script on screen and the person reading it has no way to tell. The operator has the viewer row, which shows `failed`, and the count; the talent has nothing. Deliberately unsolved rather than overlooked: anything drawn on a display is aimed at the talent, and a warning they cannot act on is its own kind of harm — the same reasoning that removed the click-to-fullscreen prompt. The candidates are a mark only the operator's preview shows, or a corner indicator a theme can position. |
| The server can take up to a minute to notice a display has gone                       | Departure is detected by the signalling socket closing. A closed tab is immediate, but a display whose network vanishes — wifi off, device asleep — is only noticed when the WebSocket read deadline expires: `pongWait` is 60s in `signal.go`, pinged at 54s. Until then the operator's list shows it as present and connected. Lowering the deadline costs a ping every few seconds per display, which is cheap; it has not been done because nothing yet depends on the distinction.                                                                                                                                                                              |
| The controller reports a failed peer connection but does not act on it                | `#onViewerState` records the state and re-renders the row. Recovery now happens a layer below, in `makeLink`'s ICE restart, which is the right place — it is the side that owns negotiation. What the controller still does not do is _give up_: a display whose link never comes back stays in the list indefinitely, because the only removal path is the server's `peer-left`. That is deliberate while the restart is unbounded in count, but the two decisions are coupled and should move together.                                                                                                                                                            |
| The gamepad mapping is fixed                                                          | Standard-mapping pads only, no remapping, no deadzone tuning, D-pad and right stick unused. Enough for one operator with one controller; a second pad shape is the thing that would force a settings dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The end-of-document guard stops the pacer early                                       | It compares `innerHeight + scrollY` against `document.body.offsetHeight` while the scrollable range comes from `scrollHeight`, so a display parks tens of pixels short of its real end — and never auto-scrolls at all when the document is shorter than its viewport. Visible now that a scrub can put a display anywhere.                                                                                                                                                                                                                                                                                                                                          |

## Wanted next

- [ ] Server-side themes for signed-in users (today they are per-browser)
- [ ] Font colour control
- [ ] User accounts
- [ ] Export/import documents
- [ ] Gamepad remapping and deadzone tuning, if a second pad shape needs it
- [ ] Exact scroll sync across displays of genuinely different shapes, so each
      can use its whole screen rather than matching the primary — see below

## Syncing displays of genuinely different shapes

Deferred deliberately, and written down because the reasoning is not obvious and
was arrived at with measurements that would have to be taken again.

Today every display is made to match the primary — the one the preview is
attached to — so a single scroll ratio is exact by construction. That is the
right trade while a service runs one shape of screen, or a few screens that can
afford to letterbox. What it does not do is let a 16:9 TV and a portrait tablet
each use their whole screen _and_ stay on the same line.

**The error, exactly.** Both documents are `body` → sticky header (height `a`) →
`#main` (content height `C`), scrolled at `document.scrollingElement`, so
`scrollTop = r·(a + C − h)` and the content row at the top of the visible area
is `scrollTop` itself. Between two displays:

```
Δrow = r · ( Δa + ΔC − Δh )
```

Three terms, and they are not equally tractable:

- **`Δh`, the viewport height.** Ours, and avoidable. It is the whole of the
  measured 297px above.
- **`Δa`, the header height.** Ours too. It is `8vi`, so it differs whenever the
  widths differ.
- **`ΔC`, the content height.** _Not_ ours. Text reflows: a narrower display
  wraps more lines, so `C` genuinely differs and no single scalar can be exact.

**Step one, and probably enough: send a content fraction.**

```
f = (scrollTop − a) / C          scrollTop = a + f · C
```

Since `scrollTop − a` is the content row, `f` drops the `Δa` and `Δh` terms
entirely — the two we introduce. `a` and `C` must be _measured_ (`#main`'s
document offset and its `scrollHeight`), not assumed, which also degrades
correctly for a theme that has no header. PDF mode is the happy case: page boxes
are already sized proportionally to column width, so `C` scales and `f` is exact
there.

**It must be additive.** `{r, f?}` on the scroll message, receivers preferring
`f` and falling back to `r`. A display that has not reloaded is a display in
front of talent, and redefining `r` in place would desync it by up to a screen
height the moment the operator refreshes the control page.

Two costs to plan for. `f = 1` becomes per-viewer (`1 − (h−a)/C`), so "everyone
parked at the bottom" stops being one shared number and needs a clamp convention
— `scrollsync_test.ts`'s "the ends of the range are exactly 0 and 1" asserts the
assumption this breaks. And it adds a soft contract that a theme keeps the
script inside `#main`, which is weaker than today's implicit "every display is
the same shape" but is new and belongs in CLAUDE.md beside the `.pdf-page` rule.

**Step two, only if `ΔC` turns out to matter: sync a document position.** A
paragraph index plus an offset, with each display scrolling that node into view,
is the only thing that is exact across different widths. It is a much larger
change — each viewer needs a position-to-pixel mapping, and it has to coexist
with the pacer, which integrates pixels per second — so it is worth measuring
whether `f` alone is close enough before reaching for it.

## Done

Kept because several of these were listed as open questions long enough to be
worth marking closed.

- [x] Automatically brighten dark text on paste
- [x] Multiple layouts (Clocks & Text, Big Clocks)
- [x] Layout selection interface
- [x] Prompter themes/layouts, authored in CSS
- [x] Keyboard shortcuts and a command palette (Ctrl+K, with Ctrl+/ listing
      every binding)
- [x] Game controller — triggers for speed, stick to scroll, buttons for
      pause/sync
- [x] Detect screen layout, and open the display fullscreen on a second screen
- [x] Keep the clocks running when the viewer window refreshes — the countdown
      travels as state rather than as start/stop events, so it is replayed to a
      display that joins late and restored after either page reloads
- [x] Hold edits back from the displays and push them deliberately
- [x] Tell local screens from remote displays in the viewer count
- [x] Scroll the show by scrolling the preview

## Ideas

**Render the prompter to a canvas and stream it?** Might be necessary anyway for
a Blackmagic integration. Would trade the "sync state, not pixels" property the
whole design rests on — worth doing only if a hardware target forces it.
