// Glue between the data (profiles, requests, availability) and the matching engine.
// Used by the leader's screen. Everything async here only waits on the routing service.

import { plan, evaluate, pointsFor } from "./matching.js";
import { buildTravel } from "./routing.js";
import { asDriver, isDriver } from "./models.js";

export function matchOptions(config) {
  return {
    ...config.matching,
    serviceTime: config.service.time,
    arriveBeforeMin: config.service.arriveBeforeMin,
    readyBy: config.service.readyBy,
    readyBufferMin: config.service.readyBufferMin,
  };
}

/** Who is asking for a ride on this Sunday, who could drive. */
export function sundayPeople(data, sunday) {
  const byId = new Map(data.profiles.map((p) => [p.id, p]));
  const riders = data.requests
    .filter((r) => r.sunday === sunday && r.status !== "cancelled")
    .map((r) => ({ ...byId.get(r.riderId), rideHome: r.rideHome, requestNote: r.note, extraPeople: r.extraPeople || 0, canSplit: !!r.canSplit }))
    .filter((r) => r.id);
  const drivers = data.profiles.filter(isDriver).map((p) => asDriver(p, data.weeks, sunday));
  return { riders, drivers };
}

async function travelFor(people, church, config, fetchFn) {
  const pts = pointsFor({ church, ...people });
  return buildTravel(pts, {
    enabled: config.routing.enabled,
    baseUrl: config.routing.osrmUrl,
    ...(fetchFn ? { fetchFn } : {}),
    ...(fetchFn ? { delayMs: 0 } : {}),
  });
}

/** Draft a plan. `keep` = assignments to leave alone (used after a cancellation). */
export async function draftPlan({ data, sunday, church, config, keep = [], fetchFn }) {
  const people = sundayPeople(data, sunday);
  const t = await travelFor(people, church, config, fetchFn);
  const result = plan({ church, ...people, travel: t.travel, date: sunday, options: matchOptions(config), keep });
  return { ...result, travelSource: t.source, travelNote: t.note };
}

/** Re-time and re-check a plan after the leader moves someone by hand. */
export async function recompute({ data, sunday, church, config, assignments, waitlist, fetchFn }) {
  const people = sundayPeople(data, sunday);
  const t = await travelFor(people, church, config, fetchFn);
  const ev = evaluate({ church, ...people, assignments, travel: t.travel, date: sunday, options: matchOptions(config) });
  return { ...ev, waitlist, travelSource: t.source, travelNote: t.note };
}

/**
 * Move a rider (or the part of a group in one car) to another car ("driverId|trip") or the waitlist ("wait").
 * `from` is where they are now: "wait" or "driverId|trip". Seats move with them.
 */
export function applyMove({ assignments, waitlist }, riderId, target, from, reason = "Moved to the waitlist by the leader.") {
  let a = assignments.map((x) => ({ ...x }));
  let w = waitlist.map((x) => ({ ...x }));
  let seats = 1;
  if (from === "wait") {
    const e = w.find((x) => x.riderId === riderId);
    seats = e?.seats ?? 1;
    w = w.filter((x) => x.riderId !== riderId);
  } else {
    const idx = a.findIndex((x) => x.riderId === riderId && `${x.driverId}|${x.trip}` === from);
    if (idx >= 0) { seats = a[idx].seats ?? 1; a.splice(idx, 1); }
  }
  if (target === "wait") {
    const e = w.find((x) => x.riderId === riderId);
    if (e) e.seats = (e.seats ?? 1) + seats;
    else w.push({ riderId, seats, reason });
  } else {
    const [driverId, trip] = target.split("|");
    const t = Number(trip) || 1;
    const same = a.find((x) => x.riderId === riderId && x.driverId === driverId && x.trip === t);
    if (same) same.seats = (same.seats ?? 1) + seats;
    else a.push({ riderId, driverId, trip: t, seats });
    // Moving a car's worth of a group drops its old time/order so it is re-timed.
    a = a.map((x) => (x.riderId === riderId ? { ...x, order: undefined } : x));
  }
  return { assignments: a.map(({ riderId, driverId, trip, seats, order }) => ({ riderId, driverId, trip, seats, order })), waitlist: w };
}

/** A driver can't make it: keep everyone else where they are, re-place the affected riders. */
export async function reassignDriver({ data, sunday, church, config, current, driverId, fetchFn }) {
  const weeks = [
    ...data.weeks.filter((w) => !(w.driverId === driverId && w.sunday === sunday)),
    { driverId, sunday, available: false },
  ];
  const keep = current.assignments.filter((a) => a.driverId !== driverId);
  const result = await draftPlan({ data: { ...data, weeks }, sunday, church, config, keep, fetchFn });
  return { ...result, weeks };
}

/** Group saved assignments into cars for display (uses the saved times, no routing needed). */
export function groupCars(assignments, drivers) {
  const cars = new Map();
  for (const a of assignments) {
    const key = `${a.driverId}|${a.trip || 1}`;
    if (!cars.has(key)) cars.set(key, { driverId: a.driverId, trip: a.trip || 1, stops: [] });
    cars.get(key).stops.push(a);
  }
  const order = new Map(drivers.map((d, i) => [d.id, i]));
  return [...cars.values()]
    .map((c) => ({ ...c, stops: c.stops.sort((x, y) => (x.order ?? 0) - (y.order ?? 0)) }))
    .sort((a, b) => (order.get(a.driverId) ?? 99) - (order.get(b.driverId) ?? 99) || a.trip - b.trip);
}
