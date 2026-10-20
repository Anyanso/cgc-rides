// Service days. Every Sunday is a service at the usual time (js/config.js) without anyone doing
// anything. The leader can change one day (e.g. "Joint service" at 10:00), call a Sunday off, or
// add a special service on any day (e.g. "Christmas Eve service" at 19:00). One service per day.
//
// The app loads the leader's changes once (setServices) and every screen, message and plan asks
// this module about a date, so a changed time flows through everything.

import { CONFIG } from "./config.js";
import { fromISO, toISO, nextSundays, fmtDate, fmtMin, toMin } from "./dates.js";

let byDate = new Map(); // "YYYY-MM-DD" -> { date, title, time, arriveBeforeMin, cutoff, cancelled, note }

export function setServices(rows) { byDate = new Map((rows || []).map((r) => [r.date, r])); }
export const changedServices = () => [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

export const isSunday = (iso) => fromISO(iso).getDay() === 0;
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function defaultCutoff(iso) {
  const d = fromISO(iso);
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d;
}

/** Everything about the service on one date (a plain Sunday if the leader changed nothing). */
export function serviceFor(iso, config = CONFIG) {
  const r = byDate.get(iso);
  const sunday = isSunday(iso);
  const time = r?.time || config.service.time;
  return {
    date: iso,
    sunday,
    changed: !!r,
    special: !sunday,
    title: (r?.title || "").trim() || (sunday ? "Sunday service" : "Special service"),
    time,
    arriveBeforeMin: r?.arriveBeforeMin ?? config.service.arriveBeforeMin,
    cutoff: r?.cutoff ? new Date(r.cutoff) : defaultCutoff(iso),
    customCutoff: !!r?.cutoff,
    cancelled: !!r?.cancelled,
    note: r?.note || "",
    differs: !!r && (!!(r.title || "").trim() || time !== config.service.time || !!r.cancelled || !sunday),
  };
}

export const isClosedFor = (iso, now = new Date()) => now >= serviceFor(iso).cutoff;

/** "11:45 AM" */
export const timeLabel = (iso) => fmtMin(toMin(serviceFor(iso).time));

/** "Saturday at noon", or "Wednesday, December 23 at 6:00 PM" when the leader set a cutoff. */
export function cutoffLabel(iso) {
  const s = serviceFor(iso);
  const c = s.cutoff;
  if (!s.customCutoff) return `${new Intl.DateTimeFormat("en-CA", { weekday: "long" }).format(c)} at noon`;
  const day = new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric" }).format(c);
  return `${day} at ${fmtMin(c.getHours() * 60 + c.getMinutes())}`;
}

/**
 * How a date reads in screens and messages:
 * plain Sunday -> "Sun, Oct 25"; changed or special -> "Joint service, Sun, Dec 27".
 * long = "Sunday, October 25".
 */
export function dayLabel(iso, { long = false } = {}) {
  const s = serviceFor(iso);
  const date = fmtDate(iso, long ? { weekday: "long", month: "long", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
  return s.differs && !s.cancelled && s.title !== "Sunday service" ? `${s.title}, ${date}` : date;
}

/** The days people can ask for: the next `weeks` Sundays plus any special service in the next 120 days. */
export function upcomingDays(weeks = CONFIG.weeksAhead, now = new Date()) {
  const today = toISO(now);
  const last = toISO(new Date(now.getTime() + 120 * 86400000));
  const specials = [...byDate.keys()].filter((d) => d >= today && d <= last && !isSunday(d));
  return [...new Set([...nextSundays(weeks, now), ...specials])].sort();
}

/**
 * The app's settings for one service day: its start time and arrive-early minutes, and an
 * earliest-pickup limit that suits it (an early joint service allows earlier pickups).
 */
export function configFor(iso, config = CONFIG) {
  const s = serviceFor(iso, config);
  const earliest = Math.min(toMin(config.matching.earliestPickup), toMin(s.time) - 135);
  return {
    ...config,
    service: { ...config.service, time: s.time, arriveBeforeMin: s.arriveBeforeMin },
    matching: { ...config.matching, earliestPickup: hhmm(Math.max(0, earliest)) },
  };
}
