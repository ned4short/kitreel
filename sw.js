// KitReel 2.0 offline support.
// - Page, scripts, styles, fonts and icons: try the network first (so updates show
//   right away), fall back to the saved copy when offline.
// - The big engines (player detection, video maker, number reader): saved the first
//   time they're used, then loaded from the device every time after that.
const SHELL = "kitreel-shell-v2";
const ENGINES = "kitreel-engines-v1";
const KEEP = [SHELL, ENGINES];
const isEngine = path => path.startsWith("/vendor/") || path.startsWith("/models/");

// Save the page and everything it links to (one level of script imports deep),
// so the app opens offline after the first visit.
async function saveShell() {
  const cache = await caches.open(SHELL);
  const seen = new Set();
  const grab = async (url, depth) => {
    if (seen.has(url)) return;
    seen.add(url);
    const res = await fetch(url, { cache: "no-cache" }).catch(() => null);
    if (!res || !res.ok) return;
    await cache.put(url, res.clone());
    if (depth > 1 || !/\.(js|html)(\?|$)|\/$/.test(url)) return;
    const text = await res.text();
    const refs = [...text.matchAll(/(?:src|href)="(\/[^"#]*)"|from\s+"(\/[^"]+)"|import\("(\/[^"]+)"\)/g)]
      .map(m => m[1] || m[2] || m[3])
      .filter(u => !isEngine(u) && !u.startsWith("//"));
    await Promise.all(refs.map(u => grab(u, depth + 1)));
  };
  await grab("/", 0);
}

self.addEventListener("install", event => {
  event.waitUntil(saveShell().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // tracking, ads, etc. stay online-only

  if (isEngine(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(ENGINES);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req) ||
        (req.mode === "navigate" ? await cache.match("/") : null) ||
        await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
