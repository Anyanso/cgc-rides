import test from "node:test";
import assert from "node:assert/strict";
import { registerView } from "../js/views.js";

const S = { session: { email: "a@b.c" }, regRole: null };

test("after sign-up the person first chooses rider or driver", () => {
  const h = registerView(S);
  assert.match(h, /I need a ride to church/);
  assert.match(h, /I can give rides/);
  assert.ok(!h.includes('name="seats"'), "no form fields before choosing");
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
});
