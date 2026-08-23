import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { serveStatic } from "@hono/hono/deno";
import { CandidateItem, Role, RoleState } from "./webrtc.ts";

const PORT = 9000;

// Session:
// One session = 1 offerer + one answerer. A plain object for a POC
interface Session {
  offerer: RoleState;
  answerer: RoleState;
}

function freshSession(): Session {
  return { offerer: new RoleState(), answerer: new RoleState() };
}

const session = freshSession();

const app = new Hono();
app.use("*", cors());

// --- SDP exchange ---

app.post("/offer", async (c) => {
  const { sdp } = await c.req.json();
  if (!sdp) return c.json({ error: "missing sdp" }, 400);

  console.log("[signal] offer stored");
  session.offerer.publishSdp(sdp);
  return c.json({ ok: true });
});

app.get("/offer", async (c) => {
  const sdp = await session.offerer.waitForSdp();
  if (sdp === null) return new Response(null, { status: 204 });
  return c.json({ sdp });
});

app.post("/answer", async (c) => {
  const { sdp } = await c.req.json();
  if (!sdp) return c.json({ error: "missing sdp" }, 400);

  console.log("[signal] answer stored");
  session.answerer.publishSdp(sdp);
  return c.json({ ok: true });
});

app.get("/answer", async (c) => {
  const sdp = await session.answerer.waitForSdp();
  if (sdp === null) return new Response(null, { status: 204 });

  return c.json({ sdp });
});

// --- Trickle ICE candidates ---

app.post("/candidates/:role", async (c) => {
  const role = c.req.param("role") as Role;
  const item: CandidateItem = await c.req.json();
  console.log(`[signal] ${role} candidate${item.done ? " (done)" : ""}`);
  session[role].pushCandidate(item);
  return c.json({ ok: true });
});

app.get("/candidates/:role", async (c) => {
  const role = c.req.param("role") as Role;
  const item = await session[role].waitForCandidate();
  if (item === null) return new Response(null, { status: 204 });

  return c.json(item);
});

// --- Reset ---

app.post("/reset", (c) => {
  session.offerer.reset();
  session.answerer.reset();
  console.log("[signal] session reset");
  return c.json({ ok: true });
});

app.use("/*", serveStatic({ root: "./" }));

console.log(`Signaling server listening on http://localhost:${PORT}`);
console.log(`Open two browser windows at http://localhost:${PORT}`);
Deno.serve({ port: PORT }, app.fetch);
