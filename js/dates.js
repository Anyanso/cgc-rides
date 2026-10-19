// Date and time helpers. Sundays are plain "YYYY-MM-DD" strings so time zones can't shift them.

const pad = (n) => String(n).padStart(2, "0");

export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** The next n Sundays, starting today if today is a Sunday. */
export function nextSundays(n, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(toISO(d));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

/** Requests for a Sunday close the day before (Saturday) at 12:00 noon. */
export function closesAt(sundayISO) {
  const d = fromISO(sundayISO);
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d;
}

export const isClosed = (sundayISO, now = new Date()) => now >= closesAt(sundayISO);

export function fmtDate(iso, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat("en-CA", opts).format(fromISO(iso));
}

/** "10:45" -> 645 minutes after midnight. */
export function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 645 -> "10:45 AM". */
export function fmtMin(min) {
  const total = Math.round(min);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad(m)} ${suffix}`;
}

export const daysUntil = (iso, now = new Date()) =>
  Math.ceil((fromISO(iso) - now) / 86400000);
