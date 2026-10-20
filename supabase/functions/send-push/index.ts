// @ts-nocheck  (plain JavaScript, so the same file runs in the tests)
// send-push: a Supabase Edge Function that sends the waiting phone notifications.
//
// The app calls it after anything that may notify someone (an approved plan, a cancellation, a
// last-minute request...). It takes the waiting messages from the database (claim_push), sends
// each one to the person's devices with the standard Web Push protocol, and forgets devices that
// have been switched off. It needs no libraries: everything is done with the built-in Web Crypto.
//
// Setup (once): Supabase -> Edge Functions -> Deploy a new function -> Via Editor -> name it
// send-push -> paste this whole file -> Deploy. Then Edge Functions -> Secrets: add
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (the pair made for this app; the public one is also in
// js/config.js). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// (Written as plain JavaScript so the same file can be tested in Node.)

const enc = new TextEncoder();
const APP_URL = "https://chosen-generation.github.io/cgc-rides/";

export function b64uEncode(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

/** A P-256 key from raw public bytes (65) and, optionally, the private number d (32). */
function jwkFrom(publicRaw, dRaw) {
  const jwk = { kty: "EC", crv: "P-256", x: b64uEncode(publicRaw.slice(1, 33)), y: b64uEncode(publicRaw.slice(33, 65)), ext: true };
  if (dRaw) jwk.d = b64uEncode(dRaw);
  return jwk;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/**
 * Encrypts a message for one device (RFC 8291, "aes128gcm").
 * `fixed` is only for tests (a known salt and server key pair).
 */
export async function encryptPayload(plaintext, p256dh, authSecret, fixed = {}) {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const salt = fixed.salt ? b64uDecode(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  let asPrivate, asPublic;
  if (fixed.asPrivate) {
    asPublic = b64uDecode(fixed.asPublic);
    asPrivate = await crypto.subtle.importKey("jwk", jwkFrom(asPublic, b64uDecode(fixed.asPrivate)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const data = concat(typeof plaintext === "string" ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  return concat(header, asPublic, cipher);
}

/** The "Authorization: vapid ..." header that proves the message comes from this app. */
export async function vapidAuth(endpoint, { publicKey, privateKey, subject = APP_URL }, now = Date.now()) {
  const pub = b64uDecode(publicKey);
  const key = await crypto.subtle.importKey("jwk", jwkFrom(pub, b64uDecode(privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64uEncode(sig)}, k=${publicKey}`;
}

/** Sends one message to one device. Returns the push service's HTTP status. */
export async function sendWebPush(sub, message, vapid, fetchFn = fetch) {
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
      ...(message.tag ? { Topic: String(message.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
    },
    body,
  });
  return res.status;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** One run: claim what's waiting, send it, forget switched-off devices. */
export async function handle(req, env, fetchFn = fetch) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || APP_URL };
  if (!url || !key) return reply({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500);
  if (!vapid.publicKey || !vapid.privateKey) return reply({ error: "Add the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets." }, 500);
  const db = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const res = await fetchFn(`${url}/rest/v1/rpc/claim_push`, { method: "POST", headers: db, body: "{}" });
  if (!res.ok) return reply({ error: `claim_push: ${res.status} ${await res.text()}` }, 500);
  const rows = await res.json();
  let sent = 0, failed = 0;
  const gone = new Set();
  await Promise.all(rows.map(async (r) => {
    try {
      const status = await sendWebPush(r, { title: r.title, body: r.body, tag: r.tag || undefined, url: APP_URL }, vapid, fetchFn);
      if (status === 404 || status === 410) gone.add(r.endpoint);
      else if (status >= 200 && status < 300) sent++;
      else failed++;
    } catch (err) { console.error(err); failed++; }
  }));
  for (const e of gone) await fetchFn(`${url}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(e)}`, { method: "DELETE", headers: db });
  return reply({ waiting: rows.length, sent, failed, removedDevices: gone.size });
}

if (typeof Deno !== "undefined") Deno.serve((req) => handle(req, Deno.env.toObject()));
