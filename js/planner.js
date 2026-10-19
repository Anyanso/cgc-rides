// Glue between the data (profiles, requests, availability) and the matching engine.
// Used by the leader's screen. Everything async here only waits on the routing service.

import { plan, evaluate, pointsFor } from "./matching.js";
import { buildTravel } from "./routing.js";
import { asDriver } from "./models.js";

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
    .map((r) => ({ ...byId.get(r.riderId), rideHome: r.rideHome, requestNote: r.note }))
    .filter((r) => r.id);
  const drivers = data.profiles.filter((p) => p.role === "driver").map((p) => asDriver(p, data.weeks, sunday));
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

/** Move one rider to a car ("driverId|trip") or to the waitlist ("wait"). Returns new assignments + waitlist. */
export function applyMove({ assignments, waitlist }, riderId, target, reason = "Moved to the waitlist by the leader.") {
  const a = assignments.filter((x) => x.riderId !== riderId).map(({ riderId, driverId, trip }) => ({ riderId, driverId, trip }));
  let w = waitlist.filter((x) => x.riderId !== riderId);
  if (target === "wait") w = [...w, { riderId, reason }];
  else {
    const [driverId, trip] = target.split("|");
    a.push({ riderId, driverId, trip: Number(trip) || 1 });
  }
  return { assignments: a, waitlist: w };
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
