// Minimal service worker. Its only job is to make the app installable as a PWA so
// the OS can register it as a handler for .torrent files and magnet links. It does
// not cache or intercept anything: the empty fetch listener is enough to satisfy
// the installability check while every request stays on the default network path,
// which keeps streaming range requests and the worker/OPFS loads untouched.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
