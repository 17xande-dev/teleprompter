# Development

```sh
deno task dev            # watch-bundle the frontend AND run the Go server
```

That is the whole loop. `deno task dev` passes `-dev` to the server, which then
reads `dist/` from disk, so a frontend change needs no Go rebuild — a browser
refresh is all of it, and connected displays survive. The Go side runs under
air, so a `.go` change rebuilds and restarts on its own in about half a second.

Building by hand:

```sh
deno task build              # frontend -> src/backend/dist
cd src/backend && go run .   # serve + signalling on :8080
```

**`src/backend/dist/` is generated — never edit it.** `go:embed` bakes it into
the binary at _compile_ time, which is why the server takes `-dev` to read it
from disk instead. Without that flag a rebundle stays invisible until the Go
process restarts, and that has cost real debugging time: if a change is not
showing up in the browser, check whether the server is embedding a stale copy.

## The gates

```sh
deno task check                         # type-check the frontend
deno lint src/frontend/scripts
deno task test                          # frontend unit tests
deno fmt
cd src/backend && go test -race ./...   # signalling hub: join/leave/evict, races
cd src/backend && go vet ./... && gofmt -l .
```

**All of them are clean, and any output is yours.** They were not for a long
time, and this repo used to carry a list of which failures to ignore — which is
worth not going back to, because a gate with expected failures in it cannot be
read at a glance and a real failure hides among them.

Worth knowing about two of them:

- `deno task test` runs with `--no-check`: its type-check pass pulls in the
  whole project graph including raw CSS imports that only the bundler can
  resolve. Types are covered by `deno task check` instead.
- It also runs with `--allow-read=.`, because one test reads a generated doc off
  disk to check it is not stale. See below.

## Generated docs

[shortcuts.md](shortcuts.md) is generated from the real command table:

```sh
deno task docs
```

You do not have to remember to run it — `docs_test.ts` regenerates and compares,
so a stale file fails the gate. That table already feeds the palette, the in-app
cheatsheet and the key bindings, and a hand-kept copy in the docs would be the
only one nothing checks. It was already wrong before it was generated: the old
hand-written table had "scroll faster" on `Ctrl+Up` when the binding is
`Ctrl+Down`.

If you add or change a command, run the task and commit the result with it.

## Being green is not the same as working

A handler test runs no JavaScript and enforces no CSP. The two worst bugs in
this codebase's WebRTC rework were invisible to every automated check and
obvious within a minute in a browser — a missing `from` stamp on relayed
signalling, and messages dropped because a data channel is not open when it is
created.

So: **verify UI changes in a real browser.** Assert computed styles rather than
DOM structure where a stylesheet could have gone missing, compare positions
numerically rather than by eye, and look at a screenshot.

And a guard test is worth nothing until it has been watched failing with the
guard removed. Several of the tests here exist because a specific bug was
reproduced first; breaking the fix and watching the test go red is how you know
the test is about the bug and not about the code's current shape.

## Shape of the frontend

Each module holding arithmetic or state is DOM-free and has a `_test.ts` beside
it, with the DOM half in a separate file:

| DOM-free                                                     | DOM half                             |
| ------------------------------------------------------------ | ------------------------------------ |
| `commands.ts`                                                | `paletteControls.ts`                 |
| `doc.ts`, `themes.ts`                                        | `docControls.ts`, `themeControls.ts` |
| `gamepad.ts`                                                 | `gamepadControls.ts`                 |
| `settings.ts`                                                | `settingsControls.ts`                |
| `timer.ts`                                                   | `clock.ts`                           |
| `scrollsync.ts`, `textscale.ts`, `ids.ts`, `filetransfer.ts` | —                                    |

That split is not tidiness. `clock.ts` imports Web Awesome components, which
`deno test` cannot resolve, so anything left in there is untestable by
construction — which is why the countdown had no tests at all until its
arithmetic moved to `timer.ts`.

## Before you change anything

Read [../CLAUDE.md](../CLAUDE.md). It is long and it is the useful document: the
trade-offs, the rejected alternatives, and the constraints that produce no error
when you break them. A representative sample — the speed slider is inverted on
purpose and "faster" steps _down_; a stopped display must ask its viewport for
nothing at all; the two split panels need their knobs set separately because
those are inherited custom properties; an editor mounted inside a Web Awesome
slot silently loses its own stylesheet.

[architecture.md](architecture.md) is the shorter, structural view of the same
system.
