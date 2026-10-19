// The app shell: loads data, draws the right screen, and reacts to taps.
// Browser only. The logic it relies on lives in matching.js, planner.js and the stores.

import { CONFIG, IS_DEMO } from "./config.js";
import { createDemoStore } from "./store-demo.js";
import { toISO, fmtDate } from "./dates.js";
import { geocode } from "./geo.js";
import { driverIssue } from "./matching.js";
import { draftPlan, recompute, applyMove, reassignDriver } from "./planner.js";
import { driverAvailable, CONSENT_WORDING, isDriver } from "./models.js";
import { shell, landingView, signInView, demoPickerView, roleView } from "./views.js";
import { lastMinuteBroadcast } from "./texts.js";
import { DEMO_CHURCH } from "./demo-data.js";

const root = document.getElementById("app");
let store;

const S = {
  config: CONFIG, mode: IS_DEMO ? "demo" : "live",
  screen: "landing", session: null, me: null, tab: null,
  sundays: [], sunday: null, rides: [], weeks: [], routes: {},
  data: null, planView: null, church: null, churchWarning: null,
  editing: null, busy: false, toast: "", error: "", signInSent: "", regRole: null, broadcast: "",
  now: new Date(), todayISO: "", demoPeople: null, appUrl: "", demoChurchLabel: DEMO_CHURCH.label,
};

// ---------------------------------------------------------------- drawing

function render() {
  S.now = new Date();
  S.todayISO = toISO(S.now);
  let inner;
  if (!S.session) {
    inner = S.screen === "picker" && S.demoPeople ? demoPickerView(S) : S.screen === "signin" ? signInView(S) : landingView(S);
  } else if (!S.me || S.screen === "loading") {
    inner = S.screen === "loading" ? `<p class="muted center">Loading…</p>` : roleView(S);
  } else {
    inner = roleView(S);
  }
  const y = window.scrollY;
  root.innerHTML = shell(S, inner);
  window.scrollTo(0, y);
  S.toast = "";
}

const say = (msg) => { S.toast = msg; };

async function guarded(fn) {
  S.error = "";
  S.busy = true;
  try { await fn(); }
  catch (err) { console.error(err); S.error = err?.message || String(err); }
  finally { S.busy = false; render(); }
}

// ---------------------------------------------------------------- loading

async function resolveChurch() {
  if (S.mode === "demo" && !(CONFIG.church.lat != null)) { S.church = { id: "church", ...DEMO_CHURCH }; S.churchWarning = null; return; }
  const c = CONFIG.church;
  if (c.lat != null && c.lng != null) { S.church = { lat: c.lat, lng: c.lng }; S.churchWarning = null; return; }
  if (c.address) {
    const key = `cgc-church:${c.address}`;
    try { const hit = JSON.parse(localStorage.getItem(key) || "null"); if (hit) { S.church = hit; S.churchWarning = null; return; } } catch (_) { /* no storage */ }
    const g = await geocode(c.address, { nominatimUrl: CONFIG.geocoding.nominatimUrl, enabled: CONFIG.geocoding.enabled });
    if (g.source === "address") {
      S.church = { lat: g.lat, lng: g.lng }; S.churchWarning = null;
      try { localStorage.setItem(key, JSON.stringify(S.church)); } catch (_) { /* ignore */ }
      return;
    }
    S.church = null;
    S.churchWarning = `We couldn't find "${c.address}" on the map. Put the church's latitude and longitude in js/config.js instead.`;
    return;
  }
  S.church = null;
  S.churchWarning = "Put the church's street address (or latitude and longitude) in js/config.js. Until then, plans can't be drafted.";
}

function excludedFor(sunday) {
  return S.data.profiles.filter(isDriver).map((d) => ({ name: d.name, reason: driverIssue({ ...d, available: driverAvailable(d, S.data.weeks, sunday) }, sunday) })).filter((e) => e.reason);
}

function planViewFromSaved() {
  const saved = S.data.plans[S.sunday];
  S.planView = saved ? { status: saved.status, assignments: saved.assignments, waitlist: saved.waitlist, trips: null, warnings: [], excluded: excludedFor(S.sunday), dirty: false, travelNote: "", travelSource: saved.summary?.travelSource } : null;
}

async function load() {
  S.sundays = store.sundays();
  S.me = await store.getMe();
  S.appUrl = location.href.split("#")[0].split("?")[0];
  if (!S.me) return;
  await resolveChurch();
  const defaults = { leader: "plan", driver: "sundays", rider: "rides" };
  if (!S.tab || (S.me.role === "leader" && !["plan", "people", "alerts", "texts", "driving"].includes(S.tab)) ||
      (S.me.role === "driver" && !["sundays", "details"].includes(S.tab)) || (S.me.role === "rider" && !["rides", "details"].includes(S.tab))) S.tab = defaults[S.me.role];
  if (S.me.role === "rider") S.rides = await store.myRides();
  if (S.me.role === "driver") {
    S.weeks = await store.myWeeks();
    S.routes = {};
    for (const s of S.sundays) S.routes[s] = await store.myRoute(s);
  }
  if (S.me.role === "leader") {
    S.weeks = await store.myWeeks();
    S.routes = {};
    for (const s of S.sundays) S.routes[s] = await store.myRoute(s);
    S.data = await store.leaderData();
    S.sunday = S.sunday && S.sundays.includes(S.sunday) ? S.sunday : S.sundays[0];
    if (!S.planView || !S.planView.dirty) planViewFromSaved();
  }
}

async function reload() { await load(); }

// ---------------------------------------------------------------- reading forms

function readProfile(form) {
  const f = new FormData(form);
  const has = (n) => form.elements.namedItem(n) != null;
  const text = (n) => (f.get(n) || "").toString().trim() || null;
  const bool = (n) => f.get(n) === "on";
  const out = { name: text("name"), phone: text("phone"), address: text("address"), neighbourhood: text("neighbourhood"), minor: bool("minor"), notes: text("notes") };
  if (has("role")) out.role = text("role");
  if (has("alsoDrives")) out.status = bool("alsoDrives") ? "cleared" : "none";
  if (has("seats")) Object.assign(out, { seats: Number(f.get("seats")) || 0, vehicle: text("vehicle"), drivesEveryWeek: bool("drivesEveryWeek"), secondTrip: bool("secondTrip") });
  if (has("priority")) out.priority = bool("priority");
  if (has("status")) Object.assign(out, { status: text("status"), licenceOk: bool("licenceOk"), insuranceOk: bool("insuranceOk"), policeCheckExpiry: text("policeCheckExpiry") });
  return out;
}

async function withLocation(patch, previous = {}) {
  const changed = patch.address !== previous.address || patch.neighbourhood !== previous.neighbourhood || previous.lat == null;
  if (!changed) return patch;
  const g = await store.locate(patch.address, patch.neighbourhood, CONFIG.geocoding);
  return { ...patch, lat: g.lat, lng: g.lng, geoSource: g.source };
}

// ---------------------------------------------------------------- plan helpers

function planSummary() { return { travelSource: S.planView.travelSource || null, travelNote: S.planView.travelNote || "", savedFrom: "app" }; }

async function persistPlan(status) {
  const pv = S.planView;
  await store.savePlan(S.sunday, status, planSummary(), pv.assignments.map((a) => ({ riderId: a.riderId, driverId: a.driverId, trip: a.trip, order: a.order ?? 0, seats: a.seats ?? 1, pickupMin: a.pickupMin ?? null, readyByMin: a.readyByMin ?? null, arriveMin: a.arriveMin ?? null })), pv.waitlist);
  S.planView = null;
  await reload();
}

function adoptResult(res, status) {
  S.planView = { status, assignments: res.assignments, waitlist: res.waitlist, trips: res.trips, warnings: res.warnings, excluded: res.excludedDrivers || excludedFor(S.sunday), dirty: true, travelNote: res.travelNote, travelSource: res.travelSource };
}

function needChurch() { if (!S.church) throw new Error(S.churchWarning || "The church location isn't set."); }

// ---------------------------------------------------------------- actions

const actions = {
  home() { S.screen = "landing"; },
  "demo-start"() { S.screen = "picker"; },
  "goto-signin"() { S.screen = "signin"; },
  "reg-back"() { S.regRole = null; },
  "reg-role"(d) { S.regRole = d.role === "driver" ? "driver" : "rider"; },
  "signin-reset"() { S.signInSent = ""; },
  async viewas(d) { store.viewAs(d.id); S.session = store.session(); S.tab = null; S.sunday = null; S.planView = null; S.editing = null; await reload(); say(`Viewing as ${S.me?.name}`); },
  async signout() { await store.signOut(); S.session = null; S.me = null; S.screen = "landing"; S.tab = null; S.planView = null; S.regRole = null; },
  tab(d) { S.tab = d.tab; S.editing = null; },
  async "pick-sunday"(d) {
    if (d.sunday === S.sunday) return;
    if (S.planView?.dirty && !confirm("You have unsaved changes to this plan. Switch anyway?")) return;
    S.sunday = d.sunday; planViewFromSaved();
  },
  copy(d) { return copyText(d.text).then(() => say("Copied. Paste it into your message.")); },

  // rider
  async "cancel-ride"(d) { if (!confirm("Tell the team you can't make it on " + fmtDate(d.sunday) + "?")) return; await store.cancelRide(d.sunday); await reload(); say("Okay, we've let the team know."); },
  async "consent-on"() { await store.giveConsent(CONSENT_WORDING); await reload(); say("Thank you. We'll text you about your rides."); },
  async "consent-off"() { await store.withdrawConsent(); await reload(); say("Texts turned off."); },

  // driver
  async "toggle-avail"(d) { await store.setAvailability(d.sunday, d.to === "yes"); await reload(); },
  async "cant-make-it"(d) {
    if (!confirm("Tell the leader you can't drive on " + fmtDate(d.sunday) + "? Your riders will be moved to other drivers.")) return;
    await store.cantMakeIt(d.sunday); await reload(); say("The leader has been told. Thank you for letting us know.");
  },

  // leader
  async draft() {
    needChurch();
    const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: CONFIG });
    adoptResult(res, "draft");
    say(`Draft ready: ${res.assignments.length} seated, ${res.waitlist.length} waiting.`);
  },
  async "save-draft"() { await persistPlan("draft"); say("Draft saved. Drivers and riders can't see it yet."); },
  async approve() {
    if (S.planView.warnings?.some((w) => w.code === "over_seats" || w.code === "driver_issue")) throw new Error("Fix the warnings about seats or driver clearance before approving.");
    await persistPlan("approved");
    say("Approved. Drivers and riders can now see their details. Copy their messages from the Texts tab.");
  },
  async reassign(d) {
    needChurch();
    if (S.sunday !== d.sunday) { S.sunday = d.sunday; planViewFromSaved(); }
    else if (!S.planView) planViewFromSaved();
    const current = S.planView;
    if (!current) throw new Error("There's no plan for that Sunday yet. Draft one first.");
    const res = await reassignDriver({ data: S.data, sunday: d.sunday, church: S.church, config: CONFIG, current, driverId: d.driver });
    S.data = { ...S.data, weeks: res.weeks };
    adoptResult(res, current.status);
    await store.resolveAlert(d.alert);
    S.data.alerts = S.data.alerts.map((a) => (a.id === d.alert ? { ...a, resolved: true } : a));
    S.tab = "plan";
    say(`Riders moved. ${res.waitlist.length ? res.waitlist.length + " could not be placed (see waiting list). " : ""}Review, then save.`);
  },
  async "split-ok"(d) {
    needChurch();
    const rid = d.rider;
    await store.updateRequest(rid, S.sunday, { canSplit: true });
    S.data = { ...S.data, requests: S.data.requests.map((q) => (q.riderId === rid && q.sunday === S.sunday ? { ...q, canSplit: true } : q)) };
    const current = S.planView;
    const keep = current.assignments.filter((a) => a.riderId !== rid);
    const res = await draftPlan({ data: S.data, sunday: S.sunday, church: S.church, config: CONFIG, keep });
    adoptResult(res, current.status);
    say("Re-placed that group across cars. Everyone else stayed where they were. Review, then save.");
  },
  async resolve(d) { await store.resolveAlert(d.id); await reload(); },
  edit(d) { S.editing = d.id; },
  "edit-cancel"() { S.editing = null; },
};

async function onMove(el) {
  if (!el.value) return;
  needChurch();
  const moved = applyMove({ assignments: S.planView.assignments, waitlist: S.planView.waitlist }, el.dataset.rider, el.value, el.dataset.from);
  const res = await recompute({ data: S.data, sunday: S.sunday, church: S.church, config: CONFIG, ...moved });
  S.planView = { ...S.planView, assignments: res.assignments, waitlist: res.waitlist, trips: res.trips, warnings: res.warnings, dirty: true, travelNote: res.travelNote, travelSource: res.travelSource };
}

async function onSubmit(form) {
  const kind = form.dataset.form;
  if (kind === "signin") { const email = new FormData(form).get("email").toString().trim(); await store.signIn(email); S.signInSent = email; return; }
  if (kind === "code") { await store.verifyCode(S.signInSent, new FormData(form).get("code").toString().trim()); S.signInSent = ""; S.session = store.session(); await reload(); return; }
  if (kind === "request") { const f = new FormData(form); await store.requestRide(form.dataset.sunday, { rideHome: f.get("rideHome") === "on", note: (f.get("note") || "").toString().trim() || null, extraPeople: Math.max(0, Math.min(10, Number(f.get("extraPeople")) || 0)), canSplit: f.get("canSplit") === "on" }); await reload(); say("Request sent. We'll confirm your driver after requests close."); return; }
  if (kind === "broadcast") { const f = new FormData(form); S.broadcast = lastMinuteBroadcast(S.sunday, f.get("who").toString().trim(), f.get("where").toString().trim()); return; }
  if (kind === "profile") {
    const leaderEditing = S.me?.role === "leader" && S.editing;
    const raw = readProfile(form);
    if (leaderEditing) {
      const existing = S.editing === "new" ? {} : S.data.profiles.find((p) => p.id === S.editing);
      const patch = await withLocation(raw, existing);
      const id = await store.saveProfile({ ...(existing.id ? { id: existing.id } : {}), ...patch });
      const f = new FormData(form);
      if (S.editing === "new") {
        if (f.get("needsRide") === "on") await store.addRequest(id, S.sunday, { extraPeople: Math.max(0, Math.min(10, Number(f.get("extraPeople")) || 0)), canSplit: f.get("canSplit") === "on" });
        if (f.get("consentByPhone") === "on") await store.giveConsent(CONSENT_WORDING + " (agreed by phone, recorded by the leader)", id);
      }
      S.editing = null; await reload(); say("Saved."); return;
    }
    const registering = !S.me;
    const patch = await withLocation(raw, S.me || {});
    if (!registering) delete patch.role;
    S.me = await store.saveMyProfile(patch);
    if (registering) { S.tab = null; S.regRole = null; }
    await reload(); say(registering ? "You're registered." : "Saved.");
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
}

// ---------------------------------------------------------------- wiring

root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT") return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); guarded(() => fn(el.dataset)); }
});
root.addEventListener("change", (e) => {
  const el = e.target.closest("[data-act-change]");
  if (!el) return;
  const act = el.dataset.actChange;
  if (act === "move") guarded(() => onMove(el));
  if (act === "viewas") guarded(() => actions.viewas({ id: el.value }));
  if (act === "weekly") guarded(async () => { S.me = await store.saveMyProfile({ weeklyCheckin: el.checked }); await reload(); say(el.checked ? "We'll check in with you each week." : "Weekly check-in turned off."); });
});
root.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  guarded(() => onSubmit(form));
});

// ---------------------------------------------------------------- start

(async function boot() {
  render();
  try {
    if (S.mode === "demo") {
      store = createDemoStore();
      S.demoPeople = store.people();
    } else {
      const { createLiveStore } = await import("./store-live.js");
      store = await createLiveStore(CONFIG);
    }
    await store.init(() => guarded(async () => { S.session = store.session(); if (S.session) await reload(); }));
    S.session = store.session();
    if (S.session) await reload();
  } catch (err) {
    console.error(err);
    S.error = `Couldn't start the app: ${err.message}`;
  }
  render();
  if ("serviceWorker" in navigator) { /* intentionally none: the app always loads fresh */ }
})();
