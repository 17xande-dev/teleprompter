# teleprompter

An open source teleprompter running in your browser. What a time to be alive.

A **control** page holds the script and the controls; one or more **viewer**
displays show it — a window on a second monitor, a tablet on the floor, a laptop
across the room. Scroll position, content, speed, text size, layout, messages
and clocks all stay in sync between them, peer-to-peer. The Go server only
introduces the peers; the script itself never goes through it.

The control page's own pane is deliberately _not_ scroll-synced. The operator
reads ahead of, or behind, the audience; the **Sync** buttons close that gap on
purpose, in either direction.

## Run

The frontend is TypeScript bundled by [Deno](https://deno.com) into
`src/backend/dist`; the Go server embeds that and serves it alongside the
signalling endpoint.

```sh
deno task build            # frontend -> src/backend/dist
cd src/backend && go run . # serve + signalling on :8080
```

Or, while developing, both together with live rebuilds:

```sh
deno task dev              # watch-bundle the frontend AND run the Go server
```

Open <http://localhost:8080>. The control page gives itself a room and shows a
viewer link — open that on any device on the network, or hit **Screen** for a
display on this machine.

With Docker:

```sh
docker compose up --build
```

## Docs

| Doc                                     | What is in it                                                             |
| --------------------------------------- | ------------------------------------------------------------------------- |
| [operating.md](docs/operating.md)       | Running a service: the script, scrolling, screens, clocks, the controller |
| [shortcuts.md](docs/shortcuts.md)       | Every command, with its keys and pad button                               |
| [themes.md](docs/themes.md)             | Writing your own viewer layout in CSS                                     |
| [architecture.md](docs/architecture.md) | How the pieces fit: signalling, peer topology, what crosses the wire      |
| [deploying.md](docs/deploying.md)       | Docker, TLS, TURN, and why HTTPS is worth having                          |
| [development.md](docs/development.md)   | Build, the gates, and how to check a change is real                       |
| [roadmap.md](docs/roadmap.md)           | Open decisions, what is wanted next, ideas                                |

If you are going to change the code, [CLAUDE.md](CLAUDE.md) is the one to read:
it is the long list of constraints that produce no error when you break them.

## Licence

[MIT](LICENSE).
