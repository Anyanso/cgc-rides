import test from "node:test";
import assert from "node:assert/strict";
import { registerView } from "../js/views.js";

const S = { session: { email: "a@b.c" }, regRole: null };

test("after sign-up the person first chooses rider or driver", () => {
  const h = registerView(S);
  assert.match(h, /I need a ride to church/);
  assert.match(h, /I can give rides/);
  assert.ok(!h.includes('name="seats"'), "no form fields before choosing");
  assert.match(h, /Step 1 of 2/);
});

test("riders get the rider form, drivers get the car questions", () => {
  const rider = registerView({ ...S, regRole: "rider" });
  assert.match(rider, /name="role" value="rider"/);
  assert.ok(!rider.includes('name="seats"'));
  assert.match(rider, /under 18/);
  const driver = registerView({ ...S, regRole: "driver" });
  assert.match(driver, /name="role" value="driver"/);
  assert.match(driver, /name="seats"/);
  assert.match(driver, /name="vehicle"/);
  assert.ok(!driver.includes("under 18"));
  assert.match(driver, /Step 2 of 2/);
  assert.match(driver, /data-act="reg-back"/);
});

import { driverRoute } from "../js/texts.js";
import { fmtMin } from "../js/dates.js";

test("driver text gives address, phone and how many people are in this car", () => {
  const riders = new Map([["m", { name: "Mary Ade", address: "12 Example St", neighbourhood: "Stonebridge", phone: "306-555-0100" }]]);
  const split = driverRoute("2026-10-25", { name: "Jo Smith" }, [{ trip: 1, stops: [{ riderId: "m", pickupMin: 675, seats: 2 }] }], riders, new Map([["m", 3]]));
  assert.match(split, /Mary Ade, 12 Example St \(Stonebridge\), 306-555-0100/);
  assert.match(split, /3 people in this group\. You're taking 2/);
  assert.match(split, /Mary will sort out who rides with whom/);
  const whole = driverRoute("2026-10-25", { name: "Jo" }, [{ trip: 1, stops: [{ riderId: "m", pickupMin: 675, seats: 3 }] }], riders, new Map([["m", 3]]));
  assert.match(whole, /all riding with you/);
  const solo = driverRoute("2026-10-25", { name: "Jo" }, [{ trip: 1, stops: [{ riderId: "m", pickupMin: 675, seats: 1 }] }], riders);
  assert.ok(!/people in this group/.test(solo));
});
