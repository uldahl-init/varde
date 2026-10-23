// Bump the build number (same as APP_BUILD in index.html) every time you upload a new index.html, so phones pick up the update.
const CACHE = 'varde-b56';
const NET_WAIT_MS = 3000; // 0.11.4: how long the app page waits for the network before opening the saved copy
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './knots/bowline.svg', './knots/taut-line.webp', './knots/clove-hitch.svg', './knots/prusik.webp', './knots/sheet-bend.webp', './knots/timber-hitch.webp', './knots/figure-eight.svg', './knots/figure-eight-loop.webp', './knots/improved-uni-tie.svg', './knots/improved-uni.svg', './knots/palomar-tie.webp', './knots/palomar.webp', './guides/stove-board.svg', './guides/stove-board-strap.svg', './guides/firesteel.svg', './guides/pack-zones.svg', './guides/edge-repair.svg', './guides/compass-parts.svg', './guides/compass-steps.svg', './guides/track-deer.svg', './guides/track-hare.svg', './guides/track-squirrel.svg', './guides/track-foxdog.svg', './guides/track-wolf.svg', './guides/track-lynx.svg', './guides/track-wolverine.svg', './guides/track-bear.svg', './guides/track-otter.svg', './guides/track-grouse.svg', './fonts/barlow-400.woff2', './fonts/barlow-600.woff2', './fonts/barlow-condensed-600.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The app page: try the network first (to get updates), fall back to the saved copy offline.
  // 0.11.4: on a weak connection, wait at most 3 seconds, then open the saved copy. The network answer,
  // when it comes, still updates the saved copy for next time. With no saved copy (first visit), wait for the network.
  if (req.mode === 'navigate'){
    const net = fetch(req, {cache:'no-cache'}).then(res => {
      if (res && res.ok){ const copy = res.clone(); return caches.open(CACHE).then(c => c.put('./index.html', copy)).then(() => res, () => res); }
      return res;
    });
    e.waitUntil(net.catch(() => {}));
    const late = new Promise(r => setTimeout(r, NET_WAIT_MS)).then(() => caches.match('./index.html')).then(hit => hit || net);
    e.respondWith(Promise.race([net, late]).catch(() => caches.match('./index.html').then(hit => hit || net)));
    return;
  }
  // Everything else (icons, pictures, fonts, all bundled with the app): use the saved copy, fetch and save it the first time.
  if (url.origin === location.origin){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
  }
});
