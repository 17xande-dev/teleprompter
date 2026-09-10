# Roadmap

## Decisions still open

Each of these is a known limit rather than an oversight, recorded with where it
stands so the reasoning does not have to be reconstructed.

| Question                                                                | Where it stands                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything stronger than a room id + control key?                         | Fine for a trusted LAN or a private tunnel. Exposed publicly, this wants real accounts.                                                                                                                                                                                                                                     |
| Content is re-sent whole on every keystroke                             | Fine for a script; a very long document may want debouncing or diffing. Live editing can now hold edits back entirely, which takes the pressure off.                                                                                                                                                                        |
| Viewer renders pushed content with `innerHTML`                          | Acceptable while only the control key holder can push. Revisit if rooms ever become semi-public.                                                                                                                                                                                                                            |
| CSP carries `'unsafe-inline'` for styles and allows the fontawesome CDN | Forced by the Web Awesome component library, which applies inline styles and fetches icon SVGs at runtime. Self-hosting the icons would let both be dropped.                                                                                                                                                                |
| Theme CSS is applied unsandboxed, and warnings are advisory             | The author is the operator, who already holds the control key, so this is their own foot. The one rule that breaks sync silently (`.pdf-page` height) is warned about but not blocked — worth revisiting if themes ever become shareable between users.                                                                     |
| The gamepad mapping is fixed                                            | Standard-mapping pads only, no remapping, no deadzone tuning, D-pad and right stick unused. Enough for one operator with one controller; a second pad shape is the thing that would force a settings dialog.                                                                                                                |
| The end-of-document guard stops the pacer early                         | It compares `innerHeight + scrollY` against `document.body.offsetHeight` while the scrollable range comes from `scrollHeight`, so a display parks tens of pixels short of its real end — and never auto-scrolls at all when the document is shorter than its viewport. Visible now that a scrub can put a display anywhere. |

## Wanted next

- [ ] Server-side themes for signed-in users (today they are per-browser)
- [ ] Automatically invert dark text on paste
- [ ] Font colour control
- [ ] User accounts
- [ ] Export/import documents
- [ ] Gamepad remapping and deadzone tuning, if a second pad shape needs it

## Done

Kept because several of these were listed as open questions long enough to be
worth marking closed.

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
