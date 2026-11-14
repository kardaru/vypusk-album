const CACHE = 'vypusk-f6250a3d76';

const SHELL = ['./', './index.html', './manifest.webmanifest', './img/icon-192.png', './img/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(fillAudio),
  );
});

// Покачиваем mp3 в кэш фоном: один раз открыл по ссылке — и на встрече
// альбом играет без сети.
async function fillAudio() {
  const cache = await caches.open(CACHE);
  const tracks = await caches.match('./tracks.f6250a3d76.json').then((r) => r.json());
  for (const t of tracks.sides.flatMap((s) => s.tracks)) {
    if (t.file && !t.file.startsWith('data:')) await cache.add(t.file).catch(() => {});
  }
  const clients = await self.clients.matchAll();
  clients.forEach((cl) => cl.postMessage({ type: 'offline-ready' }));
}

const slice = (buffer, type, from, to, total) =>
  new Response(buffer.slice(from, to + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${from}-${to}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(to - from + 1),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // сайт может жить в подкаталоге (github pages), поэтому не привязываемся к корню
  if (url.pathname.includes('/audio/')) {
    e.respondWith(serveAudio(req, url));
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put('./index.html', copy));
      return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  // тяжёлое и неизменное — из кэша; оболочка — из сети, иначе после
  // обновления пользователь ловит смесь нового HTML со старым CSS
  if (/\/(img|fonts)\//.test(url.pathname)) {
    e.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(url.pathname, copy));
      return r;
    })));
    return;
  }

  e.respondWith(
    fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(url.pathname, copy));
      return r;
    }).catch(() => caches.match(url.pathname)),
  );
});

async function serveAudio(req, url) {
  const cache = await caches.open(CACHE);
  const range = req.headers.get('Range');
  let hit = await cache.match(url.pathname);

  if (!hit) {
    const fresh = await fetch(req.url);
    const stored = fresh.clone();
    cache.put(url.pathname, stored);
    hit = fresh;
  }

  if (!range || !/^bytes=/.test(range)) return hit;

  const buffer = await hit.arrayBuffer();
  const total = buffer.byteLength;
  const [from, toRaw] = range.replace('bytes=', '').split('-');
  const start = Number(from) || 0;
  const end = toRaw ? Math.min(Number(toRaw), total - 1) : total - 1;
  return slice(buffer, hit.headers.get('Content-Type') || 'audio/mpeg', start, end, total);
}
