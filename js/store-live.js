// LIVE store: talks to your Supabase project. Same methods as the demo store.
// The database (supabase/schema.sql) decides who may see what; this file never relies on
// hiding things in the screens.
//
// Untested against a real Supabase project from the build environment (no network there).
// The SQL it calls is tested separately; see tests/sql.test.mjs and the README test plan.

import { profileFromRow, profileToRow } from "./models.js";
import { nextSundays } from "./dates.js";
import { geocode } from "./geo.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const camelRow = (r, map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, r[v]]));
const fail = ({ error }) => { if (error) throw new Error(error.message || String(error)); };

export async function createLiveStore(config, { createClient } = {}) {
  const make = createClient || (await import(SUPABASE_JS)).createClient;
  const sb = make(config.supabase.url, config.supabase.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  let user = null;
  let cachedMe;

  const rpc = async (fn, args) => { const res = await sb.rpc(fn, args); fail(res); return res.data; };
  const from = (t) => sb.from(t);
  const getUid = () => { if (!user) throw new Error("Please sign in."); return user.id; };

  const requestFrom = (r) => ({ id: r.id, riderId: r.rider_id, sunday: r.sunday, rideHome: r.ride_home, note: r.note, status: r.status });
  const rideFrom = (r) => camelRow(r, { sunday: "sunday", status: "status", rideHome: "ride_home", note: "note", driverName: "driver_name", driverPhone: "driver_phone", vehicle: "vehicle", trip: "trip", pickupMin: "pickup_min", readyByMin: "ready_by_min", arriveMin: "arrive_min" });
  const routeFrom = (r) => camelRow(r, { trip: "trip", order: "stop_order", pickupMin: "pickup_min", readyByMin: "ready_by_min", arriveMin: "arrive_min", riderName: "rider_name", riderPhone: "rider_phone", address: "address", neighbourhood: "neighbourhood", lat: "lat", lng: "lng", minor: "minor", guardianName: "guardian_name", guardianPhone: "guardian_phone", riderNotes: "rider_notes", requestNote: "request_note", rideHome: "ride_home" });

  return {
    mode: "live",

    /** Restores a saved sign-in (also handles the return from the emailed link). */
    async init(onChange) {
      const { data } = await sb.auth.getSession();
      user = data.session?.user ?? null;
      sb.auth.onAuthStateChange((_event, session) => {
        user = session?.user ?? null;
        cachedMe = undefined;
        if (onChange) onChange();
      });
      return user;
    },
    session() { return user ? { userId: user.id, email: user.email } : null; },
    async signIn(email) {
      const res = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: typeof location !== "undefined" ? location.href.split("#")[0].split("?")[0] : undefined } });
      fail(res);
    },
    async signOut() { await sb.auth.signOut(); user = null; cachedMe = undefined; },
    sundays() { return nextSundays(config.weeksAhead); },

    async getMe() {
      if (!user) return null;
      if (cachedMe !== undefined) return cachedMe;
      const res = await from("profiles").select("*").eq("user_id", user.id).maybeSingle();
      fail(res);
      cachedMe = profileFromRow(res.data);
      return cachedMe;
    },
    async saveMyProfile(patch) {
      const uid = getUid();
      const existing = await this.getMe();
      const row = profileToRow(patch);
      delete row.id; delete row.user_id; delete row.email; delete row.driver_status;
      let res;
      if (existing) res = await from("profiles").update(row).eq("user_id", uid).select().single();
      else res = await from("profiles").insert({ ...row, user_id: uid, email: user.email }).select().single();
      fail(res);
      cachedMe = profileFromRow(res.data);
      return cachedMe;
    },

    // ---- rider
    async myRides() { return (await rpc("my_rides")).map(rideFrom); },
    async requestRide(sunday, { rideHome = false, note = null } = {}) {
      const me = await this.getMe();
      fail(await from("ride_requests").upsert({ rider_id: me.id, sunday, ride_home: rideHome, note, status: "requested" }, { onConflict: "rider_id,sunday" }));
    },
    async cancelRide(sunday) {
      const me = await this.getMe();
      fail(await from("ride_requests").update({ status: "cancelled" }).eq("rider_id", me.id).eq("sunday", sunday));
    },
    async giveConsent(wording, profileId = null) { await rpc("give_text_consent", { p_wording: wording, p_profile: profileId }); cachedMe = undefined; },
    async withdrawConsent(profileId = null) { await rpc("withdraw_text_consent", { p_profile: profileId }); cachedMe = undefined; },

    // ---- driver
    async myWeeks() {
      const me = await this.getMe();
      const res = await from("driver_weeks").select("*").eq("driver_id", me.id);
      fail(res);
      return res.data.map((w) => ({ driverId: w.driver_id, sunday: w.sunday, available: w.available, note: w.note }));
    },
    async setAvailability(sunday, available, note = null) {
      const me = await this.getMe();
      fail(await from("driver_weeks").upsert({ driver_id: me.id, sunday, available, note }, { onConflict: "driver_id,sunday" }));
    },
    async myRoute(sunday) { return (await rpc("my_route", { p_sunday: sunday })).map(routeFrom); },
    async cantMakeIt(sunday, note = null) { return rpc("driver_cant_make_it", { p_sunday: sunday, p_note: note }); },

    // ---- leader
    async leaderData() {
      const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const [pr, rq, wk, pl, as, wl, al, cl] = await Promise.all([
        from("profiles").select("*").order("full_name"),
        from("ride_requests").select("*").gte("sunday", since),
        from("driver_weeks").select("*").gte("sunday", since),
        from("plans").select("*").gte("sunday", since),
        from("assignments").select("*"),
        from("waitlist").select("*"),
        from("alerts").select("*").order("created_at", { ascending: false }).limit(50),
        from("consent_log").select("*").order("at", { ascending: false }).limit(200),
      ]);
      for (const r of [pr, rq, wk, pl, as, wl, al, cl]) fail(r);
      const plans = {};
      for (const p of pl.data) {
        plans[p.sunday] = {
          sunday: p.sunday, status: p.status, summary: p.summary, approvedAt: p.approved_at,
          assignments: as.data.filter((a) => a.plan_id === p.id).map((a) => ({ riderId: a.rider_id, driverId: a.driver_id, trip: a.trip, order: a.stop_order, pickupMin: a.pickup_min, readyByMin: a.ready_by_min, arriveMin: a.arrive_min })),
          waitlist: wl.data.filter((w) => w.plan_id === p.id).map((w) => ({ riderId: w.rider_id, reason: w.reason })),
        };
      }
      return {
        profiles: pr.data.map(profileFromRow),
        requests: rq.data.map(requestFrom),
        weeks: wk.data.map((w) => ({ driverId: w.driver_id, sunday: w.sunday, available: w.available, note: w.note })),
        plans,
        alerts: al.data.map((a) => ({ id: a.id, kind: a.kind, sunday: a.sunday, driverId: a.driver_id, riderId: a.rider_id, message: a.message, resolved: a.resolved, createdAt: a.created_at })),
        consentLog: cl.data.map((c) => ({ profileId: c.profile_id, kind: c.kind, wording: c.wording, at: c.at })),
      };
    },
    async savePlan(sunday, status, summary, assignments, waitlist) {
      await rpc("save_plan", { p_sunday: sunday, p_status: status, p_summary: summary || {}, p_assignments: assignments, p_waitlist: waitlist || [] });
    },
    async saveProfile(p) {
      const row = profileToRow(p);
      delete row.id; delete row.user_id; delete row.email;
      if (p.id) { fail(await from("profiles").update(row).eq("id", p.id)); return p.id; }
      const res = await from("profiles").insert({ role: "rider", ...row }).select("id").single();
      fail(res);
      return res.data.id;
    },
    async addRequest(riderId, sunday, { rideHome = false, note = null } = {}) {
      fail(await from("ride_requests").upsert({ rider_id: riderId, sunday, ride_home: rideHome, note, status: "requested" }, { onConflict: "rider_id,sunday" }));
    },
    async removeRequest(riderId, sunday) {
      fail(await from("ride_requests").update({ status: "cancelled" }).eq("rider_id", riderId).eq("sunday", sunday));
    },
    async resolveAlert(id) { fail(await from("alerts").update({ resolved: true }).eq("id", id)); },

    async locate(address, neighbourhood, geocoding) {
      return geocode(address, { neighbourhood, nominatimUrl: geocoding?.nominatimUrl, enabled: geocoding?.enabled !== false });
    },
  };
}
