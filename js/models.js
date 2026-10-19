// Shared shapes and rules used by both the demo store and the live store.

// camelCase (used in the app) <-> snake_case (used in the database)
const MAP = {
  name: "full_name", address: "home_address", status: "driver_status",
  userId: "user_id", geoSource: "geo_source", guardianName: "guardian_name", guardianPhone: "guardian_phone",
  prefersSameGender: "prefers_same_gender", weeklyCheckin: "weekly_checkin", drivesEveryWeek: "drives_every_week",
  secondTrip: "second_trip", licenceOk: "licence_ok", insuranceOk: "insurance_ok",
  policeCheckExpiry: "police_check_expiry", textsConsentAt: "texts_consent_at",
  textsConsentWithdrawnAt: "texts_consent_withdrawn_at", createdAt: "created_at",
};
const SAME = ["id", "email", "phone", "role", "gender", "neighbourhood", "lat", "lng", "minor", "priority", "notes", "seats", "vehicle"];
const toSnake = Object.fromEntries([...Object.entries(MAP), ...SAME.map((k) => [k, k])]);
const toCamel = Object.fromEntries(Object.entries(toSnake).map(([c, s]) => [s, c]));

export function profileFromRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (toCamel[k]) out[toCamel[k]] = v;
  return out;
}

/** Only the keys present are converted, so partial updates stay partial. */
export function profileToRow(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) if (toSnake[k]) out[toSnake[k]] = v === "" ? null : v;
  return out;
}

/** An explicit choice for that Sunday wins; otherwise "every week" drivers are available. */
export function driverAvailable(driver, weeks, sunday) {
  const w = weeks.find((x) => x.driverId === driver.id && x.sunday === sunday);
  return w ? !!w.available : !!driver.drivesEveryWeek;
}

export const asDriver = (p, weeks, sunday) => ({ ...p, available: driverAvailable(p, weeks, sunday) });

/** Same rules the database enforces on save_plan, so the demo behaves like the real thing. */
export function validatePlan({ profilesById, sunday, assignments }) {
  const per = new Map();
  for (const a of assignments) {
    const d = profilesById.get(a.driverId);
    if (!d) throw new Error("Unknown driver in plan.");
    if (d.status !== "cleared") throw new Error("Only cleared drivers can be given riders.");
    const key = `${a.driverId}|${a.trip || 1}`;
    per.set(key, (per.get(key) || 0) + 1);
  }
  for (const [key, n] of per) {
    const d = profilesById.get(key.split("|")[0]);
    if (n > (d.seats || 0)) throw new Error("A car has more riders than seats.");
  }
}

export const DRIVER_STATUS_TEXT = {
  none: "Not a driver",
  pending: "Waiting for the transport leader to approve you as a driver",
  cleared: "Cleared to drive",
  suspended: "Paused by the leader",
};

export const CONSENT_WORDING =
  "I agree that Chosen Generation Church may text me about rides (pickup times, changes and reminders). I can say STOP or tell the transport leader at any time to withdraw this.";

/** Days until a YYYY-MM-DD date, from a given "today". */
export function daysLeft(iso, todayISO) {
  if (!iso) return null;
  return Math.round((Date.parse(iso) - Date.parse(todayISO)) / 86400000);
}
