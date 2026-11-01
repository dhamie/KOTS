// Live connections under load (Phase 10a): SOCKETS sockets (two per seeded player, like two open tabs) stay open
// for DURATION seconds while one probe player posts to the public channel every 5 s; every socket should receive
// each probe. Reports connections, drops and delivery latency to RESULTS. Run by load/run.sh on the host.
import { readFileSync, writeFileSync } from "node:fs";
import { io } from "socket.io-client";

const BASE = process.env.API_URL;
const ORIGIN = process.env.ORIGIN;
const players = JSON.parse(readFileSync(process.env.SESSIONS, "utf8"));
const SOCKETS = Number(process.env.SOCKETS ?? 1000);
const DURATION = Number(process.env.DURATION ?? 60) * 1000;

const latencies = [];
const stats = { opened: 0, failed: 0, dropped: 0, probes: 0, expected: 0, delivered: 0 };
const sent = new Map(); // probe body → sent at

const sockets = [];
for (let i = 0; i < SOCKETS; i++) {
  const p = players[i % players.length];
  const s = io(BASE, { path: "/api/socket.io", transports: ["websocket"], extraHeaders: { cookie: p.cookie, origin: ORIGIN } });
  s.on("connect", () => stats.opened++);
  s.on("connect_error", () => stats.failed++);
  s.on("disconnect", () => stats.dropped++);
  s.on("event", (e) => {
    if (e.type !== "chat.message") return;
    const at = sent.get(e.message.body);
    if (at !== undefined) {
      stats.delivered++;
      latencies.push(Date.now() - at);
    }
  });
  sockets.push(s);
  // Open them over a few seconds rather than in one burst.
  if (i % 50 === 49) await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 3_000));
const connected = () => sockets.filter((s) => s.connected).length;
const openAtStart = connected();

const probe = players[0];
const headers = { cookie: probe.cookie, origin: ORIGIN, "content-type": "application/json" };
const channels = await (await fetch(`${BASE}/api/chat/channels`, { headers })).json();
const lagos = channels.find((c) => c.kind === "public");
const end = Date.now() + DURATION;
while (Date.now() < end) {
  const body = `probe ${Date.now()}`;
  stats.expected += connected();
  sent.set(body, Date.now());
  const r = await fetch(`${BASE}/api/chat/channels/${lagos.id}/messages`, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (r.ok) stats.probes++;
  else stats.expected -= connected();
  await new Promise((res) => setTimeout(res, 5_000));
}
await new Promise((r) => setTimeout(r, 3_000));

latencies.sort((a, b) => a - b);
const q = (f) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(f * latencies.length))] : null);
const summary = { sockets: SOCKETS, openAtStart, openAtEnd: connected(), ...stats, latencyMs: { med: q(0.5), p95: q(0.95), p99: q(0.99), max: latencies.at(-1) ?? null } };
writeFileSync(process.env.RESULTS, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
for (const s of sockets) s.close();
process.exit(0);
