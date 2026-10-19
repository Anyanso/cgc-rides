// Real driving times from the free OSRM routing service (OpenStreetMap road data), which
// knows where the bridges are. Falls back to straight-line estimates if it can't be reached.
//
// The public OSRM server is a shared demo server meant for light use. A church-sized
// plan is one small request. Results are cached in memory so re-planning is free.

import { estimateMinutes } from "./geo.js";

const cache = new Map(); // "lat,lng>lat,lng" -> minutes
const key = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * points: [{ id, lat, lng }, ...]
 * Returns { travel(a, b) -> minutes, source, note } where a and b are point objects with an id.
 */
export async function buildTravel(points, opts = {}) {
  const {
    enabled = true,
    baseUrl = "https://router.project-osrm.org",
    fetchFn = typeof fetch === "function" ? fetch : null,
    chunk = 45, // the public server accepts up to 100 coordinates per request
    delayMs = 1100, // be polite: about one request per second
  } = opts;

  const usable = points.filter((p) => p.lat != null && p.lng != null);
  const byId = new Map(usable.map((p) => [p.id, p]));
  let source = "estimate";
  let note = enabled ? "" : "Routing service switched off in settings.";

  if (enabled && fetchFn && usable.length > 1) {
    try {
      const blocks = [];
      for (let i = 0; i < usable.length; i += chunk) blocks.push(usable.slice(i, i + chunk));
      let first = true;
      for (const A of blocks) {
        for (const B of blocks) {
          const need = [];
          for (const a of A) for (const b of B) if (a.id !== b.id && !cache.has(key(a, b))) need.push(1);
          if (!need.length) continue;
          const sameBlock = A === B;
          const coords = sameBlock ? A : [...A, ...B];
          const srcIdx = A.map((_, i) => i);
          const dstIdx = sameBlock ? srcIdx : B.map((_, i) => A.length + i);
          const url =
            `${baseUrl}/table/v1/driving/` +
            coords.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";") +
            `?sources=${srcIdx.join(";")}&destinations=${dstIdx.join(";")}&annotations=duration`;
          if (!first && delayMs) await sleep(delayMs);
          first = false;
          const res = await fetchFn(url);
          if (!res.ok) throw new Error(`routing service answered ${res.status}`);
          const data = await res.json();
          if (data.code !== "Ok" || !Array.isArray(data.durations)) throw new Error(`routing service: ${data.code}`);
          A.forEach((a, r) =>
            B.forEach((b, c) => {
              const secs = data.durations[r]?.[c];
              if (a.id !== b.id && typeof secs === "number") cache.set(key(a, b), secs / 60);
            })
          );
        }
      }
      source = "osrm";
    } catch (err) {
      source = "estimate";
      note = `Real road times were unavailable (${err.message}); using straight-line estimates. Check the plan by eye.`;
    }
  }

  const travel = (a, b) => {
    if (a.id === b.id) return 0;
    const pa = byId.get(a.id) || a;
    const pb = byId.get(b.id) || b;
    const hit = cache.get(key(pa, pb));
    return hit != null ? hit : estimateMinutes(pa, pb);
  };
  return { travel, source, note };
}

export const clearRoutingCache = () => cache.clear();
