importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts('/uv/uv.sw.js');

const sw = new UVServiceWorker();

self.addEventListener('fetch', event => {
  event.respondWith(sw.fetch(event));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});