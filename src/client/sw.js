// Minimal service worker: makes the app installable and shows a friendly page when
// offline. It deliberately caches nothing, so chat and sign-in always
// go straight to the network.
"use strict";

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #0e0e10; color: #efeff1; font: 15px/1.5 system-ui, sans-serif; text-align: center; padding: 16px; box-sizing: border-box; }
  img { width: 96px; height: 96px; border-radius: 22px; margin-bottom: 16px; }
  p { color: #adadb8; margin: 4px 0 20px; }
  button { padding: 10px 18px; border: 0; border-radius: 6px; background: #9147ff; color: #fff; font: inherit; font-weight: 600; }
</style></head>
<body><div>
  <h1 style="font-size:18px;margin:0">You're offline</h1>
  <p>Chat will be back when your connection is.</p>
  <button onclick="location.reload()">Try again</button>
</div></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  // Navigation preload: the page request starts while the service worker is still waking up
  // (on a phone that can take a noticeable fraction of a second), instead of after it.
  try { await self.registration.navigationPreload?.enable(); } catch {}
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith((async () => {
    try {
      try { const early = await event.preloadResponse; if (early) return early; } catch {} // (then ask again below)
      return await fetch(event.request);
    } catch {
      return new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  })());
});

// Mention/highlight notifications: focus the app and open the channel's tab.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tab = event.notification.data && event.notification.data.tab;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      if (tab) client.postMessage({ type: "open-tab", tab });
    } else {
      await self.clients.openWindow("/" + (tab ? "#" + tab : ""));
    }
  })());
});
