# Documentation

| Doc                                | What is in it                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| [operating.md](operating.md)       | Running a service: the script, scrolling, screens, clocks, the controller      |
| [shortcuts.md](shortcuts.md)       | Every command, with its keys and pad button — generated from the command table |
| [themes.md](themes.md)             | Writing your own viewer layout in CSS                                          |
| [architecture.md](architecture.md) | How the pieces fit: signalling, peer topology, what crosses the wire           |
| [deploying.md](deploying.md)       | Docker, TLS, TURN, and why HTTPS is worth having                               |
| [development.md](development.md)   | Build, the gates, and how to check a change is real                            |
| [roadmap.md](roadmap.md)           | Open decisions, what is wanted next, ideas                                     |

Two files sit outside this directory on purpose:

- **[../README.md](../README.md)** is the front door — what this is and how to
  start it.
- **[../CLAUDE.md](../CLAUDE.md)** is written for whoever is _changing_ the
  code, human or agent. It is the long list of constraints that are invisible
  until you break one: why the speed slider is inverted, why a viewer must ask
  its viewport for nothing at all when stopped, why two split panels need their
  knobs set separately. It is deliberately not split up into this directory — it
  is loaded automatically at the start of a coding session, which these files
  are not, so a trap moved out of it is a trap nobody reads until afterwards.
