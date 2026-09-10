# Deploying

## Docker

The image is a three-stage build: Deno bundles the frontend, Go compiles the
server with that bundle embedded, and the result is copied into Alpine.

```sh
docker compose up --build
```

`go:embed` reads `src/backend/dist` at **compile** time, which is why the
frontend stage has to run first — see [development.md](development.md) for the
same trap when building by hand.

Environment, all optional:

| Variable      | Default                        | What it does                               |
| ------------- | ------------------------------ | ------------------------------------------ |
| `STUN_URLS`   | `stun:stun.l.google.com:19302` | comma-separated STUN servers               |
| `TURN_URLS`   | —                              | comma-separated TURN servers; enables TURN |
| `TURN_SECRET` | —                              | coturn's `static-auth-secret`              |
| `TURN_TTL`    | `3600`                         | lifetime of an issued credential, seconds  |

The server also takes `-addr` to move off `:8080` and `-dev` to read `dist/`
from disk instead of the embedded copy.

## HTTPS

**Put TLS in front of this.** Two reasons, and the second is not obvious:

WebRTC in production needs HTTPS/WSS. And a handful of browser APIs are
restricted to a _secure origin_, which `http://` to anything but `localhost` is
not. The app is built to survive that — it mints its ids without
`crypto.randomUUID`, warns instead of throwing when the clipboard is missing,
and WebRTC data channels themselves need no secure context — so reaching it by
LAN address works. But it is one class of failure you simply do not have with
TLS, and the failure it used to produce was a page that looked like it was still
connecting.

If you serve it over plain HTTP on a LAN, that is a legitimate setup; just know
that "copy viewer link" falls back to logging the URL rather than reaching the
clipboard.

## Behind Cloudflare, via Coolify

This is what the project is actually deployed on, recorded because the
alternatives were considered and rejected for reasons that still hold:
Dockerised under **Coolify** on an Oracle Cloud always-free VM, with
**Cloudflare** in front for TLS and asset caching. Coolify's git-push webhook
gives CD from `main`.

Two things to get right:

- **WebSocket signalling passes through Cloudflare's proxy fine** on the free
  plan. It needs no special treatment.
- **Cache rules should target the hashed `dist/` assets only, never `/ws`.** The
  bundle's filenames are content-hashed, so they are safe to cache hard; the
  signalling socket obviously is not.

Render was rejected because its free tier sleeps after ~15 minutes, and a 30s
cold start on the first signalling connection is bad for a click-to-start-a-room
tool. Running Coolify on a machine at home was rejected because GitHub's webhook
has to reach the CD control plane, which would mean port-forwarding or a tunnel
into home NAT to solve what the Oracle box's public IP already solves.

## TURN (NAT/firewall fallback)

STUN gets peers connected in most co-located cases. TURN is the fallback for
networks that block direct peer traffic — guest wifi, client isolation.

The client fetches ICE config from `GET /ice` at connect time, so credentials
are never hardcoded in the frontend. The server issues short-lived HMAC
credentials following coturn's `use-auth-secret` scheme:

```sh
TURN_URLS="turn:turn.example.com:3478" \
TURN_SECRET="<same static-auth-secret as coturn>" \
TURN_TTL=3600 \
go run .
```

With no `TURN_URLS`/`TURN_SECRET` set, `/ice` returns STUN only.

## Who can control a room

A room id alone does not grant control — the control key does, and it never
appears in a viewer link. See
[architecture.md](architecture.md#rooms-links-and-control). That is enough for a
trusted LAN or a private tunnel; exposed publicly, this wants real accounts,
which it does not have yet ([roadmap.md](roadmap.md)).
