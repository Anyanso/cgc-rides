import test from "node:test";
import assert from "node:assert/strict";
import { buildTravel, clearRoutingCache } from "../js/routing.js";
import { geocode } from "../js/geo.js";

// These tests use a fake fetch. They check how requests are built and answers are read.
// They do NOT prove the real OSRM / Nominatim servers behave this way.

const pts = [
  { id: "a", lat: 52.1, lng: -106.6 },
  { id: "b", lat: 52.12, lng: -106.65 },
  { id: "c", lat: 52.14, lng: -106.7 },
  { id: "d", lat: 52.16, lng: -106.72 },
];

function fakeOsrm(calls) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const coords = decodeURIComponent(u.pathname.split("/driving/")[1]).split(";");
    const src = u.searchParams.get("sources").split(";").map(Number);
    const dst = u.searchParams.get("destinations").split(";").map(Number);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: "Ok",
        durations: src.map((s) => dst.map((d) => (s === d && coords[s] === coords[d] ? 0 : 600))), // 10 minutes
      }),
    };
  };
}

test("builds a table request in lon,lat order and reads minutes back", async () => {
  clearRoutingCache();
  const calls = [];
  const t = await buildTravel(pts, { fetchFn: fakeOsrm(calls), chunk: 100, delayMs: 0 });
  assert.equal(t.source, "osrm");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/table\/v1\/driving\/-106\.600000,52\.100000;/);
  assert.equal(t.travel(pts[0], pts[1]), 10);
  assert.equal(t.travel(pts[0], pts[0]), 0);
});

test("splits big sets into chunks and still answers every pair", async () => {
  clearRoutingCache();
  const calls = [];
  const t = await buildTravel(pts, { fetchFn: fakeOsrm(calls), chunk: 2, delayMs: 0 });
  assert.equal(t.source, "osrm");
  assert.equal(calls.length, 4); // 2x2 blocks
  for (const a of pts) for (const b of pts) if (a !== b) assert.equal(t.travel(a, b), 10);
});

test("falls back to straight-line estimates, with a note, if the service refuses", async () => {
  clearRoutingCache();
  const t = await buildTravel(pts, { fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }), delayMs: 0 });
  assert.equal(t.source, "estimate");
  assert.match(t.note, /403/);
  assert.ok(t.travel(pts[0], pts[3]) > 0);
});

test("falls back when the network call throws", async () => {
  clearRoutingCache();
  const t = await buildTravel(pts, { fetchFn: async () => { throw new Error("offline"); }, delayMs: 0 });
  assert.equal(t.source, "estimate");
  assert.match(t.note, /offline/);
});

test("geocode reads Nominatim, then falls back to the neighbourhood, then to nothing", async () => {
  const hit = await geocode("123 Main St", {
    fetchFn: async (url) => {
      assert.match(url, /q=123\+Main\+St%2C\+Saskatoon/);
      return { ok: true, json: async () => [{ lat: "52.1", lon: "-106.6" }] };
    },
  });
  assert.deepEqual(hit, { lat: 52.1, lng: -106.6, source: "address" });

  const fb = await geocode("nowhere", { neighbourhood: "Evergreen", fetchFn: async () => ({ ok: false }) });
  assert.equal(fb.source, "neighbourhood");
  assert.ok(fb.lat > 52);

  const none = await geocode("nowhere", { neighbourhood: "Avalon", fetchFn: async () => { throw new Error("x"); } });
  assert.equal(none.source, "none");
});
