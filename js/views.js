// Screens. Every function here takes the app state and returns an HTML string, nothing else:
// no network, no clicking. That keeps them testable in Node. Buttons carry data-act="..."
// and app.js listens for them. EVERY piece of user-supplied text goes through esc().

import { isConfirmed } from "./geo.js";
import { fmtDate, fmtMin, isClosed, toMin } from "./dates.js";
import { driverAvailable, DRIVER_STATUS_TEXT, CONSENT_WORDING, daysLeft, isDriver } from "./models.js";
import { driverIssue } from "./matching.js";
import { groupCars } from "./planner.js";
import * as T from "./texts.js";

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const badge = (text, kind = "muted") => `<span class="badge ${kind}">${esc(text)}</span>`;
const banner = (kind, html) => `<div class="banner ${kind}">${html}</div>`;
const attr = (obj) => Object.entries(obj).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
const btn = (label, act, data = {}, kind = "ghost") => `<button class="btn ${kind}" type="button" data-act="${act}" ${attr(data)}>${esc(label)}</button>`;
const telLink = (p) => (p ? `<a href="tel:${esc(String(p).replace(/[^+\d]/g, ""))}">${esc(p)}</a>` : "");
const firstName = (n) => String(n || "").trim().split(/\s+/)[0];

function riderBadges(r) {
  return [
    r.priority && badge("Priority", "gold"),
    r.minor && badge("Under 18", "red"),
    r.rideHome && badge("Ride home too", "muted"),
    r.extraPeople > 0 && badge(`+${r.extraPeople} with them`, "clay"),
    r.extraPeople > 0 && r.canSplit && badge("OK to split", "muted"),
    ("geoSource" in r && !isConfirmed(r)) && badge("Address not confirmed", "red"),
  ].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- shell + entry screens

export function shell(S, inner) {
  const who = S.me ? `<span class="who">${esc(firstName(S.me.name))} · ${esc(S.me.role)}</span>` : "";
  const demo = S.mode === "demo"
    ? `<div class="demobar"><strong>DEMO</strong> · fictional people, nothing is saved. ${
        S.demoPeople ? `<label>View as <select data-act-change="viewas">${S.demoPeople.map((p) =>
          `<option value="${esc(p.id)}" ${S.session?.userId === p.id ? "selected" : ""}>${esc(p.name)} (${esc(p.role)})</option>`).join("")}</select></label>` : ""}</div>`
    : "";
  return `${demo}
  <header class="top">
    <a class="brand" href="#" data-act="home"><img src="assets/logo.png" alt="" width="36" height="36"><span>${esc(S.config.appName)}</span></a>
    <div class="topright">${who}${S.session ? btn("Sign out", "signout", {}, "link") : ""}</div>
  </header>
  <main>${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ""}${S.error ? banner("err", esc(S.error)) : ""}${inner}</main>
  <footer>${esc(S.config.churchName)} · Sunday service ${esc(fmtMin(toMin(S.config.service.time)))}</footer>`;
}

export function landingView(S) {
  return `<section class="hero">
    <img src="assets/logo.png" alt="Chosen Generation Church crown" width="96" height="96">
    <h1>Nobody in this church walks alone — including to the front door.</h1>
    <p class="lede">A ride to church shouldn't be the reason someone misses it. We match riders with drivers who are already headed their way.</p>
    <div class="stack">
      ${S.mode === "demo" ? btn("Try the demo", "demo-start", {}, "primary") : btn("Sign in or sign up", "goto-signin", {}, "primary")}
    </div>
    <ul class="points">
      <li><strong>Need a ride?</strong> Ask once, or every week with a quick check-in.</li>
      <li><strong>Can drive?</strong> Tell us your seats and which Sundays. We only plan around you when you're free.</li>
      <li><strong>Safe by design.</strong> Drivers are checked first, and your address is shared only with your driver.</li>
    </ul>
  </section>`;
}

export function signInView(S) {
  if (S.signInSent) return `<section class="card"><h2>Check your email</h2>
    <p>We sent a message to <strong>${esc(S.signInSent)}</strong>. Either tap the link in it, or type the code from it here (the number in large print). No password needed.</p>
    <form data-form="code" class="stack">
      <label class="field">Code from the email<input name="code" type="text" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,10}" maxlength="11" placeholder="12345678"></label>
      <button class="btn primary" type="submit">Sign in with code</button>
    </form>
    <p class="small muted">Nothing arrived? Check spam. Codes and links last about an hour.</p>
    ${btn("Use a different email", "signin-reset")}</section>`;
  return `<section class="card"><h2>Sign in or sign up</h2>
    <p class="muted">Enter your email and we'll send you a one-time link. New here? The same link creates your account.</p>
    <form data-form="signin" class="stack">
      <label class="field">Email<input name="email" type="email" required autocomplete="email" inputmode="email"></label>
      <button class="btn primary" type="submit">Email me a link</button>
    </form></section>`;
}

export function demoPickerView(S) {
  const group = (role, title) => `<h3>${title}</h3><div class="grid">${S.demoPeople.filter((p) => p.role === role).map((p) =>
    `<button class="card pick" type="button" data-act="viewas" data-id="${esc(p.id)}"><strong>${esc(p.name)}</strong>${p.status && p.status !== "none" ? `<br>${badge(p.status, p.status === "cleared" ? "ok" : "clay")}` : ""}</button>`).join("")}</div>`;
  return `<section><h2>Pick who to view the app as</h2>
    <p class="muted">Every person below is made up. You can switch at any time using the bar at the top.</p>
    ${group("leader", "Transport leader")}${group("driver", "Drivers")}${group("rider", "Riders")}</section>`;
}

// ---------------------------------------------------------------- profile form (all roles)

export function profileForm(S, p0 = {}, { leaderEditing = false, registering = false, addingForSunday = null, leaderSelf = false } = {}) {
  // If saving failed, show what the person typed rather than the old values.
  const draft = S.formDraft ? Object.fromEntries(Object.entries(S.formDraft).filter(([k, v]) => v != null && k !== "picked")) : {};
  const p = { ...p0, ...draft };
  const isDrv = p.role === "driver";
  const req = `<span class="req" aria-hidden="true">*</span>`;
  const confirmed = isConfirmed(p0) && p.address === p0.address;
  const addrStatus = confirmed
    ? `<span class="ok-text">✓ Confirmed on the map${p0.neighbourhood ? ` · ${esc(p0.neighbourhood)}` : ""}</span>`
    : p.address
      ? `<span class="warn-text">Not confirmed yet. Pick your address from the list, or save and we'll check it.</span>`
      : "Start typing your house number and street, then pick your address from the list.";
  const chk = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> <span>${label}</span></label>`;
  const roleChoice = `<input type="hidden" name="role" value="${esc(p.role || "rider")}">`;
  const driverBits = (isDrv || leaderSelf) ? `<fieldset class="field driverbits"><legend>${registering ? "Your car" : "If you drive"}</legend>
      ${leaderSelf ? chk("alsoDrives", p.status === "cleared" && p.seats > 0, "<strong>I also drive</strong> (I'm cleared to drive myself)") : ""}
      <label class="field">Seats free for passengers (not counting you)<input name="seats" type="number" min="0" max="14" value="${esc(p.seats ?? 3)}"></label>
      <label class="field">Vehicle (so riders can spot you)<input name="vehicle" value="${esc(p.vehicle || "")}" placeholder="e.g. Grey SUV"></label>
      ${chk("drivesEveryWeek", p.drivesEveryWeek, "I drive <strong>every</strong> Sunday unless I say otherwise")}
      ${chk("secondTrip", p.secondTrip, "I can do a <strong>second trip</strong> if there are more riders than seats")}
      ${registering ? "" : '<p class="small muted">The transport leader will vet you and approve you before you are given riders.</p>'}
    </fieldset>` : "";
  const leaderBits = leaderEditing ? `<fieldset class="field"><legend>Leader only</legend>
      ${chk("priority", p.priority, "Priority rider (seated first)")}
      ${isDrv ? `<label class="field">Driver status<select name="status">${["pending", "cleared", "suspended"].map((s) => `<option ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <p class="small muted">Set the status to <strong>cleared</strong> once you have vetted this driver. The records below are optional notes for you.</p>${chk("licenceOk", p.licenceOk, "Licence seen (optional note)")}${chk("insuranceOk", p.insuranceOk, "Insurance seen (optional note)")}
      <label class="field">Police check expiry (optional note)<input name="policeCheckExpiry" type="date" value="${esc(p.policeCheckExpiry || "")}"></label>` : ""}
      ${addingForSunday ? chk("needsRide", true, `Needs a ride on ${esc(fmtDate(addingForSunday))}`) + `<label class="field">People coming with them<input name="extraPeople" type="number" min="0" max="10" value="0"></label>` + chk("canSplit", false, "They said it's OK to split across cars") + chk("consentByPhone", false, "They agreed by phone to receive ride texts") : ""}
    </fieldset>` : "";
  return `<form data-form="profile" class="stack" ${p.id ? `data-id="${esc(p.id)}"` : ""}>
    ${roleChoice}
    <p class="small muted">${req} Required</p>
    <label class="field"><span>Full name ${req}</span><input name="name" required value="${esc(p.name || "")}" autocomplete="name"></label>
    <label class="field"><span>Mobile phone ${req}${registering ? ` <span class="small muted">(so ${isDrv ? "riders and the leader" : "your driver"} can reach you)</span>` : ""}</span><input name="phone" type="tel" required inputmode="tel" value="${esc(p.phone || "")}" autocomplete="tel" placeholder="306-555-0142"></label>
    <div class="field addr">
      <label for="addr-input">Home address ${req}</label>
      <input id="addr-input" name="address" required value="${esc(p.address || "")}" autocomplete="off" placeholder="e.g. 1666 Stonebridge Blvd" aria-describedby="addr-status" aria-autocomplete="list" aria-controls="addr-suggest">
      <div class="suggest" id="addr-suggest" role="listbox" hidden></div>
      <p class="small muted addr-status" id="addr-status" aria-live="polite">${addrStatus}</p>
      <input type="hidden" name="pickedAddress" value=""><input type="hidden" name="pickedLat" value=""><input type="hidden" name="pickedLng" value="">
    </div>
    <label class="field"><span>Postal code ${req} <span class="small muted">(filled in when you pick your address)</span></span><input name="postalCode" required value="${esc(p.postalCode || "")}" autocomplete="postal-code" placeholder="S7N 0A1" maxlength="7" style="text-transform:uppercase"></label>
    <input type="hidden" name="neighbourhood" value="${esc(p.neighbourhood || "")}">
    <p class="small muted hood-line">Neighbourhood: <strong class="hood-name">${esc(p.neighbourhood || "filled in from your address")}</strong></p>
    ${registering && isDrv ? "" : chk("minor", p.minor, "This rider is under 18")}
    <label class="field">${isDrv ? "Anything else we should know (optional)" : "Anything the driver should know (optional)"}<input name="notes" value="${esc(p.notes || "")}" placeholder="e.g. uses a walker"></label>
    ${driverBits}${leaderBits}
    <div class="row"><button class="btn primary" type="submit">${registering ? "Finish" : "Save"}</button>${leaderEditing ? btn("Cancel", "edit-cancel") : ""}</div>
  </form>`;
}

export function registerView(S) {
  const email = esc(S.session?.email || "");
  if (!S.regRole) return `<section class="card"><p class="small muted">Step 1 of 2</p><h2>Welcome! What brings you here?</h2>
    <p class="muted">Signed in as ${email}. Pick one. You can ask the transport leader to change it later.</p>
    <div class="stack">
      <button class="card pick" type="button" data-act="reg-role" data-role="rider"><strong>I need a ride to church</strong><br><span class="muted small">We'll match you with a driver each Sunday.</span></button>
      <button class="card pick" type="button" data-act="reg-role" data-role="driver"><strong>I can give rides</strong><br><span class="muted small">I have a car and some free seats.</span></button>
    </div></section>`;
  const driving = S.regRole === "driver";
  return `<section class="card"><p class="small muted">Step 2 of 2</p><h2>${driving ? "Tell us about you and your car" : "Tell us where to pick you up"}</h2>
    <p class="muted">Signed in as ${email}. ${driving ? "The transport leader will check your details and approve you before you are given riders. " : ""}Your address is only shown to the transport leader${driving ? " and to the riders you are given" : " and the driver assigned to you"}.</p>
    ${profileForm(S, { role: S.regRole }, { registering: true })}
    <p class="center">${btn("← Back", "reg-back")}</p></section>`;
}

// ---------------------------------------------------------------- rider

function consentBlock(S) {
  const me = S.me;
  if (me.textsConsentAt) {
    return `<div class="card soft"><strong>Ride texts: on</strong> <span class="small muted">(agreed ${esc(fmtDate(me.textsConsentAt.slice(0, 10), { month: "short", day: "numeric", year: "numeric" }))})</span> ${btn("Stop texts", "consent-off", {}, "link")}</div>`;
  }
  return `<div class="card soft"><strong>Get ride texts?</strong>
    <p class="small">${esc(CONSENT_WORDING)}</p>
    ${btn("Yes, text me about my rides", "consent-on", {}, "primary")}</div>`;
}

export function riderView(S) {
  const me = S.me;
  if (S.tab === "details") return `<section class="card"><h2>My details</h2>${profileForm(S, me)}</section>`;
  const requestForm = (sunday, again) => `<form data-form="request" data-sunday="${esc(sunday)}" class="stack">
            <label class="field">How many people are coming with you? <span class="small muted">(not counting you; each needs a seat)</span>
              <input name="extraPeople" type="number" inputmode="numeric" min="0" max="10" value="0"></label>
            <label class="check"><input type="checkbox" name="canSplit"> <span>It's OK to split us across different cars if no single car has room for everyone</span></label>
            <label class="check"><input type="checkbox" name="rideHome"> <span>I need a ride home too</span></label>
            <label class="field">Note for the leader (optional)<input name="note" placeholder="e.g. bringing a small child"></label>
            <button class="btn primary" type="submit">${again ? "Ask again" : "I need a ride"}</button></form>`;
  const cards = S.sundays.map((sunday) => {
    const rows = S.rides.filter((r) => r.sunday === sunday);
    const ride = rows[0];
    const closed = isClosed(sunday, S.now);
    const party = ride ? 1 + (ride.extraPeople || 0) : 1;
    let body;
    if (!ride || ride.status === "cancelled") {
      body = closed
        ? `<p class="muted">Requests for this Sunday have closed. Please contact the transport leader.</p>`
        : `${requestForm(sunday, !!ride)}${ride ? `<p class="small muted">You cancelled this one.</p>` : ""}`;
    } else if (ride.status === "seated") {
      body = rows.map((r) => `<div class="driver">
          <p><strong>${esc(r.driverName)}</strong> will pick up ${party > 1 ? `${esc(r.seats)} of your group of ${esc(party)}` : "you"}${r.vehicle ? ` in a ${esc(r.vehicle)}` : ""}.</p>
          <p class="bigtime">Around ${esc(fmtMin(r.pickupMin))}</p>
          <p>Please be ready by <strong>${esc(fmtMin(r.readyByMin))}</strong> to avoid delays.</p>
          ${r.driverPhone ? `<p>Driver's number: ${telLink(r.driverPhone)}</p>` : ""}
        </div>`).join("") +
        (ride.waitlistedSeats ? banner("warn", `${esc(ride.waitlistedSeats)} more of your group still need a seat. The transport leader will contact you.`) : "") +
        (ride.rideHome ? `<p class="small muted">You asked for a ride home too. The leader will confirm that separately.</p>` : "") +
        btn("I can't make it", "cancel-ride", { sunday }, "danger");
    } else if (ride.status === "waitlisted") {
      body = `<p>We're still working on ${party > 1 ? "seats for your group" : "a seat for you"}. The transport leader will message you as soon as we have ${party > 1 ? "them" : "one"}.</p>${btn("I can't make it", "cancel-ride", { sunday }, "danger")}`;
    } else {
      body = `<p>${badge("Requested", "gold")} ${party > 1 ? `For ${esc(party)} people. ` : ""}The leader will confirm your driver after requests close (Saturday noon).${party > 1 ? (ride.canSplit ? " You said it's OK to split across cars." : " You asked to stay together; if that isn't possible the leader will ask you.") : ""}</p>${btn("Cancel my request", "cancel-ride", { sunday }, "ghost")}`;
    }
    return `<article class="card"><h3>${esc(fmtDate(sunday, { weekday: "long", month: "long", day: "numeric" }))}</h3>${body}</article>`;
  }).join("");
  return `<section><h2>Hi ${esc(firstName(me.name))}</h2>
    ${!isConfirmed(me) ? banner("warn", `<strong>Please confirm your home address.</strong> We can only arrange a ride once your address is confirmed on the map. ${btn("Confirm my address", "tab", { tab: "details" }, "primary")}`) : ""}
    <label class="check card soft"><input type="checkbox" data-act-change="weekly" ${me.weeklyCheckin ? "checked" : ""}> <span><strong>Check in with me every week.</strong><br><span class="small muted">We'll ask “Do you need a ride this Sunday?” If you don't answer, we won't assume you do.</span></span></label>
    ${cards}${consentBlock(S)}</section>`;
}

// ---------------------------------------------------------------- driver

function mapsLink(S, stops) {
  const c = S.church;
  if (!c || c.lat == null) return "";
  const pts = stops.filter((s) => s.lat != null).map((s) => `${s.lat},${s.lng}`);
  if (!pts.length) return "";
  const q = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${c.lat},${c.lng}&waypoints=${pts.join("%7C")}`;
  return `<a class="btn primary" href="${esc(q)}" target="_blank" rel="noopener">Open route in Google Maps</a>`;
}

export function driverView(S) {
  const me = S.me;
  if (S.tab === "details") return `<section class="card"><h2>My details</h2>${profileForm(S, me)}</section>`;
  const status = me.status === "cleared"
    ? banner("ok", "Cleared to drive.")
    : banner(me.status === "suspended" ? "err" : "warn", esc(DRIVER_STATUS_TEXT[me.status] || DRIVER_STATUS_TEXT.pending) + ".");
  const cards = S.sundays.map((sunday) => {
    const avail = driverAvailable(me, S.weeks, sunday);
    const route = S.routes[sunday] || [];
    const trips = [...new Set(route.map((r) => r.trip))];
    let body = `<p>${avail ? badge("You're driving", "ok") : badge("Not driving", "muted")}
      ${btn(avail ? "I can't drive this Sunday" : "I can drive this Sunday", "toggle-avail", { sunday, to: avail ? "no" : "yes" })}</p>`;
    if (route.length) {
      body += trips.map((t) => {
        const stops = route.filter((r) => r.trip === t);
        const leave = stops[0].departMin;
        return `<div class="route"><h4>${trips.length > 1 ? `Trip ${t}` : "Your pickups"}</h4>
          ${leave != null ? `<p class="leave">Leave ${t > 1 ? "church" : "home"} by <strong>${esc(fmtMin(leave))}</strong></p>` : ""}
          <ol class="stops">${stops.map((s) => `<li>
            <div class="stoptime">${esc(fmtMin(s.pickupMin))}<span class="small muted">ready ${esc(fmtMin(s.readyByMin))}</span></div>
            <div><strong>${esc(s.riderName)}</strong> ${riderBadges({ minor: s.minor, rideHome: s.rideHome })}${s.seats > 1 ? ` ${badge(`${s.seats} people`, "clay")}` : ""}${s.partyTotal > s.seats ? `<br><span class="small">Part of a group of ${esc(s.partyTotal)}; the rest ride with another driver.</span>` : ""}<br>
            ${esc(s.address || "")}${s.neighbourhood ? ` <span class="muted">· ${esc(s.neighbourhood)}</span>` : ""}<br>
            ${telLink(s.riderPhone)}
            ${s.riderNotes ? `<br><em>${esc(s.riderNotes)}</em>` : ""}${s.requestNote ? `<br><em>${esc(s.requestNote)}</em>` : ""}</div></li>`).join("")}</ol>
          <p class="small muted">Aim to arrive at church by ${esc(fmtMin(stops[0].arriveMin))}.</p>${mapsLink(S, stops)}</div>`;
      }).join("") + `<p>${btn("I can't make it", "cant-make-it", { sunday }, "danger")}</p>`;
    } else if (avail) {
      body += `<p class="muted">No riders confirmed yet. You'll see your pickups here once the leader approves the plan.</p>`;
    }
    return `<article class="card"><h3>${esc(fmtDate(sunday, { weekday: "long", month: "long", day: "numeric" }))}</h3>${body}</article>`;
  }).join("");
  return `<section><h2>Hi ${esc(firstName(me.name))}</h2>${status}
    ${!isConfirmed(me) ? banner("warn", `<strong>Please confirm your home address.</strong> You won't be given riders until it's confirmed on the map, because pickup times are worked out from it. ${btn("Confirm my address", "tab", { tab: "details" }, "primary")}`) : ""}
    <p class="small muted">${esc(me.seats)} seat(s)${me.secondTrip ? " · second trip OK" : ""}${me.vehicle ? ` · ${esc(me.vehicle)}` : ""}. Change in My details.</p>${cards}${consentBlock(S)}</section>`;
}

// ---------------------------------------------------------------- leader

function ridersMap(S) { return new Map(S.data.profiles.map((p) => [p.id, p])); }

function carOptions(S, sunday) {
  const weeks = S.data.weeks;
  const out = [];
  for (const d of S.data.profiles.filter(isDriver)) {
    if (driverIssue({ ...d, available: driverAvailable(d, weeks, sunday) }, sunday)) continue;
    out.push({ value: `${d.id}|1`, label: `${d.name} · trip 1`, d, trip: 1 });
    if (d.secondTrip) out.push({ value: `${d.id}|2`, label: `${d.name} · trip 2`, d, trip: 2 });
  }
  return out;
}

function moveSelect(S, riderId, current) {
  const opts = carOptions(S, S.sunday);
  return `<select class="move" data-act-change="move" data-rider="${esc(riderId)}" data-from="${esc(current)}" aria-label="Move rider">
    <option value="">Move to…</option>
    ${opts.filter((o) => o.value !== current).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}
    ${current !== "wait" ? `<option value="wait">Waitlist</option>` : ""}</select>`;
}

function planTab(S) {
  const sunday = S.sunday;
  const people = ridersMap(S);
  const asking = S.data.requests.filter((r) => r.sunday === sunday && r.status !== "cancelled");
  const cars = carOptions(S, sunday);
  const seats = cars.reduce((n, c) => n + c.d.seats, 0);
  const askingPeople = asking.reduce((n, r) => n + 1 + (r.extraPeople || 0), 0);
  const pv = S.planView;
  const chips = S.sundays.map((s) => {
    const n = S.data.requests.filter((r) => r.sunday === s && r.status !== "cancelled").length;
    const st = S.data.plans[s]?.status;
    return `<button type="button" class="chip ${s === sunday ? "on" : ""}" data-act="pick-sunday" data-sunday="${esc(s)}">${esc(fmtDate(s))}<small>${n} asking${st ? ` · ${st}` : ""}</small></button>`;
  }).join("");

  let html = `<div class="chips">${chips}</div>`;
  if (S.churchWarning) html += banner("warn", `<strong>Church location not set.</strong> ${esc(S.churchWarning)}`);
  else if (S.churchFound && S.mode !== "demo") {
    const f = S.churchFound;
    const map = `<a href="https://www.openstreetmap.org/?mlat=${esc(f.lat)}&mlon=${esc(f.lng)}#map=18/${esc(f.lat)}/${esc(f.lng)}" target="_blank" rel="noopener">check on the map</a>`;
    html += f.pinned
      ? `<p class="small muted">Times are worked out to the church's pinned location (${map}).</p>`
      : banner("info", `<strong>Church location:</strong> ${esc(f.address)}${f.postcode ? `, ${esc(f.postcode)}` : ""} (${map}). Pickup times are worked back from this point. If the pin isn't at the church, put the exact latitude and longitude in js/config.js.`);
  }
  html += `<p class="small muted">Times use real road times plus a ${esc(S.config.matching.trafficPct ?? 20)}% safety margin and ${esc(S.config.matching.legBufferMin ?? 1)} min per drive, ${esc(S.config.matching.stopMin)} min at each house, arriving ${esc(S.config.service.arriveBeforeMin)} min before the service.</p>`;
  if (S.mode === "demo") html += banner("info", `Demo plans use a placeholder church location (${esc(S.demoChurchLabel)}).`);
  html += `<div class="tiles"><div class="tile"><b>${askingPeople}</b>people asking</div><div class="tile"><b>${seats}</b>seats offered</div>
    <div class="tile"><b>${pv?.assignments.reduce((n, a) => n + (a.seats ?? 1), 0) ?? 0}</b>seated</div><div class="tile"><b>${pv?.waitlist.reduce((n, w) => n + (w.seats ?? 1), 0) ?? 0}</b>waiting</div></div>`;
  if (askingPeople > seats) html += banner("warn", `${askingPeople} people are asking (counting those coming with riders) but only ${seats} seats are offered. Ask drivers about a second trip, or recruit another driver.`);

  const status = !pv ? badge("No plan yet", "muted") : pv.status === "approved" ? badge(pv.dirty ? "Approved · changes not saved" : "Approved and shared", "ok") : badge(pv.dirty ? "Draft · not saved" : "Draft saved", "gold");
  const placed = new Set(pv ? [...pv.assignments.map((a) => a.riderId), ...pv.waitlist.map((w) => w.riderId)] : []);
  const newcomers = pv ? asking.filter((r) => !placed.has(r.riderId)) : [];
  const open = !!(S.planOpen && pv);
  const seatedN = pv ? pv.assignments.reduce((n, a) => n + (a.seats ?? 1), 0) : 0;
  const waitingN = pv ? pv.waitlist.reduce((n, w) => n + (w.seats ?? 1), 0) : 0;
  const carsN = pv ? new Set(pv.assignments.map((a) => `${a.driverId}|${a.trip}`)).size : 0;
  // The plan follows the requests automatically (see autoUpdatePlan in app.js); this says what changed.
  const newcomerBanner = pv?.autoNote
    ? banner("info", `<strong>Updated automatically.</strong> ${esc(pv.autoNote)} Not saved or shared yet: view it, then save a draft or approve.`)
    : newcomers.length
      ? banner("info", `${newcomers.length} new request${newcomers.length > 1 ? "s" : ""} (${newcomers.map((r) => esc(people.get(r.riderId)?.name || "Rider")).join(", ")}) will be added to the plan automatically.`)
      : "";

  html += `<div class="row wrap">${status}${S.busy ? `<span class="small muted">Working…</span>` : ""}</div>
    <div class="row wrap">${open ? btn("Hide the plan", "hide-plan") : btn(pv ? "View the plan" : "Make and view the plan", "view-plan", {}, "primary")}</div>
    <p class="small muted">Requests close Saturday at noon${isClosed(sunday, S.now) ? " (closed)" : ""}. Nothing reaches drivers and riders until you approve.</p>`;

  if (!open) {
    if (!pv) {
      html += `<h3>Asking for a ride (${asking.length})</h3><ul class="plain">${asking.map((r) => { const p = people.get(r.riderId); return p ? `<li><strong>${esc(p.name)}</strong> ${esc(p.neighbourhood || "")} ${riderBadges({ ...p, rideHome: r.rideHome, extraPeople: r.extraPeople, canSplit: r.canSplit })}${r.note ? `<br><span class="small muted">${esc(r.note)}</span>` : ""}</li>` : ""; }).join("") || "<li class='muted'>Nobody yet.</li>"}</ul>`;
    } else {
      html += `<p>${seatedN} seated in ${carsN} car${carsN === 1 ? "" : "s"}${waitingN ? `, ${waitingN} on the waiting list` : ""}. Tap <strong>View the plan</strong> to see the cars, make changes and approve.</p>${newcomerBanner}`;
    }
    return html;
  }

  html += `<section class="planbox" aria-label="The plan for ${esc(fmtDate(sunday))}">${newcomerBanner}`;
  if (pv.travelNote) html += banner("warn", esc(pv.travelNote));
  else if (pv.travelSource === "estimate" && !S.config.routing.enabled) html += banner("info", "Using straight-line estimates (road routing is switched off in settings).");
  if (pv.warnings?.length) html += banner("warn", `<strong>Check these:</strong><ul>${pv.warnings.map((w) => `<li>${esc(w.text)}</li>`).join("")}</ul>`);
  html += `<p class="small muted">Leave it as it is, or use <strong>Move to…</strong> under anyone to put them in another car or on the waiting list. Times update as you go.</p>`;

  const cardsData = groupCars(pv.assignments, S.data.profiles);
  const tripMeta = new Map((pv.trips || []).map((t) => [`${t.driverId}|${t.trip}`, t]));
  html += cardsData.map((car) => {
    const d = people.get(car.driverId);
    const meta = tripMeta.get(`${car.driverId}|${car.trip}`);
    return `<article class="card car"><header><h3>${esc(d?.name || "Driver")}${car.trip > 1 ? " · trip 2" : ""}</h3>
      <span class="small muted">${car.stops.length}/${esc(d?.seats ?? "?")} seats${d?.vehicle ? ` · ${esc(d.vehicle)}` : ""}${meta ? ` · leaves ${esc(fmtMin(meta.departMin))} · arrives ${esc(fmtMin(meta.arriveMin))}` : car.stops[0]?.departMin != null ? ` · leaves ${esc(fmtMin(car.stops[0].departMin))} · arrives ${esc(fmtMin(car.stops[0].arriveMin))}` : ""}</span></header>
      <ol class="stops">${car.stops.map((s) => { const r = people.get(s.riderId); return `<li><div class="stoptime">${esc(fmtMin(s.pickupMin))}<span class="small muted">ready ${esc(fmtMin(s.readyByMin))}</span></div>
        <div><strong>${esc(r?.name || "Rider")}</strong> ${riderBadges({ ...(r || {}), rideHome: asking.find((q) => q.riderId === s.riderId)?.rideHome, extraPeople: asking.find((q) => q.riderId === s.riderId)?.extraPeople, canSplit: asking.find((q) => q.riderId === s.riderId)?.canSplit })}${s.seats > 1 ? ` ${badge(`${s.seats} seats`, "gold")}` : ""}<br><span class="small">${esc(r?.address || "")}${r?.neighbourhood ? ` · ${esc(r.neighbourhood)}` : ""}</span>${asking.find((q) => q.riderId === s.riderId)?.note ? `<br><em class="small">${esc(asking.find((q) => q.riderId === s.riderId).note)}</em>` : ""}<br>${moveSelect(S, s.riderId, `${car.driverId}|${car.trip}`)}</div></li>`; }).join("")}</ol></article>`;
  }).join("") || `<p class="muted">Nobody is seated yet.</p>`;

  if (pv.waitlist.length) {
    html += `<h3>Waiting list (${pv.waitlist.length})</h3>` + pv.waitlist.map((w) => {
      const r = people.get(w.riderId);
      const q = asking.find((x) => x.riderId === w.riderId);
      return `<article class="card warn"><strong>${esc(r?.name || "Rider")}</strong> ${r ? riderBadges({ ...r, extraPeople: q?.extraPeople, canSplit: q?.canSplit }) : ""} ${w.seats > 1 ? badge(`needs ${w.seats} seats`, "gold") : ""}<p class="small">${esc(w.reason)}</p>${q?.note ? `<p class="small"><em>${esc(q.note)}</em></p>` : ""}
        ${w.seats > 1 && q && !q.canSplit ? `<p class="small">${btn("They agree to be split across cars", "split-ok", { rider: w.riderId }, "primary")}</p>` : ""}${moveSelect(S, w.riderId, "wait")}</article>`;
    }).join("");
  }
  if (pv.excluded?.length) {
    html += `<details class="card soft"><summary>${pv.excluded.length} driver(s) not driving this Sunday</summary><ul class="plain">${pv.excluded.map((e) => `<li><strong>${esc(e.name)}</strong>: ${esc(e.reason)}</li>`).join("")}</ul></details>`;
  }

  // Save draft sits beside Approve & share, under the plan. Save draft is only active after a change.
  const approvedClean = pv.status === "approved" && !pv.dirty;
  const saveBtn = `<button class="btn ghost" type="button" data-act="save-draft" ${pv.dirty ? "" : "disabled"}>Save draft</button>`;
  const approveBtn = approvedClean
    ? `<button class="btn primary" type="button" disabled>Approved and shared ✓</button>`
    : btn(pv.status === "approved" ? "Approve & share changes" : "Approve & share", "approve", {}, "primary");
  const hint = approvedClean
    ? "Drivers and riders can see this plan. Change anything above and you can share the update."
    : pv.dirty
      ? "You have changes that aren't saved. Save them as a draft for later, or approve to share them now."
      : "No changes since it was saved. Approve to share it with drivers and riders, or change something above.";
  html += `<div class="planactions"><div class="row wrap">${saveBtn}${approveBtn}</div><p class="small muted">${hint}</p></div>
    <p class="small muted">Starting from scratch? ${btn("Start the plan over", "draft", {}, "link")}</p></section>`;
  return html;
}

function peopleTab(S) {
  if (S.editing) {
    const p = S.editing === "new" ? { role: "rider" } : S.data.profiles.find((x) => x.id === S.editing);
    return `<section class="card"><h2>${S.editing === "new" ? "Add a rider who phoned in" : esc(p.name)}</h2>${profileForm(S, p, { leaderEditing: true, addingForSunday: S.editing === "new" ? S.sunday : null })}
      ${S.editing !== "new" && p.role !== "leader" ? `<hr><h3>Remove ${esc(firstName(p.name))}</h3><p class="small muted">Deletes this person with their requests, availability and rides (for example a test name). Any plan they are in goes back to a draft so you can redo it. This cannot be undone.</p>${btn("Remove " + firstName(p.name), "remove-person", { id: p.id })}` : ""}</section>`;
  }
  const drivers = S.data.profiles.filter((p) => isDriver(p) || (p.role === "driver"));
  const riders = S.data.profiles.filter((p) => p.role === "rider");
  const dRow = (d) => {
    const left = daysLeft(d.policeCheckExpiry, S.todayISO);
    const st = d.status === "cleared" ? badge("Cleared", "ok") : badge(d.status === "pending" ? "Needs your approval" : d.status, d.status === "pending" ? "clay" : "red");
    const checkNote = d.policeCheckExpiry ? `check ${left != null && left < 0 ? "EXPIRED " : "to "}${esc(d.policeCheckExpiry)}` : "no check date noted";
    return `<li class="personrow"><div><strong>${esc(d.name)}</strong> ${st}<br><span class="small muted">${esc(d.seats)} seats · ${esc(d.neighbourhood || "no area")} · ${checkNote} · licence ${d.licenceOk ? "✓" : "–"} · insurance ${d.insuranceOk ? "✓" : "–"}</span></div>${btn("Edit / review", "edit", { id: d.id })}</li>`;
  };
  const rRow = (r) => `<li class="personrow"><div><strong>${esc(r.name)}</strong> ${riderBadges(r)}<br><span class="small muted">${esc(r.neighbourhood || "")} · ${r.textsConsentAt ? "texts OK" : "no text consent"}${r.weeklyCheckin ? " · weekly check-in" : ""}</span></div>${btn("Edit", "edit", { id: r.id })}</li>`;
  return `<div class="row wrap">${btn("Add a rider who phoned in", "edit", { id: "new" }, "primary")}</div>
    <h3>Drivers (${drivers.length})</h3><ul class="plain">${drivers.map(dRow).join("") || "<li class='muted'>No drivers yet.</li>"}</ul>
    <h3>Riders (${riders.length})</h3><ul class="plain">${riders.map(rRow).join("") || "<li class='muted'>No riders yet.</li>"}</ul>
    <h3>Keep a copy</h3>
    <article class="card"><p class="small muted">Save a copy of your people and plans in case anything is ever lost. The files contain addresses and phone numbers, so keep them private (for example in your own Google Drive, not shared).</p>
    <div class="row wrap">${btn("Download people list (spreadsheet)", "export-people", {}, "primary")}${btn("Download full backup", "export-backup")}</div></article>`;
}

function alertsTab(S) {
  const open = S.data.alerts.filter((a) => !a.resolved);
  const done = S.data.alerts.filter((a) => a.resolved);
  const row = (a) => `<article class="card ${a.resolved ? "soft" : "warn"}"><p>${esc(a.message)}</p>
    ${a.resolved ? "" : `<div class="row wrap">${a.kind === "driver_cancel" ? btn("Reassign their riders", "reassign", { driver: a.driverId, sunday: a.sunday, alert: a.id }, "primary") : ""}${btn("Mark done", "resolve", { id: a.id })}</div>`}</article>`;
  return `<h3>Needs attention (${open.length})</h3>${open.map(row).join("") || "<p class='muted'>Nothing right now.</p>"}
    ${done.length ? `<details><summary>${done.length} done</summary>${done.slice(0, 20).map(row).join("")}</details>` : ""}`;
}

function copyBlock(label, text, note = "") {
  return `<article class="card"><strong>${esc(label)}</strong>${note ? `<p class="small muted">${esc(note)}</p>` : ""}<pre class="msg">${esc(text)}</pre>${btn("Copy", "copy", { text }, "primary")}</article>`;
}

function textsTab(S) {
  const sunday = S.sunday;
  const plan = S.data.plans[sunday];
  const people = ridersMap(S);
  const approved = plan?.status === "approved";
  const chips = S.sundays.map((s) => `<button type="button" class="chip ${s === sunday ? "on" : ""}" data-act="pick-sunday" data-sunday="${esc(s)}">${esc(fmtDate(s))}</button>`).join("");
  const url = S.appUrl || "";
  let html = `<div class="chips">${chips}</div>
    <p class="small muted">Nothing is sent from here. Copy a message and paste it into the group chat or a text. Group messages never include addresses. The driver messages below do, so send each one to that driver only. Only text people who agreed to texts.</p>`;
  html += `<h3>Invitation</h3>`;
  html += copyBlock("Invite people with a car to join the driving team", T.inviteDrivers(url), "For the church group chat or one-to-one. Has no personal details. New drivers are approved by you before they get riders.");
  html += `<h3>Every week</h3>`;
  html += copyBlock("Weekly check-in (Thursday, to the group)", T.weeklyCheckin(sunday, url), "Opt-in riders only. Silence means no ride.");
  html += copyBlock("Saturday reminder (to the group)", T.reminder(sunday));
  if (approved) {
    const asg = plan.assignments;
    html += `<h3>Ride details to each rider</h3>`;
    for (const a of asg) {
      const r = people.get(a.riderId); const d = people.get(a.driverId);
      if (!r || !d) continue;
      html += copyBlock(`${r.name}${r.textsConsentAt ? "" : " (no text consent: call instead)"}`, T.riderDetails(sunday, r, d, a, (S.data.requests.find((q) => q.riderId === r.id && q.sunday === sunday)?.extraPeople || 0) + 1), `${r.phone || "no phone on file"}`);
    }
    html += `<h3>Pickup list to each driver</h3>`;
    const cars = groupCars(asg, S.data.profiles);
    for (const did of [...new Set(cars.map((c) => c.driverId))]) {
      const d = people.get(did);
      html += copyBlock(d.name, T.driverRoute(sunday, d, cars.filter((c) => c.driverId === did), people, new Map(S.data.requests.filter((q) => q.sunday === sunday).map((q) => [q.riderId, (q.extraPeople || 0) + 1]))), (d.phone || "no phone on file") + ". Send to this driver only. It has addresses and phone numbers.");
    }
    for (const w of plan.waitlist) {
      const r = people.get(w.riderId);
      if (r) html += copyBlock(`${r.name}: still waiting for a seat`, T.waitlisted(sunday, r), r.phone || "");
    }
  } else {
    html += banner("info", "Approve the plan to see each rider's and driver's message.");
  }
  html += `<article class="card"><strong>Last-minute: ask drivers for help</strong>
    <form data-form="broadcast" class="stack"><label class="field">Rider's first name<input name="who" required></label>
    <label class="field">Neighbourhood<input name="where"></label><button class="btn primary" type="submit">Write message</button></form>
    ${S.broadcast ? `<pre class="msg">${esc(S.broadcast)}</pre>${btn("Copy", "copy", { text: S.broadcast }, "primary")}` : ""}</article>`;
  return html;
}

function drivingTab(S) {
  const drives = isDriver(S.me);
  return `<details class="card soft" ${drives ? "" : "open"}><summary>${drives ? "My driving details" : "Do you drive too? Set it up here"}</summary>
    <p class="small muted">Leaders can drive as well. You clear yourself, then you appear as a driver in the plan.</p>${profileForm(S, S.me, { leaderSelf: true })}</details>${drives ? driverView(S) : ""}`;
}

export function leaderView(S) {
  const openAlerts = S.data.alerts.filter((a) => !a.resolved).length;
  const tabs = [["plan", "Plan"], ["people", "People"], ["alerts", `Alerts${openAlerts ? ` (${openAlerts})` : ""}`], ["texts", "Texts"], ["driving", "My driving"]];
  const body = { plan: planTab, people: peopleTab, alerts: alertsTab, texts: textsTab, driving: drivingTab }[S.tab] || planTab;
  return `<nav class="tabs">${tabs.map(([k, l]) => `<button type="button" class="${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${esc(l)}</button>`).join("")}</nav>${body(S)}`;
}

export function tabsFor(S, tabs) {
  return `<nav class="tabs">${tabs.map(([k, l]) => `<button type="button" class="${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${esc(l)}</button>`).join("")}</nav>`;
}

export function roleView(S) {
  if (!S.me) return registerView(S);
  if (S.me.role === "leader") return leaderView(S);
  if (S.me.role === "driver") return tabsFor(S, [["sundays", "My Sundays"], ["details", "My details"]]) + driverView(S);
  return tabsFor(S, [["rides", "Rides"], ["details", "My details"]]) + riderView(S);
}
