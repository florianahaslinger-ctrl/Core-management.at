/* Birdie Tickets – Service Worker NUR für den Einlass-Scanner (Scope /einlass…).
   Speichert die Scanner-Seite samt Skripten, damit sie auch ohne Internet lädt.
   Strategie: Netzwerk zuerst (immer aktuell), bei fehlendem Netz aus dem Speicher.
   Anfragen an die Datenbank (Supabase) werden NIE zwischengespeichert. */
const CACHE = 'bt-einlass-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('bt-einlass-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Die Seite schickt nach dem Laden die Liste ihrer Dateien → alle speichern.
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'cache' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(d.urls.map(u =>
    fetch(u, { mode: u.startsWith(self.location.origin) ? 'same-origin' : 'no-cors' })
      .then(r => (r.ok || r.type === 'opaque') ? c.put(u, r) : null).catch(() => null)
  ))));
});

function cacheable(url) {
  return url.origin === self.location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;                 // Supabase & Co. nicht anfassen
  const isPage = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), isPage ? 5000 : 8000);
      const res = await fetch(req, { signal: ctrl.signal });
      clearTimeout(t);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (isPage) {
        const page = await cache.match('einlass.html', { ignoreSearch: true });
        if (page) return page;
      }
      throw err;
    }
  })());
});
