// Geography helpers: neighbourhood names, straight-line estimates, address lookup.
//
// HONESTY NOTE: the neighbourhood coordinates below are approximate centres written by
// hand (good to roughly 1-2 km). They are only a fallback for when an address can't be
// looked up, and the leader sees a "location approximate" badge whenever one is used.
// Names with null coordinates have no fallback at all.

export const NEIGHBOURHOODS = [
  ["Downtown", 52.1332, -106.67], ["Nutana", 52.1215, -106.6519], ["City Park", 52.1349, -106.6602],
  ["Varsity View", 52.1197, -106.6407], ["Lakeview", 52.0989, -106.628], ["Lawson Heights", 52.1622, -106.6689],
  ["Silverspring", 52.1697, -106.6494], ["Stonebridge", 52.0872, -106.6244], ["Briarwood", 52.0925, -106.6323],
  ["Wildwood", 52.105, -106.612], ["Riversdale", 52.1257, -106.6768], ["Confederation Park", 52.1264, -106.7231],
  ["Westmount", 52.1367, -106.6844], ["Mount Royal", 52.142, -106.698], ["Meadowgreen", 52.15, -106.71],
  ["Pleasant Hill", 52.118, -106.685], ["King George", 52.115, -106.678], ["Erindale", 52.0975, -106.6975],
  ["Blairmore", 52.145, -106.735], ["Kensington", 52.085, -106.715], ["Evergreen", 52.1755, -106.596],
  ["Brighton", 52.08, -106.557], ["Rosewood", 52.094, -106.59], ["Willowgrove", 52.1085, -106.5395],
  ["Hampton Village", 52.115, -106.528], ["Aspen Ridge", 52.118, -106.533], ["Arbor Creek", 52.156, -106.623],
  ["Silverwood Heights", 52.158, -106.605], ["Sutherland", 52.148, -106.583], ["North Park", 52.156, -106.695],
  // Real neighbourhoods with no fallback coordinates (an address lookup is needed for these):
  ["Avalon", null, null], ["Buena Vista", null, null], ["Caswell Hill", null, null],
  ["Greystone Heights", null, null], ["Holiday Park", null, null], ["Massey Place", null, null],
  ["Montgomery Place", null, null], ["Adelaide/Churchill", null, null], ["Fairhaven", null, null],
  ["Hudson Bay Park", null, null], ["Dundonald", null, null], ["Exhibition", null, null],
  ["Forest Grove", null, null], ["Eastview", null, null], ["Nutana Park", null, null],
  ["Lakeridge", null, null], ["Parkridge", null, null], ["Other / not listed", null, null],
].map(([name, lat, lng]) => ({ name, lat, lng }));

export const neighbourhoodCentre = (name) => {
  const n = NEIGHBOURHOODS.find((x) => x.name === name);
  return n && n.lat != null ? { lat: n.lat, lng: n.lng } : null;
};

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Fallback drive-time guess in minutes: straight line x 1.35 for streets at ~32 km/h.
 * It does NOT know about the river or bridges. Real road times come from routing.js
 * when the free routing service is reachable.
 */
export function estimateMinutes(a, b) {
  return ((haversineKm(a, b) * 1.35) / 32) * 60;
}

/**
 * Look up an address with OpenStreetMap's free Nominatim service (browser only).
 * Falls back to the neighbourhood's approximate centre, then to nothing.
 * Returns { lat, lng, source: "address" | "neighbourhood" | "none" }.
 */
export async function geocode(address, { neighbourhood, nominatimUrl, enabled = true, fetchFn } = {}) {
  const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
  if (enabled && doFetch && address && address.trim()) {
    try {
      const url = new URL("/search", nominatimUrl || "https://nominatim.openstreetmap.org");
      url.searchParams.set("q", `${address.trim()}, Saskatoon, Saskatchewan, Canada`);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("countrycodes", "ca");
      url.searchParams.set("viewbox", "-106.85,52.25,-106.45,52.0"); // Saskatoon area
      url.searchParams.set("bounded", "1");
      const res = await doFetch(url.toString(), { headers: { Accept: "application/json" } });
      if (res.ok) {
        const hits = await res.json();
        if (Array.isArray(hits) && hits.length) {
          return { lat: Number(hits[0].lat), lng: Number(hits[0].lon), source: "address" };
        }
      }
    } catch (_) {
      /* fall through to the neighbourhood fallback */
    }
  }
  const centre = neighbourhoodCentre(neighbourhood);
  return centre ? { ...centre, source: "neighbourhood" } : { lat: null, lng: null, source: "none" };
}
