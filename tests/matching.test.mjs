import test from "node:test";
import assert from "node:assert/strict";
import { plan, evaluate, driverIssue, pointsFor, readyByFor } from "../js/matching.js";
import { estimateMinutes } from "../js/geo.js";

// Test-only geography (straight-line travel times). Not real church data.
const church = { lat: 52.1332, lng: -106.67 };
const DATE = "2026-10-25";
const travel = (a, b) => (a.id === b.id ? 0 : estimateMinutes(a, b));

const driver = (id, lat, lng, extra = {}) => ({
  id, name: `Driver ${id}`, gender: "M", lat, lng, seats: 3, secondTrip: false,
  status: "cleared", licenceOk: true, insuranceOk: true, policeCheckExpiry: "2027-06-01", available: true, ...extra,
});
const rider = (id, lat, lng, extra = {}) => ({ id, name: `Rider ${id}`, gender: "F", lat, lng, ...extra });
const run = (drivers, riders, options) => plan({ church, drivers, riders, travel, date: DATE, options });
const driverOf = (p, riderId) => p.assignments.find((a) => a.riderId === riderId)?.driverId;

test("rider goes to the driver whose route passes them", () => {
  const south = driver("south", 52.0872, -106.6244);
  const northwest = driver("nw", 52.16, -106.72);
  const p = run([south, northwest], [rider("r1", 52.0989, -106.628), rider("r2", 52.15, -106.71)]);
  assert.equal(driverOf(p, "r1"), "south");
  assert.equal(driverOf(p, "r2"), "nw");
  assert.equal(p.waitlist.length, 0);
});

test("only cleared, available drivers with a current check get riders", () => {
  const ok = driver("ok", 52.1, -106.63);
  const bad = [
    driver("pending", 52.1332, -106.671, { status: "pending" }),
    driver("suspended", 52.1332, -106.671, { status: "suspended" }),
    driver("expired", 52.1332, -106.671, { policeCheckExpiry: "2026-10-01" }),
    driver("off", 52.1332, -106.671, { available: false }),
    driver("nolic", 52.1332, -106.671, { licenceOk: false }),
  ];
  const p = run([...bad, ok], [rider("r1", 52.1332, -106.672)]);
  assert.equal(driverOf(p, "r1"), "ok");
  assert.equal(p.excludedDrivers.length, 5);
  assert.match(driverIssue(bad[2], DATE), /expired/);
});

test("under-18 rider is only placed with a driver whose check is current", () => {
  const expired = driver("expired", 52.1332, -106.671, { policeCheckExpiry: "2026-10-01" });
  const good = driver("good", 52.05, -106.6);
  const minor = rider("kid", 52.1331, -106.6705, { minor: true });
  const p = run([expired, good], [minor]);
  assert.equal(driverOf(p, "kid"), "good");
  // Forcing the expired driver by hand is allowed but flagged.
  const ev = evaluate({ church, drivers: [expired, good], riders: [minor], travel, date: DATE,
    assignments: [{ riderId: "kid", driverId: "expired", trip: 1 }] });
  assert.ok(ev.warnings.some((w) => w.code === "minor_check"));
});

test("a same-gender request is honoured even when a closer driver doesn't match", () => {
  const closeMan = driver("man", 52.1335, -106.6702, { gender: "M" });
  const farWoman = driver("woman", 52.1, -106.63, { gender: "F" });
  const p = run([closeMan, farWoman], [rider("r1", 52.1334, -106.6701, { prefersSameGender: true })]);
  assert.equal(driverOf(p, "r1"), "woman");
});

test("same-gender request with no matching driver is waitlisted with a reason", () => {
  const p = run([driver("man", 52.1, -106.63, { gender: "M" })], [rider("r1", 52.1, -106.63, { prefersSameGender: true })]);
  assert.equal(p.assignments.length, 0);
  assert.match(p.waitlist[0].reason, /same-gender/);
});

test("priority riders are seated first when seats are short", () => {
  const d = driver("d", 52.09, -106.62, { seats: 1 });
  const near = rider("near", 52.09, -106.62);
  const priority = rider("prio", 52.1, -106.64, { priority: true });
  const p = run([d], [near, priority]);
  assert.equal(driverOf(p, "prio"), "d");
  assert.equal(p.waitlist.length, 1);
  assert.equal(p.waitlist[0].riderId, "near");
  assert.match(p.waitlist[0].reason, /seats are taken/);
});

test("overload uses a second trip, then a waitlist with reasons", () => {
  const d = driver("d", 52.09, -106.62, { seats: 2, secondTrip: true });
  const riders = ["a", "b", "c", "d", "e"].map((id, i) => rider(id, 52.095 + i * 0.002, -106.625));
  const p = run([d], riders);
  assert.equal(p.assignments.filter((a) => a.trip === 1).length, 2);
  assert.equal(p.assignments.filter((a) => a.trip === 2).length, 2);
  assert.equal(p.waitlist.length, 1);
  assert.match(p.waitlist[0].reason, /All seats are taken/);
  // Everyone arrives by 11:30 (service 11:45 minus 15), the first trip earlier.
  for (const t of p.trips) assert.ok(t.arriveMin <= 11 * 60 + 30);
  const t1 = p.trips.find((t) => t.trip === 1);
  const t2 = p.trips.find((t) => t.trip === 2);
  assert.ok(t1.arriveMin < t2.arriveMin);
});

test("pickup times increase along each route and 'ready by' is the pickup minus a 5-minute buffer", () => {
  const d = driver("d", 52.08, -106.6, { seats: 4 });
  const riders = [0, 1, 2].map((i) => rider(`r${i}`, 52.09 + i * 0.01, -106.61 - i * 0.005));
  const p = run([d], riders);
  const stops = p.trips[0].stops;
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i].pickupMin >= stops[i - 1].pickupMin);
  for (const s of stops) {
    assert.ok(s.readyByMin <= s.pickupMin - 5);
    assert.ok(s.readyByMin > s.pickupMin - 15);
  }
  assert.equal(readyByFor(11 * 60 + 20), 11 * 60 + 15);
  assert.equal(readyByFor(10 * 60 + 20), 10 * 60 + 15);
  // An optional fixed ceiling still works.
  assert.equal(readyByFor(11 * 60 + 20, { readyBy: "10:45" }), 10 * 60 + 45);
});

test("a rider whose address couldn't be located is waitlisted, not guessed", () => {
  const p = run([driver("d", 52.1, -106.63)], [rider("lost", null, null)]);
  assert.equal(p.assignments.length, 0);
  assert.match(p.waitlist[0].reason, /locate/);
});

test("no church location is a clear error", () => {
  assert.throws(() => plan({ church: { lat: null, lng: null }, drivers: [], riders: [], travel, date: DATE }), /church_location_missing/);
});

test("a rider too far out of the way is waitlisted with that reason", () => {
  const d = driver("d", 52.1332, -106.671);
  const faraway = rider("far", 52.26, -106.2);
  const p = run([d], [faraway], { maxDetourMin: 10 });
  assert.equal(p.assignments.length, 0);
  assert.match(p.waitlist[0].reason, /Too far/);
});

test("evaluate warns when a leader puts too many riders in one car", () => {
  const d = driver("d", 52.1, -106.63, { seats: 1 });
  const riders = [rider("a", 52.1, -106.63), rider("b", 52.11, -106.64)];
  const ev = evaluate({ church, drivers: [d], riders, travel, date: DATE,
    assignments: riders.map((r) => ({ riderId: r.id, driverId: "d", trip: 1 })) });
  assert.ok(ev.warnings.some((w) => w.code === "over_seats"));
});

test("pointsFor lists church, drivers and located riders only", () => {
  const pts = pointsFor({ church, drivers: [driver("d", 52.1, -106.6)], riders: [rider("a", 52.1, -106.6), rider("b", null, null)] });
  assert.deepEqual(pts.map((p) => p.id), ["church", "D:d", "R:a"]);
});

test("150 riders and 25 drivers plan quickly and never overfill a car", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const at = () => ({ lat: 52.07 + rnd() * 0.12, lng: -106.74 + rnd() * 0.22 });
  const drivers = Array.from({ length: 25 }, (_, i) => driver(`d${i}`, ...Object.values(at()), { seats: 4, secondTrip: i % 2 === 0, gender: i % 2 ? "F" : "M" }));
  const riders = Array.from({ length: 150 }, (_, i) => rider(`r${i}`, ...Object.values(at()), { gender: i % 2 ? "F" : "M", minor: i % 17 === 0, priority: i % 11 === 0 }));
  const t0 = Date.now();
  const p = run(drivers, riders);
  assert.ok(Date.now() - t0 < 5000, "plan took too long");
  assert.equal(p.assignments.length + p.waitlist.length, 150);
  const perTrip = new Map();
  for (const a of p.assignments) perTrip.set(`${a.driverId}|${a.trip}`, (perTrip.get(`${a.driverId}|${a.trip}`) || 0) + 1);
  for (const n of perTrip.values()) assert.ok(n <= 4);
  assert.equal(new Set(p.assignments.map((a) => a.riderId)).size, p.assignments.length);
});
