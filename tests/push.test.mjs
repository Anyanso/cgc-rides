import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

// The Edge Function is plain JavaScript in a .ts file; load a copy as a module.
const dir = mkdtempSync(join(tmpdir(), "send-push-"));
writeFileSync(join(dir, "index.mjs"), readFileSync(new URL("../supabase/functions/send-push/index.ts", import.meta.url)));
const P = await import(join(dir, "index.mjs"));
const b64u = (b) => Buffer.from(b).toString("base64url");

test("encryption matches the official example in RFC 8291 (Appendix A)", async () => {
  const body = await P.encryptPayload("When I grow up, I want to be a watermelon",
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
    { salt: "DGv6ra1nlYgDCS1FRnbzlw", asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" });
  assert.equal(b64u(body), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

/** An independent decryption with Node's crypto, as a phone would do it. */
function decrypt(body, ua, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString();
}

function vapidKeys() {
  const k = crypto.createECDH("prime256v1"); k.generateKeys();
  return { publicKey: b64u(k.getPublicKey()), privateKey: b64u(k.getPrivateKey()) };
}

test("the full send: a phone can decrypt the message, and the signature checks out", async () => {
  const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const vapid = vapidKeys();
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { status: 201 }; };
  const status = await P.sendWebPush({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) },
    { title: "Your ride is confirmed", body: "Grace picks you up at 10:50 AM.", tag: "ride-2026-10-25" }, vapid, fakeFetch);
  assert.equal(status, 201);
  const { init } = calls[0];
  assert.equal(init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(init.headers.TTL, "86400");
  assert.equal(init.headers.Topic, "ride-2026-10-25");
  assert.deepEqual(JSON.parse(decrypt(Buffer.from(init.body), ua, auth)), { title: "Your ride is confirmed", body: "Grace picks you up at 10:50 AM.", tag: "ride-2026-10-25" });

  const m = init.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[4], vapid.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400);
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(Buffer.from(vapid.publicKey, "base64url").subarray(1, 33)), y: b64u(Buffer.from(vapid.publicKey, "base64url").subarray(33)) }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
});

test("a run claims waiting messages, sends them, and forgets switched-off devices", async () => {
  const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
  const sub = { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
  const rows = [
    { queue_id: 1, title: "A", body: "a", tag: "alert", endpoint: "https://push.example/ok", ...sub },
    { queue_id: 2, title: "B", body: "b", tag: null, endpoint: "https://push.example/gone", ...sub },
  ];
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    if (url.endsWith("/rpc/claim_push")) { assert.equal(init.headers.Authorization, "Bearer service-key"); return { ok: true, json: async () => rows }; }
    if (url === "https://push.example/gone") return { status: 410 };
    return { status: 201, ok: true };
  };
  const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", ...Object.fromEntries(Object.entries(vapidKeys()).map(([k, v]) => [k === "publicKey" ? "VAPID_PUBLIC_KEY" : "VAPID_PRIVATE_KEY", v])) };
  const res = await P.handle(new Request("https://x.supabase.co/functions/v1/send-push", { method: "POST" }), env, fakeFetch);
  assert.deepEqual(await res.json(), { waiting: 2, sent: 1, failed: 0, removedDevices: 1 });
  assert.ok(seen.includes("DELETE https://x.supabase.co/rest/v1/push_subs?endpoint=eq.https%3A%2F%2Fpush.example%2Fgone"));
  // Missing keys are reported plainly.
  const bad = await P.handle(new Request("https://x/", { method: "POST" }), { SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }, fakeFetch);
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /VAPID_PUBLIC_KEY/);
});
