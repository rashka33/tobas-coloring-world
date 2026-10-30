/* Toba's Coloring World — offline service worker
   Relative URLs only so it works under /tobas-coloring-world/ on GitHub Pages. */
const BUILD_ID = "2026-10-25-gateway1";
const CACHE_NAME = "tcw-" + BUILD_ID;
const FONT_CACHE = "tcw-fonts-" + BUILD_ID;

/** App shell + every same-origin asset needed fully offline. */
const PRECACHE = [
  "./",
  "./index.html",
  "./sw.js",
  "./assets/app.js",
  "./assets/app.css",
  "./assets/icon.webp",
  "./assets/manifest.webmanifest",
  "./assets/bundle-en-1.mp3",
  "./assets/bundle-en-2.mp3",
  "./assets/bundle-en-adv.mp3",
  "./assets/bundle-en-story.mp3",
  "./assets/bundle-so-1.mp3",
  "./assets/bundle-so-2.mp3",
  "./assets/bundle-so-3.mp3",
  "./assets/bundle-so-4.mp3",
  "./assets/bundle-so-adv.mp3",
  "./assets/so-song-numbers-mixed.mp3",
  "./assets/song-abc-katie.mp3",
  "./assets/song-abc-melody.mp3",
  "./assets/song-numbers-melody.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Fetch each URL relative to the SW location; abort install if any fail.
      for (const path of PRECACHE) {
        try {
          const url = new URL(path, self.location.href);
          const res = await fetch(url, { cache: "reload" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          await cache.put(url, res.clone());
          // Also store bare app.js so ?build=… requests match with ignoreSearch.
        } catch (err) {
          console.warn("[tcw-sw] precache failed:", path, err);
          throw err;
        }
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([CACHE_NAME, FONT_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("tcw-") && !keep.has(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isNavigationRequest(request) {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") || "";
  return request.method === "GET" && accept.includes("text/html");
}

function isIndexRequest(url) {
  const path = url.pathname;
  return (
    path.endsWith("/") ||
    path.endsWith("/index.html") ||
    /\/tobas-coloring-world\/?$/.test(path)
  );
}

function isSameOriginAsset(url) {
  return url.origin === self.location.origin;
}

function isGoogleFont(url) {
  return (
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  );
}

function isCloudflareBeacon(url) {
  return (
    url.hostname === "static.cloudflareinsights.com" ||
    url.hostname === "cloudflareinsights.com"
  );
}

/** Serve a cached full body as 206 when the client asks for a byte range (audio). */
async function responseForRange(request, cached) {
  const range = request.headers.get("Range");
  if (!range || !cached) return cached;

  const buf = await cached.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return cached;

  let start = parseInt(m[1], 10);
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= size) end = size - 1;
  if (start > end || start >= size) {
    return new Response(null, {
      status: 416,
      statusText: "Requested Range Not Satisfiable",
      headers: { "Content-Range": "bytes */" + size },
    });
  }

  const slice = buf.slice(start, end + 1);
  const headers = new Headers();
  const ct = cached.headers.get("Content-Type") || "audio/mpeg";
  headers.set("Content-Type", ct);
  headers.set("Content-Length", String(slice.byteLength));
  headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
  headers.set("Accept-Ranges", "bytes");
  const etag = cached.headers.get("ETag");
  if (etag) headers.set("ETag", etag);

  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

async function cacheMatch(request) {
  const cache = await caches.open(CACHE_NAME);
  // ignoreSearch so assets/app.js?build=… hits the precached assets/app.js
  let hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  // Navigations to ./ should fall back to index.html
  if (isNavigationRequest(request) || isIndexRequest(new URL(request.url))) {
    hit = await cache.match(new URL("./index.html", self.location.href));
    if (hit) return hit;
    hit = await cache.match(new URL("./", self.location.href));
  }
  return hit || null;
}

async function networkFirstIndex(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      // Store as index.html for reliable offline fallback
      await cache.put(new URL("./index.html", self.location.href), fresh.clone());
      await cache.put(new URL("./", self.location.href), fresh.clone());
    }
    return fresh;
  } catch (err) {
    const fallback = await cacheMatch(request);
    if (fallback) return fallback;
    throw err;
  }
}

async function cacheFirstAsset(request) {
  const cached = await cacheMatch(request);
  if (cached) {
    if (request.headers.has("Range")) {
      return responseForRange(request, cached);
    }
    return cached;
  }

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && request.method === "GET") {
      const cache = await caches.open(CACHE_NAME);
      // Store without forcing query-string variants
      const storeUrl = new URL(request.url);
      if (storeUrl.searchParams.has("build")) {
        storeUrl.search = "";
      }
      await cache.put(storeUrl, fresh.clone());
    }
    if (request.headers.has("Range") && fresh && fresh.ok) {
      // Network already returned whatever it returned (often 206)
      return fresh;
    }
    return fresh;
  } catch (err) {
    // Offline and nothing cached
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function runtimeCacheFonts(request) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      await cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Fonts are optional — fail gracefully (page uses system-ui fallback)
    return new Response("", { status: 504, statusText: "Font unavailable offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Let Cloudflare analytics fail on its own — do not intercept.
  if (isCloudflareBeacon(url)) return;

  // Optional: runtime-cache Google Fonts after first online visit.
  if (isGoogleFont(url)) {
    event.respondWith(runtimeCacheFonts(request));
    return;
  }

  // Cross-origin everything else: leave to network (no SW interference).
  if (!isSameOriginAsset(url)) return;

  // HTML shell: network-first, cache fallback
  if (isNavigationRequest(request) || isIndexRequest(url)) {
    event.respondWith(networkFirstIndex(request));
    return;
  }

  // Same-origin assets (JS/CSS/MP3/icons/manifest/sw): cache-first
  event.respondWith(cacheFirstAsset(request));
});
