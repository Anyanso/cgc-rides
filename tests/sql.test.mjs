import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Runs supabase/schema.sql in a real in-memory Postgres (PGlite) with Supabase's auth stubbed,
// then checks the privacy and safety rules by acting as different signed-in users.
// It proves the rules in the SQL work; it does not test Supabase's hosted login itself.

const db = new PGlite();
const U = {
  leader: "00000000-0000-0000-0000-00000000000a",
  d1: "00000000-0000-0000-0000-0000000000d1",
  d2: "00000000-0000-0000-0000-0000000000d2",
  r1: "00000000-0000-0000-0000-0000000000f1",
  r2: "00000000-0000-0000-0000-0000000000f2",
};
const P = {}; // profile ids by key

async function as(key, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${U[key]}',false), set_config('request.jwt.claim.email','${key}@example.com',false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;

function sundayInDays(minDays) {
  const d = new Date(Date.now() + minDays * 86400000);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const SUN = sundayInDays(14);
const PAST = "2020-01-05"; // a Sunday long ago
const FAR = sundayInDays(90);

before(async () => {
  await db.exec(readFileSync(new URL("./sql-stubs.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
  for (const [k, id] of Object.entries(U)) await db.query("insert into auth.users (id,email) values ($1,$2)", [id, `${k}@example.com`]);
  // The leader is created the way the README says: from the SQL editor.
  await db.exec(`insert into profiles (user_id,email,full_name,role) select id,email,'Leader','leader' from auth.users where email='leader@example.com'`);
  P.leader = (await q("select id from profiles where user_id=$1", [U.leader]))[0].id;
});

test("schema can be run twice without errors", async () => {
  await db.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
});

test("a new user cannot make themselves leader or clear themselves as a driver", async () => {
  await as("d1", async () => {
    await db.query("insert into profiles (user_id,full_name,role,driver_status,licence_ok,insurance_ok,police_check_expiry,priority,seats,vehicle) values ($1,'Dee One','leader','cleared',true,true,'2030-01-01',true,3,'Blue van')", [U.d1]);
  });
  const [p] = await q("select * from profiles where user_id=$1", [U.d1]);
  P.d1 = p.id;
  assert.equal(p.role, "rider");
  assert.equal(p.driver_status, "none");
  assert.equal(p.licence_ok, false);
  assert.equal(p.priority, false);
  assert.equal(p.police_check_expiry, null);
  assert.equal(p.email, "d1@example.com");

  // Applying to drive makes them pending, still not cleared.
  await as("d1", () => db.query("update profiles set role='driver', driver_status='cleared', licence_ok=true where user_id=$1", [U.d1]));
  const [p2] = await q("select role,driver_status,licence_ok from profiles where id=$1", [P.d1]);
  assert.deepEqual({ ...p2 }, { role: "driver", driver_status: "pending", licence_ok: false });
});

test("setup: more people register; leader clears driver 1", async () => {
  await as("d2", () => db.query("insert into profiles (user_id,full_name,role,seats) values ($1,'Dee Two','driver',2)", [U.d2]));
  await as("r1", () => db.query("insert into profiles (user_id,full_name,phone,home_address,neighbourhood,lat,lng,gender) values ($1,'Rita One','306-555-0101','12 Secret St','Evergreen',52.17,-106.6,'F')", [U.r1]));
  await as("r2", () => db.query("insert into profiles (user_id,full_name,phone,home_address,minor) values ($1,'Ray Two','306-555-0102','99 Other Ave',true)", [U.r2]));
  for (const k of ["d2", "r1", "r2"]) P[k] = (await q("select id from profiles where user_id=$1", [U[k]]))[0].id;
  await as("leader", () => db.query("update profiles set driver_status='cleared', licence_ok=true, insurance_ok=true, police_check_expiry='2030-01-01', seats=3 where id=$1", [P.d1]));
  assert.equal((await q("select driver_status from profiles where id=$1", [P.d1]))[0].driver_status, "cleared");
});

test("people can read only their own profile; anonymous visitors get nothing", async () => {
  assert.equal((await as("r1", () => q("select id from profiles"))).length, 1);
  assert.equal((await as("d1", () => q("select id from profiles"))).length, 1);
  assert.equal((await as("leader", () => q("select id from profiles"))).length, 5);
  await db.exec("set role anon");
  await assert.rejects(() => db.query("select * from profiles"), /permission denied/);
  await db.exec("reset role");
});

test("riders can request an upcoming Sunday but not a past or far-off one", async () => {
  await as("r1", () => db.query("insert into ride_requests (rider_id,sunday,ride_home) values ($1,$2,true)", [P.r1, SUN]));
  await as("r2", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r2, SUN]));
  await assert.rejects(() => as("r1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r1, PAST])), /closed/);
  await assert.rejects(() => as("r1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r1, FAR])), /too far/);
  // and cannot request on someone else's behalf
  await assert.rejects(() => as("r1", () => db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [P.r2, sundayInDays(21)])), /row-level security/);
});

test("the plan cannot be saved with an uncleared driver or too many riders", async () => {
  const a = (r, d, extra = {}) => ({ riderId: P[r], driverId: P[d], trip: 1, order: 0, pickupMin: 620, readyByMin: 615, arriveMin: 690, ...extra });
  await assert.rejects(() => as("leader", () => db.query("select save_plan($1,'draft','{}',$2,'[]')", [SUN, JSON.stringify([a("r1", "d2")])])), /cleared drivers/);
  await db.exec("update profiles set seats=1 where id='" + P.d1 + "'");
  await assert.rejects(() => as("leader", () => db.query("select save_plan($1,'draft','{}',$2,'[]')", [SUN, JSON.stringify([a("r1", "d1"), a("r2", "d1", { order: 1 })])])), /more riders than seats/);
  await db.exec("update profiles set seats=3 where id='" + P.d1 + "'");
  await assert.rejects(() => as("r1", () => db.query("select save_plan($1,'draft','{}','[]','[]')", [SUN])), /Only the transport leader/);
  // nothing was left half-saved by the failed attempts
  assert.equal((await q("select count(*)::int c from assignments"))[0].c, 0);
});

test("before approval nobody but the leader sees any match", async () => {
  const a = (r, order) => ({ riderId: P[r], driverId: P.d1, trip: 1, order, pickupMin: 620 + order * 10, readyByMin: 615, arriveMin: 690 });
  await as("leader", () => db.query("select save_plan($1,'draft','{}',$2,'[]')", [SUN, JSON.stringify([a("r1", 0), a("r2", 1)])]));
  assert.equal((await as("d1", () => q("select * from my_route($1)", [SUN]))).length, 0);
  const mine = await as("r1", () => q("select * from my_rides()"));
  assert.equal(mine[0].status, "requested");
  assert.equal(mine[0].driver_name, null);
});

test("after approval the driver sees their riders' details and the rider sees the driver", async () => {
  await db.exec("update profiles set phone='306-555-0150' where id='" + P.d1 + "'");
  const asg = (r, order) => ({ riderId: P[r], driverId: P.d1, trip: 1, order, pickupMin: 620 + order * 10, readyByMin: 615, arriveMin: 690 });
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,'[]')", [SUN, JSON.stringify([asg("r1", 0), asg("r2", 1)])]));

  const route = await as("d1", () => q("select * from my_route($1)", [SUN]));
  assert.equal(route.length, 2);
  assert.equal(route[0].rider_name, "Rita One");
  assert.equal(route[0].address, "12 Secret St");
  assert.equal(route[0].ride_home, true);
  assert.equal(route[1].minor, true);

  // A different driver sees none of them.
  assert.equal((await as("d2", () => q("select * from my_route($1)", [SUN]))).length, 0);
  // Drivers still can't read rider profiles directly.
  assert.equal((await as("d1", () => q("select id from profiles where id=$1", [P.r1]))).length, 0);

  const mine = await as("r1", () => q("select * from my_rides()"));
  assert.equal(mine[0].status, "seated");
  assert.equal(mine[0].driver_name, "Dee One");
  assert.equal(mine[0].driver_phone, "306-555-0150");
  assert.equal(mine[0].vehicle, "Blue van");
  assert.equal(mine[0].pickup_min, 620);
  // The rider can't read the driver's profile (home address) directly.
  assert.equal((await as("r1", () => q("select id from profiles where id=$1", [P.d1]))).length, 0);
  // Other riders can't see someone else's plan.
  await as("leader", () => db.query("select save_plan($1,'approved','{}',$2,$3)", [SUN, JSON.stringify([asg("r1", 0)]), JSON.stringify([{ riderId: P.r2, reason: "Seats full" }])]));
  const r2 = await as("r2", () => q("select * from my_rides()"));
  assert.equal(r2[0].status, "waitlisted");
  assert.equal(r2[0].driver_name, null);
  assert.equal((await as("r1", () => q("select * from plans"))).length, 0);
  assert.equal((await as("r1", () => q("select * from assignments"))).length, 0);
  assert.equal((await as("r1", () => q("select * from waitlist"))).length, 0);
});

test("a driver's 'I can't make it' marks them unavailable and alerts the leader", async () => {
  const n = await as("d1", () => q("select driver_cant_make_it($1,'Sick') as n", [SUN]));
  assert.equal(n[0].n, 1);
  const wk = await q("select available from driver_weeks where driver_id=$1 and sunday=$2", [P.d1, SUN]);
  assert.equal(wk[0].available, false);
  const alerts = await as("leader", () => q("select * from alerts where kind='driver_cancel'"));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Dee One/);
  assert.equal((await as("r1", () => q("select * from alerts"))).length, 0);
  await assert.rejects(() => as("r1", () => q("select driver_cant_make_it($1)", [SUN])), /Only drivers/);
});

test("a rider with a seat who cancels alerts the leader", async () => {
  await as("r1", () => db.query("update ride_requests set status='cancelled' where rider_id=$1 and sunday=$2", [P.r1, SUN]));
  const alerts = await as("leader", () => q("select * from alerts where kind='rider_cancel'"));
  assert.equal(alerts.length, 1);
  const mine = await as("r1", () => q("select status, driver_name from my_rides()"));
  assert.equal(mine[0].status, "cancelled");
  assert.equal(mine[0].driver_name, null);
});

test("text consent is recorded with a date and wording, and can't be faked by editing the profile", async () => {
  await as("r2", () => db.query("update profiles set texts_consent_at=now() where id=$1", [P.r2]));
  assert.equal((await q("select texts_consent_at from profiles where id=$1", [P.r2]))[0].texts_consent_at, null);
  await as("r2", () => db.query("select give_text_consent('I agree to receive ride texts from Chosen Generation Church.')"));
  const [p] = await q("select texts_consent_at from profiles where id=$1", [P.r2]);
  assert.ok(p.texts_consent_at);
  const log = await as("leader", () => q("select * from consent_log where profile_id=$1", [P.r2]));
  assert.equal(log.length, 1);
  assert.match(log[0].wording, /agree/);
  await assert.rejects(() => as("r1", () => q("select give_text_consent('x',$1)", [P.r2])), /Only the leader/);
  await as("r2", () => db.query("select withdraw_text_consent()"));
  assert.ok((await q("select texts_consent_withdrawn_at from profiles where id=$1", [P.r2]))[0].texts_consent_withdrawn_at);
});

test("the leader can add a rider who phoned in", async () => {
  await as("leader", async () => {
    const [{ id }] = await q("insert into profiles (full_name,phone,home_address,role) values ('Mrs Phoned In','306-555-0110','5 Elm St','rider') returning id");
    await db.query("insert into ride_requests (rider_id,sunday) values ($1,$2)", [id, SUN]);
  });
  assert.equal((await q("select count(*)::int c from profiles where user_id is null"))[0].c, 1);
});
