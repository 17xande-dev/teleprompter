# Operating it

The control page holds the script and the controls; one or more **viewer**
displays show it. Every binding named here is in [shortcuts.md](shortcuts.md),
and **Ctrl+/** lists them without leaving the page.

## Screens

The room comes with a viewer link — `/viewer?room=…`, shown in the **Viewers**
card with a QR code beside it. The control page itself is `/control`, and `/`
redirects there. Open the viewer link on anything on the same network — a tablet
on the floor, a laptop across the room, a phone — and it joins as a display.

**Screen** in the app bar opens one on _this_ machine and closes it again; it
lights up while that window is open. On a multi-monitor setup with the browser's
window-management permission granted, Chrome places it fullscreen on the second
display. Everywhere else it fills the screen it lands on, leaving only a thin
URL strip, and a click on it goes to true fullscreen. Double-click toggles
fullscreen at any time.

The viewer count reads **"2 local · 1 remote"** rather than a bare total,
because those are very different situations to be in ten seconds before a
service: three windows stacked on your laptop and three people watching on three
devices both read as "3". A display works out which it is by itself, and "local"
means the same browser on this machine.

> If you reach the app by LAN address over plain `http://`, everything works,
> but see [deploying.md](deploying.md#https) — a couple of browser features are
> only available on a secure origin, and it is worth putting TLS in front of it
> if this is more than a one-off.

## The script

Type into the editor and every display updates as you go. Documents live in the
control page's browser storage — the **Documents** dropdown switches, renames
and deletes them, and whatever you were typing survives a refresh (writes are
coalesced to one every 500ms, and flushed when the page is hidden).

### Holding an edit back

**Live editing** in the **Sync** card is on by default: what you type goes
straight to the displays. Turn it off and your edits are held — open another
document, fix a typo three pages ahead, paste in a late change, none of it
appears in front of the talent. **Send my script** then shows them what you
have.

While it is off, an amber pause icon sits in the app bar. That is deliberate:
the setting is remembered between sessions, so without it a reload could come
back quietly not-live and you would type into a screen showing something else.

Turning live editing back on publishes immediately — "go live" means the
displays show what you are looking at.

### Your own reading size

The **A** button in the editor's toolbar opens a slider for the size of the
script _in front of you_. It is yours alone — it never reaches a display, so it
is safe to nudge mid-service — and it is remembered for this browser.
`Ctrl+Alt+]` and `Ctrl+Alt+[` do the same from the keyboard, and **Match
viewers' size** in the Sync card sets it to read like the displays do.

The viewers' size is the separate **Text Scale** slider in the Transport card.

### PDFs

Drop a PDF on the editor. It takes over the pane for the session, renders as a
plain column of pages, and travels to the displays over its own data channel.
Text Scale becomes a zoom where 1.0 is fit-to-width, which is where a freshly
opened PDF lands. **Close PDF** returns to the script.

A PDF is held in memory only — deliberately never written to browser storage,
whose quota it would blow through, taking the text documents with it. It is
re-sent to a display that joins or reloads.

## Scrolling

**Scroll Speed** is a two-way slider: down is forward, matching the direction
the text travels, and up is reverse. **Space** starts and stops the scroll
without forgetting the speed, which is a different thing from setting the speed
to zero — zero leaves the pacer running for a cue you are about to jump to.

Exactly one display paces the scroll. **Allow drive** picks which; without a
pick it is the first to connect. Only that display can also be scrolled by hand,
and only it integrates the speed — two displays each running their own clock
drift apart within a minute with nothing to pull them back.

### Closing the gap

Your pane is deliberately **not** scroll-synced. You read ahead of, or behind,
the audience; the **Sync** buttons close that gap on purpose, in either
direction:

- **Go to viewers** pulls your pane to where they are.
- **Send my position** pushes them to where you are. Audience-visible.
- **Match viewers' size** / **Send my size** do the same for text size, so both
  ends put the same words on each line and the position buttons land somewhere
  recognisable.

### Scrubbing from the preview

Turn on **Scroll the show from the preview** in Settings and a wheel or drag
over the preview moves every display — the fastest way to put the talent on a
particular line. It behaves like scrolling the driving display by hand: it
displaces the position, and when you let go the scroll carries on from there at
the set speed.

It is off by default and marked in amber while armed, on the preview itself and
in the app bar, because the preview sits under your pointer: armed, a wheel that
drifts over it while you were reaching for a slider jogs every display.

## The preview

The preview has its own pane at the top of the sidebar, so it cannot scroll out
of sight, and the divider under it sets its height. It is a true miniature —
rendered at the previewed display's real pixel size and scaled down, so text
wraps exactly as it does there.

Which display it mirrors is a separate choice from which one drives, because
they need not be the same shape or the same device. Growing the pane past the
point where its height is the limit letterboxes rather than enlarging: the
aspect ratio stays the previewed display's.

**Viewer Layout** beside it switches every display's layout at once — see
[themes.md](themes.md).

## Messages and clocks

A message overlays every display at whatever size fits its box — for "wrap up"
or "mic 2 is off". **Enter** in the box sends it, so does Ctrl+Enter from
anywhere else on the page.

The countdown and the wall clock are part of the viewer layout. Set the
countdown with the three fields, then Reset / Start / Stop. What travels is the
countdown's whole state rather than a start signal, which is what makes it
survive: a display that reloads mid-service comes back where the countdown
actually is, your own copy and every display agree to the same second, and
refreshing the control page resumes rather than restarting. **Reset** returns to
the length you dialled in, not to wherever the countdown had got to.

## Game controller

Plug in a controller and a pad icon appears in the app bar. Chrome only admits a
pad exists once a button is pressed, so give it one.

| Control          | Does                                                     |
| ---------------- | -------------------------------------------------------- |
| **R2**           | scroll forward, 0 → full speed, proportional to pressure |
| **L2**           | the same, in reverse                                     |
| **Left stick ↕** | scroll your own pane — find a place in the script        |
| **Cross**        | pause / resume, speed remembered                         |
| **R1**           | send my position to the displays                         |
| **L1**           | go to the displays' position                             |

The throttles are absolute, not incremental: the slider follows your finger and
letting go stops. Squeeze both and they cancel. Pausing with Cross leaves the
speed where it was, so resuming picks up where you left off — and a pad you are
not touching never writes the slider, so the wheel and the arrow keys keep
working with one plugged in.

Buttons are read as commands, so a pad press, a palette row and a shortcut are
the same action. Button numbering comes from the Gamepad API's `"standard"`
mapping; a controller the browser cannot fit to that mapping is ignored rather
than guessed at.

## Settings

Per-browser preferences, in the gear:

- **Reverse slider scrolling** — whether a wheel over a slider moves the thumb
  the other way. Which physical direction a scroll reports is decided by your
  pointing device and the OS's "natural scrolling", neither of which the page
  can see, so this is a switch rather than something someone had to guess.
- **Scroll the show from the preview** — described above.

**Live editing** is remembered the same way but its switch is in the Sync card,
where the other "what do the displays have" actions are.
