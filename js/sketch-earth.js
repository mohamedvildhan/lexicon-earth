/**
 * Dark base fill for B&W wireframe Earth.
 * Sharp coastlines / graticule are drawn as Three.js vectors (see vector-coast.js)
 * so they stay crisp when zoomed.
 */

function project(lon, lat, w, h) {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}

function eachRing(geometry, fn) {
  if (!geometry) return;
  if (geometry.type === "Polygon") {
    geometry.coordinates.forEach((ring, i) => fn(ring, i > 0));
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach((poly) => {
      poly.forEach((ring, i) => fn(ring, i > 0));
    });
  }
}

function drawRingPath(ctx, ring, w, h) {
  if (!ring || ring.length < 2) return;
  let started = false;
  let prev = null;
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i];
    const [x, y] = project(lon, lat, w, h);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
      prev = [x, y];
      continue;
    }
    if (prev && Math.abs(x - prev[0]) > w * 0.45) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    prev = [x, y];
  }
  ctx.closePath();
}

/** Soft fill-only texture — detail comes from vector overlays. */
export async function renderSketchEarth(options = {}) {
  const width = options.width || 4096;
  const height = options.height || 2048;
  const landUrl = options.landUrl || "./assets/earth/ne_50m_land.geojson";

  const res = await fetch(landUrl);
  if (!res.ok) throw new Error("Could not load Natural Earth land data");
  const land = await res.json();
  const features = land.features || [];

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  /* Ocean: dark navy (readable blue, still near-black). Land: dark charcoal. */
  ctx.fillStyle = "#0a1628";
  ctx.fillRect(0, 0, width, height);

  /*
   * Fill each feature on its own path. A single evenodd path over the whole
   * planet cancels land fills (parity across many rings → black continents).
   */
  ctx.fillStyle = "#1c1c1a";
  for (const f of features) {
    if (f.geometry?.type === "Polygon") {
      ctx.beginPath();
      for (const ring of f.geometry.coordinates) {
        drawRingPath(ctx, ring, width, height);
      }
      ctx.fill("evenodd");
    } else if (f.geometry?.type === "MultiPolygon") {
      for (const poly of f.geometry.coordinates) {
        ctx.beginPath();
        for (const ring of poly) {
          drawRingPath(ctx, ring, width, height);
        }
        ctx.fill("evenodd");
      }
    }
  }

  /* faint baked grid under vectors (helps at distance) */
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(lon, 0, width, height);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project(0, lat, width, height);
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }

  return canvas;
}
