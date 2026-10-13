/* Lexicon Earth service worker — offline shell + GeoJSON + CDN runtime cache */
const CACHE_VERSION = "lx-v46";
const SHELL = "lx-shell-" + CACHE_VERSION;
const RUNTIME = "lx-runtime-" + CACHE_VERSION;

const PRECACHE = [
  "./",
  "./index.html",
  "./about.html",
  "./how-it-works.html",
  "./privacy.html",
  "./view.html",
  "./robots.txt",
  "./sitemap.xml",
  "./css/app.css",
  "./css/site.css",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./data/starter.json",
  "./data/languages-atlas.json",
  "./data/ATTRIBUTION-languages.md",
  "./assets/earth/ne_50m_land.geojson",
  "./assets/earth/ne_50m_coastline.geojson",
  "./assets/earth/ATTRIBUTION.md",
  "./js/main.js",
  "./js/globe.js",
  "./js/pipeline.js",
  "./js/model.js",
  "./js/db.js",
  "./js/typeahead.js",
  "./js/sketch-earth.js",
  "./js/vector-coast.js",
  "./js/languages.js",
  "./js/sources/index.js",
  "./js/sources/base.js",
  "./js/sources/wiktionary.js",
  "./js/sources/wikidata.js",
  "./js/sources/kaikki.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL && k !== RUNTIME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isCdn(url) {
  return (
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* Same-origin navigations: network-first, fall back to cache */
  if (req.mode === "navigate" || (url.origin === self.location.origin && url.pathname.endsWith("/index.html"))) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  /* CDN (three.js, fonts): cache-first */
  if (isCdn(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(RUNTIME).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  /* JS/CSS/data: network-first so deploys + romanization fixes show on refresh */
  if (
    url.origin === self.location.origin &&
    (url.pathname.includes("/js/") ||
      url.pathname.includes("/css/") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      url.pathname.includes("/data/"))
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  /* Other same-origin assets (GeoJSON, images): cache-first */
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});
