// k6 load test (Phase 10a): seeded players browsing and playing at three load levels in turn.
// Run through load/run.sh, which seeds the players and passes BASE_URL, ORIGIN and the sessions file.
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { SharedArray } from "k6/data";

const BASE = `${__ENV.BASE_URL}/api`;
const ORIGIN = __ENV.ORIGIN;
const players = new SharedArray("players", () => JSON.parse(open(__ENV.SESSIONS)));
const DISTRICTS = ["yaba-ebute-metta", "lagos-island", "apapa"];
const MARKETS = ["balogun", "apapa-wharf", "tejuosho"];
const ROUTES = [
  "GET /me",
  "GET /map/districts",
  "GET /map/territories",
  "GET /events",
  "GET /notifications",
  "GET /families/:id",
  "GET /families/:id/treasury",
  "GET /families/:id/activity",
  "GET /families/:id/territories",
  "GET /families/:id/henchmen",
  "GET /families/:id/inventory",
  "GET /markets/:slug",
  "POST /markets/:slug/orders",
  "GET /chat/channels",
  "GET /chat/channels/:id/messages",
  "POST /chat/channels/:id/messages",
  "GET /families/:id/trades",
  "GET /families/:id/battles",
];
const LEVELS = [
  { name: "p100", vus: 100, start: "0s", duration: "3m" },
  { name: "p250", vus: 250, start: "3m15s", duration: "3m" },
  { name: "p500", vus: 500, start: "6m30s", duration: "4m" },
];

export const options = {
  scenarios: Object.fromEntries(
    LEVELS.map((l) => [l.name, { executor: "constant-vus", vus: l.vus, startTime: l.start, duration: l.duration, gracefulStop: "15s", exec: "player" }]),
  ),
  // Not pass/fail gates: they make k6 report each level, and each route at each level, separately.
  thresholds: Object.fromEntries([
    ...LEVELS.flatMap((l) => [
      [`http_req_duration{scenario:${l.name}}`, ["p(95)<60000"]],
      [`http_req_failed{scenario:${l.name}}`, ["rate<1"]],
      [`iteration_duration{scenario:${l.name}}`, ["p(95)<600000"]],
      ...ROUTES.map((r) => [`http_req_duration{scenario:${l.name},name:${r}}`, ["p(95)<60000"]]),
    ]),
  ]),
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const key = () => `load-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Math.random().toString(36).slice(2, 10)}`;

/** One page view: the requests a browser makes at once, tagged by route so the summary splits them. */
function page(p, reqs) {
  const res = http.batch(
    reqs.map(([path, name]) => ({ method: "GET", url: `${BASE}${path}`, params: { headers: { cookie: p.cookie }, tags: { name } } })),
  );
  check(res, { "page ok": (all) => all.every((r) => r.status === 200 || r.status === 304) });
  return res;
}
function post(p, path, name, body, headers = {}) {
  const r = http.post(`${BASE}${path}`, JSON.stringify(body), {
    headers: { cookie: p.cookie, origin: ORIGIN, "content-type": "application/json", ...headers },
    tags: { name },
  });
  check(r, { [`${name} ok`]: (x) => x.status >= 200 && x.status < 300 });
  return r;
}

/**
 * A player's visit: a mix weighted toward reading, as the game is played. Dons also act (market orders, chat);
 * associates only read, since most actions need a higher role. Think time between visits: 3–8 s.
 */
export function player() {
  const p = players[(exec.vu.idInTest - 1) % players.length];
  const f = p.familyId;
  const roll = Math.random();
  if (roll < 0.35) {
    const d = pick(DISTRICTS);
    page(p, [["/me", "GET /me"], ["/map/districts", "GET /map/districts"], [`/map/territories?district=${d}`, "GET /map/territories"], ["/events", "GET /events"], ["/notifications", "GET /notifications"]]);
  } else if (roll < 0.6) {
    page(p, [
      [`/families/${f}`, "GET /families/:id"],
      [`/families/${f}/treasury`, "GET /families/:id/treasury"],
      [`/families/${f}/activity?limit=20`, "GET /families/:id/activity"],
      [`/families/${f}/territories`, "GET /families/:id/territories"],
      [`/families/${f}/henchmen`, "GET /families/:id/henchmen"],
      [`/families/${f}/inventory`, "GET /families/:id/inventory"],
    ]);
  } else if (roll < 0.75) {
    const m = pick(MARKETS);
    page(p, [[`/markets/${m}`, "GET /markets/:slug"], [`/families/${f}/inventory`, "GET /families/:id/inventory"]]);
    if (p.role === "don") {
      // Buy one and sell it back: realistic writes that leave storage and money roughly level.
      post(p, `/markets/${m}/orders`, "POST /markets/:slug/orders", { side: "buy", good: "fuel", quantity: 1, limitTotal: 1_000_000 }, { "idempotency-key": key() });
      post(p, `/markets/${m}/orders`, "POST /markets/:slug/orders", { side: "sell", good: "fuel", quantity: 1, limitTotal: 1 }, { "idempotency-key": key() });
    }
  } else if (roll < 0.9) {
    const [channels] = page(p, [["/chat/channels", "GET /chat/channels"]]);
    const family = channels.status === 200 ? channels.json().find((c) => c.kind === "family") : null;
    if (family) {
      page(p, [[`/chat/channels/${family.id}/messages`, "GET /chat/channels/:id/messages"]]);
      if (Math.random() < 0.3) post(p, `/chat/channels/${family.id}/messages`, "POST /chat/channels/:id/messages", { body: `load ${Date.now()}` });
    }
  } else {
    page(p, [
      [`/families/${f}/trades?box=incoming`, "GET /families/:id/trades"],
      [`/families/${f}/trades?box=outgoing`, "GET /families/:id/trades"],
      [`/families/${f}/battles`, "GET /families/:id/battles"],
    ]);
  }
  sleep(3 + Math.random() * 5);
}

export function handleSummary(data) {
  return { "/results/k6-summary.json": JSON.stringify(data, null, 1), stdout: "" };
}
