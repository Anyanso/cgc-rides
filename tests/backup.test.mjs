import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, peopleCsv, backupJson, stamp } from "../js/backup.js";
import { createLiveStore } from "../js/store-live.js";
import { createDemoStore } from "../js/store-demo.js";
import { CONFIG } from "../js/config.js";

test("csv cells are quoted and cannot run as spreadsheet formulas", () => {
  assert.equal(csvCell('He said "hi", ok'), '"He said ""hi"", ok"');
  assert.equal(csvCell("=HYPERLINK(\"x\")").startsWith("\"'="), true);
  assert.equal(csvCell("+1 306 555 0100"), "'+1 306 555 0100");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(true), "yes");
  assert.equal(csvCell(3), "3");
});

test("people list has a header and one row per person", () => {
  const csv = peopleCsv([{ name: "Mary, Ade", role: "rider", phone: "306-555-0100", minor: false, seats: null }, { name: "Jo", role: "driver", seats: 3, status: "cleared" }]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Name,Role,Driver status,Phone/);
  assert.match(lines[1], /^"Mary, Ade",rider,,306-555-0100/);
  assert.match(lines[2], /^Jo,driver,cleared/);
});

test("backup file is valid JSON with the date and all tables", () => {
  const j = JSON.parse(backupJson({ profiles: [{ id: 1 }] }, "App", new Date("2026-10-19T12:00:00Z")));
  assert.equal(j.exportedAt, "2026-10-19T12:00:00.000Z");
  assert.deepEqual(j.tables.profiles, [{ id: 1 }]);
  assert.equal(stamp(new Date("2026-10-19T12:00:00Z")), "2026-10-19");
});

test("live export pages through more than 1000 rows per table", async () => {
  const calls = [];
  const fake = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {} },
    from: (t) => ({ select: () => ({ range: async (a, b) => { calls.push([t, a, b]); const n = t === "profiles" ? (a === 0 ? 1000 : 250) : 2; return { data: Array.from({ length: n }, (_, i) => ({ id: `${t}${a}${i}` })), error: null }; } }) }) };
  const s = await createLiveStore({ ...CONFIG, supabase: { url: "https://x.supabase.co", anonKey: "k" } }, { createClient: () => fake });
  const t = await s.exportAll();
  assert.equal(t.profiles.length, 1250);
  assert.deepEqual(Object.keys(t), ["profiles", "consent_log", "driver_weeks", "ride_requests", "plans", "assignments", "waitlist", "alerts"]);
  assert.ok(calls.some(([tbl, a]) => tbl === "profiles" && a === 1000));
});

test("demo export works", async () => {
  const t = await createDemoStore().exportAll();
  assert.ok(t.profiles.length > 3);
});
