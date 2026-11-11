/* VarOrga Scan : service worker (fonctionne hors connexion) */
const CACHE = 'varorga-scan-v1';
const FICHIERS = [
  './', 'index.html', 'style.css', 'app.js', 'scan.js', 'store.js', 'manifest.webmanifest',
  'lib/opencv.js', 'lib/jspdf.umd.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/favicon.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // le serveur Drive n'est jamais mis en cache

  // Bibliothèques et icônes : cache d'abord (gros fichiers qui ne changent pas)
  if (url.pathname.includes('/lib/') || url.pathname.includes('/icons/')) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copie = res.clone(); caches.open(CACHE).then(c => c.put(req, copie)); return res;
    })));
    return;
  }
  // Le reste : réseau d'abord (pour recevoir les mises à jour), cache si hors connexion
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copie = res.clone(); caches.open(CACHE).then(c => c.put(req, copie)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
