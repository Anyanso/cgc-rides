// DEMO store: everything lives in memory, nothing leaves the browser, a refresh resets it.
// It follows the same visibility rules as the real database so the demo shows true behaviour.

import { makeDemoState, DEMO_CHURCH } from "./demo-data.js";
import { isClosed, nextSundays } from "./dates.js";
import { validatePlan } from "./models.js";
import { geocode } from "./geo.js";

export function createDemoStore({ now = () => new Date() } = {}) {
  let db = makeDemoState(now());
  let viewer = null;
  const byId = (id) => db.profiles.find((p) => p.id === id);
  const me = () => (viewer ? byId(viewer) : null);
  const isLeader = () => me()?.role === "leader";
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const fresh = (o) => JSON.parse(JSON.stringify(o));

  return {
    mode: "demo",
    demoChurch: DEMO_CHURCH,
    async init() { return null; },
    session() { return viewer ? { userId: viewer, email: me().email } : null; },
    people() { return db.profiles.filter((p) => p.id !== "d-new" || true).map((p) => ({ id: p.id, name: p.name, role: p.role, status: p.status })); },
    viewAs(id) { viewer = id; },
    async signOut() { viewer = null; },
    reset() { db = makeDemoState(now()); },
    sundays() { return db.sundays; },

    async getMe() { return me() ? fresh(me()) : null; },

    async saveMyProfile(patch) {
      need(viewer, "Not signed in");
      const p = me();
      const allowed = ["name", "phone", "gender", "address", "neighbourhood", "lat", "lng", "geoSource", "minor", "guardianName",
        "guardianPhone", "prefersSameGender", "weeklyCheckin", "notes", "seats", "drivesEveryWeek", "secondTrip", "vehicle", "role"];
      for (const k of allowed) if (k in patch && !(k === "role" && !["rider", "driver"].includes(patch.role))) p[k] = patch[k];
      if (p.role === "driver" && p.status === "none") p.status = "pending";
      return fresh(p);
    },

    // ---- rider
    async myRides() {
      const m = me();
      return db.requests.filter((r) => r.riderId === m.id && r.sunday >= db.sundays[0]).sort((a, b) => a.sunday.localeCompare(b.sunday)).map((r) => {
        const plan = db.plans[r.sunday];
        const a = plan?.status === "approved" ? plan.assignments.find((x) => x.riderId === m.id) : null;
        const w = plan?.status === "approved" ? plan.waitlist.find((x) => x.riderId === m.id) : null;
        const d = a && r.status !== "cancelled" ? byId(a.driverId) : null;
        return {
          sunday: r.sunday, rideHome: r.rideHome, note: r.note,
          status: r.status === "cancelled" ? "cancelled" : a ? "seated" : w ? "waitlisted" : "requested",
          driverName: d?.name ?? null, driverPhone: d?.phone ?? null, vehicle: d?.vehicle ?? null,
          trip: d ? a.trip : null, pickupMin: d ? a.pickupMin : null, readyByMin: d ? a.readyByMin : null, arriveMin: d ? a.arriveMin : null,
        };
      });
    },
    async requestRide(sunday, { rideHome = false, note = null } = {}) {
      const m = me();
      need(db.sundays.includes(sunday), "That Sunday is not open for requests.");
      need(!isClosed(sunday, now()), `Requests for this Sunday closed on Saturday at noon. Please contact the transport leader.`);
      const ex = db.requests.find((r) => r.riderId === m.id && r.sunday === sunday);
      if (ex) Object.assign(ex, { status: "requested", rideHome, note });
      else db.requests.push({ id: `q-${m.id}-${sunday}`, riderId: m.id, sunday, rideHome, note, status: "requested" });
    },
    async cancelRide(sunday) {
      const m = me();
      const r = db.requests.find((x) => x.riderId === m.id && x.sunday === sunday);
      need(r, "No request to cancel.");
      const had = db.plans[sunday]?.assignments.some((a) => a.riderId === m.id);
      if (r.status !== "cancelled" && had) {
        db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "rider_cancel", sunday, riderId: m.id, driverId: null, resolved: false,
          message: `${m.name} can't make it on ${sunday} and had a seat.`, createdAt: now().toISOString() });
      }
      r.status = "cancelled";
    },
    async giveConsent(wording, profileId = null) {
      const target = profileId && isLeader() ? byId(profileId) : me();
      need(target, "Create your profile first.");
      target.textsConsentAt = now().toISOString();
      target.textsConsentWithdrawnAt = null;
      db.consentLog.push({ profileId: target.id, kind: "given", wording, at: target.textsConsentAt });
    },
    async withdrawConsent(profileId = null) {
      const target = profileId && isLeader() ? byId(profileId) : me();
      target.textsConsentAt = null;
      target.textsConsentWithdrawnAt = now().toISOString();
      db.consentLog.push({ profileId: target.id, kind: "withdrawn", at: target.textsConsentWithdrawnAt });
    },

    // ---- driver
    async myWeeks() { return db.weeks.filter((w) => w.driverId === me().id).map(fresh); },
    async setAvailability(sunday, available, note = null) {
      const m = me();
      const ex = db.weeks.find((w) => w.driverId === m.id && w.sunday === sunday);
      if (ex) Object.assign(ex, { available, note });
      else db.weeks.push({ driverId: m.id, sunday, available, note });
    },
    async myRoute(sunday) {
      const m = me();
      const plan = db.plans[sunday];
      if (!plan || plan.status !== "approved") return [];
      return plan.assignments.filter((a) => a.driverId === m.id).sort((a, b) => a.trip - b.trip || a.order - b.order).map((a) => {
        const r = byId(a.riderId);
        const q = db.requests.find((x) => x.riderId === r.id && x.sunday === sunday);
        return { trip: a.trip, order: a.order, pickupMin: a.pickupMin, readyByMin: a.readyByMin, arriveMin: a.arriveMin,
          riderName: r.name, riderPhone: r.phone, address: r.address, neighbourhood: r.neighbourhood, lat: r.lat, lng: r.lng,
          minor: r.minor, guardianName: r.minor ? r.guardianName : null, guardianPhone: r.minor ? r.guardianPhone : null,
          riderNotes: r.notes, requestNote: q?.note ?? null, rideHome: !!q?.rideHome, cancelled: q?.status === "cancelled" };
      }).filter((x) => !x.cancelled);
    },
    async cantMakeIt(sunday, note = null) {
      const m = me();
      need(m.role === "driver", "Only drivers can use this.");
      await this.setAvailability(sunday, false, note);
      const n = (db.plans[sunday]?.assignments || []).filter((a) => a.driverId === m.id).length;
      db.alerts.push({ id: `a${db.alerts.length + 1}`, kind: "driver_cancel", sunday, driverId: m.id, riderId: null, resolved: false,
        message: `${m.name} can't make it on ${sunday}. ${n} rider(s) need a new ride.${note ? ` Note: ${note}` : ""}`, createdAt: now().toISOString() });
      return n;
    },

    // ---- leader
    async leaderData() {
      need(isLeader(), "Only the transport leader can see this.");
      return fresh({ profiles: db.profiles, requests: db.requests, weeks: db.weeks, plans: db.plans, alerts: db.alerts, consentLog: db.consentLog });
    },
    async savePlan(sunday, status, summary, assignments, waitlist) {
      need(isLeader(), "Only the transport leader can save a plan.");
      validatePlan({ profilesById: new Map(db.profiles.map((p) => [p.id, p])), sunday, assignments });
      db.plans[sunday] = { sunday, status, summary: summary || {}, assignments: fresh(assignments), waitlist: fresh(waitlist || []), approvedAt: status === "approved" ? now().toISOString() : null };
    },
    async saveProfile(p) {
      need(isLeader(), "Only the transport leader can do this.");
      if (p.id && byId(p.id)) Object.assign(byId(p.id), p);
      else {
        const id = `p-${db.profiles.length + 1}`;
        db.profiles.push({ id, userId: null, email: null, role: "rider", status: "none", seats: 0, minor: false, priority: false, prefersSameGender: false, weeklyCheckin: false, ...p, id });
        return id;
      }
      return p.id;
    },
    async addRequest(riderId, sunday, { rideHome = false, note = null } = {}) {
      need(isLeader(), "Only the transport leader can do this.");
      const ex = db.requests.find((r) => r.riderId === riderId && r.sunday === sunday);
      if (ex) Object.assign(ex, { status: "requested", rideHome, note });
      else db.requests.push({ id: `q-${riderId}-${sunday}`, riderId, sunday, rideHome, note, status: "requested" });
    },
    async removeRequest(riderId, sunday) {
      const r = db.requests.find((x) => x.riderId === riderId && x.sunday === sunday);
      if (r) r.status = "cancelled";
    },
    async resolveAlert(id) { const a = db.alerts.find((x) => x.id === id); if (a) a.resolved = true; },

    async locate(address, neighbourhood, geocoding) {
      return geocode(address, { neighbourhood, nominatimUrl: geocoding?.nominatimUrl, enabled: false });
    },
    _sundays: () => nextSundays(4, now()),
  };
}
