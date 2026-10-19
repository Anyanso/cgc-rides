import test from "node:test";
import assert from "node:assert/strict";
import { createDemoStore } from "../js/store-demo.js";
import { CONFIG } from "../js/config.js";
import { DEMO_CHURCH } from "../js/demo-data.js";
import { draftPlan, recompute, applyMove, reassignDriver } from "../js/planner.js";
import { roleView, shell, landingView, esc } from "../js/views.js";
import { toISO } from "../js/dates.js";
import { createLiveStore } from "../js/store-live.js";

const NOW = new Date(2026, 9, 19, 10, 0); // Monday 19 Oct 2026
const church = { lat: DEMO_CHURCH.lat, lng: DEMO_CHURCH.lng };
const offline = async () => { throw new Error("offline"); }; // forces straight-line estimates

async function leaderCtx() {
  const store = createDemoStore({ now: () => NOW });
  store.viewAs("leader");
  const data = await store.leaderData();
  return { store, data, sunday: store.sundays()[0] };
}
const plan = (c) => draftPlan({ data: c.data, sunday: c.sunday, church, config: CONFIG, fetchFn: offline });

test("demo: draft plan seats cleared drivers only, honours rules, and shows a waitlist reason", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  const byId = new Map(c.data.profiles.map((x) => [x.id, x]));
  assert.ok(!p.assignments.some((a) => ["d-esther", "d-new"].includes(a.driverId)), "suspended/pending drivers must get nobody");
  assert.ok(p.excludedDrivers.length >= 2);
  const tobi = p.assignments.find((a) => a.riderId === "r-tobi");
  assert.ok(tobi && byId.get(tobi.driverId).status === "cleared");
  const amara = p.assignments.find((a) => a.riderId === "r-amara");
  assert.equal(byId.get(amara.driverId).gender, "F");
  assert.equal(p.waitlist.find((w) => w.riderId === "r-isaac")?.reason.match(/locate/) != null, true);
  assert.match(p.travelNote, /straight-line/);
});

test("demo: nobody sees a plan until it is approved, then drivers see only their riders", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  const save = (status) => c.store.savePlan(c.sunday, status, {}, p.assignments, p.waitlist);
  await save("draft");
  c.store.viewAs("d-grace");
  assert.equal((await c.store.myRoute(c.sunday)).length, 0);
  c.store.viewAs("leader"); await save("approved");
  c.store.viewAs("d-grace");
  const route = await c.store.myRoute(c.sunday);
  const mine = p.assignments.filter((a) => a.driverId === "d-grace").length;
  assert.equal(route.length, mine);
  assert.ok(route.every((r) => r.address));
  c.store.viewAs("d-daniel");
  const names = (await c.store.myRoute(c.sunday)).map((r) => r.riderName);
  assert.ok(!names.some((n) => route.map((r) => r.riderName).includes(n)));
  c.store.viewAs("r-mary");
  const ride = (await c.store.myRides())[0];
  assert.equal(ride.status, "seated");
  assert.ok(ride.driverName && ride.readyByMin < ride.pickupMin);
  await assert.rejects(() => c.store.leaderData(), /Only the transport leader/);
});

test("demo: the plan can't be saved with an unsafe car (same rule as the database)", async () => {
  const c = await leaderCtx();
  const bad = [{ riderId: "r-mary", driverId: "d-esther", trip: 1 }];
  await assert.rejects(() => c.store.savePlan(c.sunday, "draft", {}, bad, []), /cleared drivers/);
  const full = ["r-mary", "r-peter", "r-amara"].map((r) => ({ riderId: r, driverId: "d-samuel", trip: 1 }));
  await assert.rejects(() => c.store.savePlan(c.sunday, "draft", {}, full, []), /more riders than seats/);
});

test("demo: moving a rider re-times the plan; a driver cancelling re-places only their riders", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  const to = "d-ruth|1";
  const moved = applyMove(p, "r-david", to);
  const r2 = await recompute({ data: c.data, sunday: c.sunday, church, config: CONFIG, ...moved, fetchFn: offline });
  assert.equal(r2.assignments.find((a) => a.riderId === "r-david").driverId, "d-ruth");

  const victim = "d-grace";
  const before = p.assignments.filter((a) => a.driverId !== victim);
  const re = await reassignDriver({ data: c.data, sunday: c.sunday, church, config: CONFIG, current: p, driverId: victim, fetchFn: offline });
  assert.ok(!re.assignments.some((a) => a.driverId === victim));
  for (const a of before) assert.ok(re.assignments.some((x) => x.riderId === a.riderId && x.driverId === a.driverId), "unaffected riders stay put");
  const affected = p.assignments.filter((a) => a.driverId === victim).map((a) => a.riderId);
  for (const id of affected) assert.ok(re.assignments.some((x) => x.riderId === id) || re.waitlist.some((w) => w.riderId === id));
});

test("demo: requests are refused after Saturday noon", async () => {
  const sat = new Date(2026, 9, 24, 13, 0);
  const store = createDemoStore({ now: () => sat });
  store.viewAs("r-lydia");
  await assert.rejects(() => store.requestRide(store.sundays()[0]), /closed/);
});

test("views: every role renders, escapes user text, and never shows undefined/NaN", async () => {
  const c = await leaderCtx();
  const p = await plan(c);
  await c.store.savePlan(c.sunday, "approved", {}, p.assignments, p.waitlist);
  c.store.viewAs("r-peter");
  await c.store.saveMyProfile({ name: '<img src=x onerror=alert(1)>' });
  for (const id of ["leader", "d-grace", "d-new", "d-esther", "r-mary", "r-peter", "r-tobi", "r-isaac"]) {
    c.store.viewAs(id);
    const me = await c.store.getMe();
    const S = { config: CONFIG, mode: "demo", session: { userId: id, email: "x" }, me, now: NOW, todayISO: toISO(NOW), sundays: c.store.sundays(), sunday: c.sunday, tab: null,
      rides: me.role === "rider" ? await c.store.myRides() : [], weeks: me.role === "driver" ? await c.store.myWeeks() : [],
      routes: {}, church, demoChurchLabel: "demo", planView: null, data: null, editing: null, demoPeople: c.store.people() };
    if (me.role === "driver") for (const s of S.sundays) S.routes[s] = await c.store.myRoute(s);
    if (me.role === "leader") {
      S.data = await c.store.leaderData();
      S.planView = { status: "approved", assignments: S.data.plans[c.sunday].assignments, waitlist: S.data.plans[c.sunday].waitlist, warnings: [], excluded: [], dirty: false };
      for (const tab of ["plan", "people", "alerts", "texts"]) {
        S.tab = tab; const html = roleView(S); assert.ok(!/undefined|NaN|\[object/.test(html), `leader ${tab}: ${html.match(/.{30}(undefined|NaN|\[object).{30}/)?.[0]}`);
      }
    } else {
      S.tab = me.role === "driver" ? "sundays" : "rides";
      const html = shell(S, roleView(S));
      assert.ok(!/undefined|NaN|\[object/.test(html), `${id}: ${html.match(/.{30}(undefined|NaN|\[object).{30}/)?.[0]}`);
      assert.ok(!html.includes("<img src=x"));
    }
  }
  assert.equal(esc(`<b>"x"&'</b>`), "&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;");
  assert.match(landingView({ mode: "demo" }), /Nobody in this church walks alone/);
});

test("live store: calls the right tables and functions (fake client; not a real Supabase test)", async () => {
  const log = [];
  const chain = (table) => {
    const q = { _t: table, calls: [] };
    const h = { get(t, k) { if (k === "then") return (res) => res({ data: table === "profiles" ? [] : [], error: null }); return (...a) => { log.push([table, k, ...a]); return new Proxy(q, h); }; } };
    return new Proxy(q, h);
  };
  const fake = { auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "a@b.c" } } } }), onAuthStateChange() {}, signInWithOtp: async (a) => { log.push(["otp", a.email]); return {}; }, signOut: async () => ({}) },
    from: (t) => chain(t), rpc: async (fn, args) => { log.push(["rpc", fn, args]); return { data: [], error: null }; } };
  const cfg = { ...CONFIG, supabase: { url: "https://x.supabase.co", anonKey: "k" } };
  const s = await createLiveStore(cfg, { createClient: () => fake });
  await s.init();
  assert.equal(s.session().email, "a@b.c");
  await s.myRides(); await s.myRoute("2026-10-25"); await s.cantMakeIt("2026-10-25", "sick");
  await s.savePlan("2026-10-25", "draft", {}, [], []); await s.giveConsent("words");
  await s.signIn("a@b.c");
  const rpcs = log.filter((l) => l[0] === "rpc").map((l) => l[1]);
  assert.deepEqual(rpcs, ["my_rides", "my_route", "driver_cant_make_it", "save_plan", "give_text_consent"]);
  assert.deepEqual(log.find((l) => l[1] === "save_plan")[2], { p_sunday: "2026-10-25", p_status: "draft", p_summary: {}, p_assignments: [], p_waitlist: [] });
  assert.ok(log.some((l) => l[0] === "otp"));
});
