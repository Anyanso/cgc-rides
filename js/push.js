// Phone notifications (Web Push), on this device.
// States: "on", "off", "blocked" (the person said no in the browser), "ios-install" (iPhone/iPad:
// only works from the home-screen app), "unsupported", "not-set-up" (no key in config).

import { CONFIG } from "./config.js";

const nav = () => (typeof navigator === "undefined" ? null : navigator);

export function isIOS() {
  const n = nav();
  if (!n) return false;
  return /iPad|iPhone|iPod/.test(n.userAgent) || (n.platform === "MacIntel" && n.maxTouchPoints > 1);
}
export function isInstalled() {
  try { return window.matchMedia("(display-mode: standalone)").matches || nav()?.standalone === true; } catch { return false; }
}

export function pushSupport() {
  if (!CONFIG.push?.publicKey) return "not-set-up";
  if (isIOS() && !isInstalled()) return "ios-install";
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) || navigator.serviceWorker.register("sw.js");
}

export async function pushState() {
  const s = pushSupport();
  if (s !== "ok") return s;
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(b64) {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
}

function deviceName() {
  const ua = nav()?.userAgent || "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${br}`;
}

/** Must be called straight from a tap (browsers only ask then). Returns the new state. */
export async function turnOn(store) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "blocked" : "off";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CONFIG.push.publicKey) });
  await saveSub(store, sub);
  return "on";
}

async function saveSub(store, sub) {
  const j = sub.toJSON();
  await store.savePushSub({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() });
}

export async function turnOff(store) {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    await store.removePushSub(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

/** Makes sure this device is saved for the person signed in now (e.g. after switching accounts). */
export async function resync(store) {
  try {
    if ((await pushState()) !== "on") return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await saveSub(store, sub);
  } catch (err) { console.warn("Notification re-sync failed", err); }
}
