/* Only public offline assets are cached. Authenticated pages and APIs stay on the network. */
const CACHE = "melancholy-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/offline.html", "/icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("melancholy-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html")),
    );
  }
});
function destination(value) {
  try {
    const url = new URL(value || "/", self.location.origin);
    if (
      url.origin === self.location.origin &&
      (url.pathname === "/" || /^\/thread\/[a-f0-9-]+$/.test(url.pathname))
    )
      return url.href;
  } catch {
    /* Fall back to workspace. */
  }
  return self.location.origin + "/";
}
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    /* Still show a visible notification. */
  }
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title : "melancholy",
      {
        body:
          typeof data.body === "string"
            ? data.body
            : "You have a new notification.",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: typeof data.tag === "string" ? data.tag : "workspace",
        data: { url: destination(data.url) },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = destination(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        const navigated = await existing.navigate(url);
        if (navigated) return navigated.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
