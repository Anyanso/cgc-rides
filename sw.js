// Chosen Generation Rides: phone notifications only.
// This worker caches nothing (the app always loads fresh); it shows notifications and opens the app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(m.title || "Chosen Generation Rides", {
    body: m.body || "Open the app to see what's new.",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    icon: "assets/icon-192.png",
    badge: "assets/icon-192.png",
    data: { url: m.url || self.registration.scope },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); open.postMessage({ type: "refresh" }); return; }
    await self.clients.openWindow(event.notification.data?.url || self.registration.scope);
  })());
});
