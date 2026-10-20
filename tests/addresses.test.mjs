import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, normalizePostal, houseNumberOf, suggestAddresses, confirmAddress, isConfirmed } from "../js/geo.js";
import { draftPlan, withMargin } from "../js/planner.js";
import { CONFIG } from "../js/config.js";

// Sample answers in the documented Photon / Nominatim formats. These check our reading of
// them; they do NOT prove the real services answer exactly like this.
const reply = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

test("phone numbers are required to be 10 Canadian digits and are tidied", () => {
  assert.equal(normalizePhone("(306) 555-0142"), "306-555-0142");
  assert.equal(normalizePhone("+1 306 555 0142"), "306-555-0142");
  assert.equal(normalizePhone("555-0142"), null);
  assert.equal(normalizePhone("abc"), null);
});

test("postal codes must look like S7N 0A1 and are tidied", () => {
  assert.equal(normalizePostal("s7t0j1"), "S7T 0J1");
  assert.equal(normalizePostal("S7T-0J1"), "S7T 0J1");
  assert.equal(normalizePostal("D7T 0J1"), null);
  assert.equal(normalizePostal("S7T 0J"), null);
});

test("house numbers are read from the start of an address, including unit-house", () => {
  assert.equal(houseNumberOf("1666 Stonebridge Blvd"), "1666");
  assert.equal(houseNumberOf("12-345 Main St"), "345");
  assert.equal(houseNumberOf("Stonebridge Blvd"), null);
});

test("suggestions keep only exact houses inside Saskatoon, with postal code and neighbourhood", async () => {
  const photon = { features: [
    { geometry: { coordinates: [-106.6213, 52.0895] }, properties: { housenumber: "1666", street: "Stonebridge Boulevard", postcode: "s7t0j1", district: "Stonebridge", countrycode: "CA" } },
    { geometry: { coordinates: [-106.62, 52.09] }, properties: { street: "Stonebridge Boulevard", countrycode: "CA" } },                      // street only: dropped
    { geometry: { coordinates: [-104.6, 50.45] }, properties: { housenumber: "1666", street: "Albert St", countrycode: "CA" } },            // Regina: dropped
  ] };
  const list = await suggestAddresses("1666 Stonebridge", { fetchFn: reply(photon) });
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], label: undefined }, { address: "1666 Stonebridge Boulevard", label: undefined, postcode: "S7T 0J1", neighbourhood: "Stonebridge", lat: 52.0895, lng: -106.6213 });
  assert.deepEqual(await suggestAddresses("Stonebridge", { fetchFn: reply(photon) }), [], "no house number typed yet: no lookups");
  assert.deepEqual(await suggestAddresses("1666 Stonebridge", { fetchFn: async () => { throw new Error("offline"); } }), []);
});

test("an address is confirmed only when that exact house number is found", async () => {
  const hit = (house) => [{ lat: "52.0895", lon: "-106.6213", address: { house_number: house, road: "Stonebridge Boulevard", suburb: "Stonebridge", postcode: "S7T 0J1" } }];
  const ok = await confirmAddress("1666 Stonebridge Blvd", { fetchFn: reply(hit("1666")) });
  assert.equal(ok.ok, true);
  assert.equal(ok.address, "1666 Stonebridge Boulevard");
  assert.equal(ok.postcode, "S7T 0J1");
  assert.equal(ok.neighbourhood, "Stonebridge");

  const wrong = await confirmAddress("1666 Stonebridge Blvd", { fetchFn: reply(hit("1660")) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /not house number 1666/);

  const street = await confirmAddress("1666 Stonebridge Blvd", { fetchFn: reply([{ lat: "52.09", lon: "-106.62", address: { road: "Stonebridge Boulevard" } }]) });
  assert.equal(street.ok, false, "a street with no house is never good enough");

  const none = await confirmAddress("1666 Nowhere Rd", { fetchFn: reply([]) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /couldn't find/);

  const noNumber = await confirmAddress("College Drive", { fetchFn: reply(hit("1")) });
  assert.match(noNumber.reason, /house number/);
});

test("Jo's case: an unconfirmed or approximate address is never matched or timed", async () => {
  const church = { lat: 52.13, lng: -106.66 };
  const sunday = "2026-10-25";
  const driver = { id: "d1", name: "Dee", role: "driver", status: "cleared", seats: 3, drivesEveryWeek: true, lat: 52.09, lng: -106.62, geoSource: "verified" };
  const jo = { id: "jo", name: "Jo", role: "rider", lat: 52.0872, lng: -106.6244, geoSource: "neighbourhood", address: "1666" };   // guessed from the neighbourhood
  const ana = { id: "ana", name: "Ana", role: "rider", lat: 52.095, lng: -106.63, geoSource: "verified", address: "12 Real St" };
  const data = {
    profiles: [driver, jo, ana], weeks: [],
    requests: [{ riderId: "jo", sunday, status: "requested" }, { riderId: "ana", sunday, status: "requested" }],
  };
  const p = await draftPlan({ data, sunday, church, config: CONFIG, fetchFn: async () => { throw new Error("offline"); } });
  assert.ok(!p.assignments.some((a) => a.riderId === "jo"), "Jo must not be seated");
  assert.match(p.waitlist.find((w) => w.riderId === "jo").reason, /not confirmed/);
  assert.ok(p.assignments.some((a) => a.riderId === "ana"));

  const unconfirmedDriver = { ...driver, geoSource: "address" }; // old, unchecked lookup
  const p2 = await draftPlan({ data: { ...data, profiles: [unconfirmedDriver, ana] }, sunday, church, config: CONFIG, fetchFn: async () => { throw new Error("offline"); } });
  assert.equal(p2.assignments.length, 0);
  assert.match(p2.excludedDrivers[0].reason, /not confirmed/);
  assert.equal(isConfirmed(ana), true);
  assert.equal(isConfirmed(jo), false);
});

test("drive times get a safety margin; bigger when real road times are unavailable", () => {
  const raw = () => 10;
  const a = { id: "a" }, b = { id: "b" };
  assert.equal(withMargin(raw, "osrm", { trafficPct: 20, legBufferMin: 1 })(a, b), 13);
  assert.equal(withMargin(raw, "estimate", { estimatePct: 40, legBufferMin: 1 })(a, b), 15);
  assert.equal(withMargin(raw, "osrm", {})(a, a), 0);
});

test("every seated rider carries the driver's leave time, which is before the first pickup", async () => {
  const church = { lat: 52.13, lng: -106.66 };
  const sunday = "2026-10-25";
  const driver = { id: "d1", name: "Dee", role: "driver", status: "cleared", seats: 3, drivesEveryWeek: true, lat: 52.09, lng: -106.62, geoSource: "verified" };
  const riders = [
    { id: "r1", name: "One", role: "rider", lat: 52.095, lng: -106.63, geoSource: "verified" },
    { id: "r2", name: "Two", role: "rider", lat: 52.105, lng: -106.64, geoSource: "verified" },
  ];
  const data = { profiles: [driver, ...riders], weeks: [], requests: riders.map((r) => ({ riderId: r.id, sunday, status: "requested" })) };
  const p = await draftPlan({ data, sunday, church, config: CONFIG, fetchFn: async () => { throw new Error("offline"); } });
  assert.equal(p.assignments.length, 2);
  const first = Math.min(...p.assignments.map((a) => a.pickupMin));
  for (const a of p.assignments) {
    assert.equal(typeof a.departMin, "number");
    assert.ok(a.departMin <= first, "driver leaves before the first pickup");
    assert.ok(a.arriveMin > Math.max(...p.assignments.map((x) => x.pickupMin)));
  }
});

test("suggestions on screen narrow instantly as typing continues (no network)", async () => {
  const { refineSuggestions } = await import("../js/geo.js");
  const L = [{ address: "1666 Stonebridge Boulevard" }, { address: "1666 Stonehenge Way" }, { address: "166 Main Street" }];
  assert.deepEqual(refineSuggestions(L, "1666 stoneb").map((s) => s.address), ["1666 Stonebridge Boulevard"]);
  assert.deepEqual(refineSuggestions(L, "1666 Stonebridge Blvd").map((s) => s.address), ["1666 Stonebridge Boulevard"]);
  assert.deepEqual(refineSuggestions(L, "1666 stonebridge bou").map((s) => s.address), ["1666 Stonebridge Boulevard"]);
  assert.deepEqual(refineSuggestions(L, "166 main st").map((s) => s.address), ["166 Main Street"]);
  assert.deepEqual(refineSuggestions(L, "1666 x"), []);
});

test("an outdated search can be cancelled", async () => {
  let seen;
  const ctl = new AbortController();
  await suggestAddresses("1666 Stonebridge", { signal: ctl.signal, fetchFn: async (_u, opts) => { seen = opts.signal; return { ok: true, json: async () => ({ features: [] }) }; } });
  assert.equal(seen, ctl.signal);
});

test("the driver's message says how many people and when to leave home", async () => {
  const { driverRoute } = await import("../js/texts.js");
  const cars = [{ trip: 1, stops: [{ riderId: "jo", pickupMin: 665, seats: 1, departMin: 650, arriveMin: 690 }] }];
  const riders = new Map([["jo", { name: "Jo", address: "639 Addie Crescent", neighbourhood: "Forest Grove", phone: "306-370-9965" }]]);
  const msg = driverRoute("2026-10-25", { name: "Dami" }, cars, riders);
  assert.match(msg, /You have 1 person to pick up\./);
  assert.match(msg, /Please leave home by 10:50 AM to reach church by 11:30 AM/);
  assert.match(msg, /11:05 AM {2}Jo, 639 Addie Crescent \(Forest Grove\), 306-370-9965/);
});

test("last-minute help ranks cleared, confirmed drivers; drivers not yet cleared are never offered", async () => {
  const { rankHelpers } = await import("../js/planner.js");
  const church = { lat: 52.1196, lng: -106.6592 };
  const sunday = "2026-10-25";
  const d = (id, lat, lng, extra = {}) => ({ id, name: id, role: "driver", status: "cleared", seats: 3, drivesEveryWeek: true, lat, lng, geoSource: "verified", ...extra });
  const data = {
    weeks: [],
    profiles: [
      d("near", 52.1006, -106.6211), d("far", 52.175, -106.59),
      d("pending", 52.1007, -106.6212, { status: "pending" }),
      d("unconfirmed", 52.1007, -106.6212, { geoSource: "address" }),
    ],
  };
  const jo = { name: "Jo", lat: 52.1005, lng: -106.621, geoSource: "verified" };
  const r = await rankHelpers({ data, sunday, church, config: CONFIG, rider: jo, seats: 1, fetchFn: async () => { throw new Error("offline"); } });
  assert.deepEqual(r.list.map((x) => x.driver.id), ["near", "far"]);
  assert.ok(r.list[0].awayMin < r.list[1].awayMin);
  assert.equal(typeof r.pickupMin, "number");
  await assert.rejects(rankHelpers({ data, sunday, church, config: CONFIG, rider: { ...jo, geoSource: "neighbourhood" } }), /isn't confirmed/);
});

test("a driver whose rider cancelled and rebooked gets an apology in their pickup list", async () => {
  const { driverRoute } = await import("../js/texts.js");
  const cars = [{ trip: 1, stops: [{ riderId: "jo", pickupMin: 665, seats: 1, departMin: 650, arriveMin: 690 }] }];
  const riders = new Map([["jo", { name: "Jo", address: "639 Addie Crescent", neighbourhood: "Forest Grove", phone: "306-370-9965" }]]);
  const msg = driverRoute("2026-10-25", { name: "Dami" }, cars, riders, new Map(), { rebooked: ["Jo"] });
  assert.match(msg.split("\n")[1], /^Sorry for the back-and-forth: Jo is coming after all, so they're back on your list\.$/);
});

test("services: a joint service changes times and labels; a special weekday service asks drivers rather than assuming", async () => {
  const S = await import("../js/services.js");
  const { driverAvailable } = await import("../js/models.js");
  const { driverRoute, serviceAnnouncement, weeklyCheckin } = await import("../js/texts.js");
  S.setServices([
    { date: "2026-12-27", title: "Joint service", time: "10:00", arriveBeforeMin: 15, cutoff: null, cancelled: false, note: "" },
    { date: "2026-12-24", title: "Christmas Eve service", time: "19:00", arriveBeforeMin: 20, cutoff: null, cancelled: false, note: "" },
    { date: "2027-01-03", title: "", time: "11:45", arriveBeforeMin: 15, cutoff: null, cancelled: true, note: "" },
  ]);
  assert.equal(S.serviceFor("2026-12-20").title, "Sunday service");
  assert.equal(S.serviceFor("2026-12-27").time, "10:00");
  assert.equal(S.configFor("2026-12-27").service.time, "10:00");
  assert.equal(S.configFor("2026-12-27").matching.earliestPickup, "07:45", "an early service allows earlier pickups");
  assert.equal(S.dayLabel("2026-12-24"), "Christmas Eve service, Thu, Dec 24");
  assert.equal(S.cutoffLabel("2026-12-24"), "Wednesday at noon");
  assert.ok(S.upcomingDays(4, new Date(2026, 11, 1)).includes("2026-12-24"));
  assert.equal(S.serviceFor("2027-01-03").cancelled, true);

  const every = { id: "d", drivesEveryWeek: true };
  assert.equal(driverAvailable(every, [], "2026-12-27"), true, "every-week drivers count for a Sunday");
  assert.equal(driverAvailable(every, [], "2026-12-24"), false, "...but are asked for a weekday special service");
  assert.equal(driverAvailable(every, [{ driverId: "d", sunday: "2026-12-24", available: true }], "2026-12-24"), true);

  const msg = driverRoute("2026-12-27", { name: "Dami" }, [{ trip: 1, stops: [{ riderId: "jo", pickupMin: 545, seats: 1, departMin: 530, arriveMin: 585 }] }], new Map([["jo", { name: "Jo", address: "1 A St" }]]));
  assert.match(msg, /driving on Joint service, Sun, Dec 27/);
  assert.match(msg, /service is at 10:00 AM/);
  assert.match(serviceAnnouncement("2026-12-27"), /Joint service at 10:00 AM \(not the usual 11:45 AM\)/);
  assert.match(serviceAnnouncement("2026-12-24"), /Christmas Eve service on Thursday, December 24 at 7:00 PM/);
  assert.match(serviceAnnouncement("2027-01-03"), /no service on Sunday, January 3/);
  assert.match(weeklyCheckin("2026-12-27"), /to the Joint service \(Sun, Dec 27, 10:00 AM\)/);
  S.setServices([]);
});
