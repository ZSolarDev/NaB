importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    await scramjet.loadConfig();
    if (scramjet.route(event)) {
      return scramjet.fetch(event);
    }
    return fetch(event.request);
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim()); // Force the SW to take control immediately
});
