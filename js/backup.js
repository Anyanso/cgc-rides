// Leader export: a full backup (JSON) and a people list (CSV for a spreadsheet).
// Pure functions plus one small browser download helper. The files contain addresses and
// phone numbers, so the screen tells the leader to keep them private.

const PEOPLE_COLUMNS = [
  ["name", "Name"], ["role", "Role"], ["status", "Driver status"], ["phone", "Phone"], ["email", "Email"],
  ["address", "Address"], ["neighbourhood", "Neighbourhood"], ["seats", "Seats"], ["vehicle", "Vehicle"],
  ["priority", "Priority rider"], ["minor", "Under 18"], ["drivesEveryWeek", "Drives every week"],
  ["secondTrip", "Can do a second trip"], ["policeCheckExpiry", "Police check date (note)"],
  ["textsConsentAt", "Agreed to texts (date)"], ["notes", "Notes"],
];

/** One CSV cell. Text that a spreadsheet could read as a formula gets a leading apostrophe. */
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "boolean" ? (v ? "yes" : "") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function peopleCsv(profiles = []) {
  const head = PEOPLE_COLUMNS.map(([, label]) => csvCell(label)).join(",");
  const rows = profiles.map((p) => PEOPLE_COLUMNS.map(([key]) => csvCell(p[key])).join(","));
  return [head, ...rows].join("\r\n") + "\r\n";
}

export function backupJson(tables, app = "Chosen Generation Rides", when = new Date()) {
  return JSON.stringify({ app, exportedAt: when.toISOString(), note: "Contains personal details. Keep it private.", tables }, null, 2);
}

export const stamp = (when = new Date()) => when.toISOString().slice(0, 10);

/** Starts a file download in the browser. */
export function download(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
