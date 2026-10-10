import * as THREE from "three";

function latLonToVector3(lat, lon, radius) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function eachLineString(geometry, fn) {
  if (!geometry) return;
  if (geometry.type === "LineString") fn(geometry.coordinates);
  else if (geometry.type === "MultiLineString") geometry.coordinates.forEach(fn);
  else if (geometry.type === "Polygon") geometry.coordinates.forEach(fn);
  else if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach((poly) => poly.forEach(fn));
  }
}

/** Densify a lon/lat ring so zoomed views stay smooth. */
function densify(coords, maxStepDeg = 0.35) {
  if (!coords || coords.length < 2) return coords || [];
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = out[out.length - 1];
    const [lon1, lat1] = coords[i];
    let dLon = lon1 - lon0;
    if (Math.abs(dLon) > 180) {
      out.push(coords[i]);
      continue;
    }
    const dLat = lat1 - lat0;
    const dist = Math.hypot(dLon, dLat);
    const steps = Math.max(1, Math.ceil(dist / maxStepDeg));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([lon0 + dLon * t, lat0 + dLat * t]);
    }
  }
  return out;
}

/**
 * Build sphere-hugging LineSegments from Natural Earth GeoJSON.
 * Stays sharp at any zoom (vector, not raster).
 */
export async function buildCoastLineSegments({
  url = "./assets/earth/ne_50m_coastline.geojson",
  radius = 1.0035,
  color = 0xf2f2f2,
  opacity = 0.95,
  maxStepDeg = 0.3,
} = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coastline fetch failed: ${res.status}`);
  const geo = await res.json();
  const positions = [];

  for (const f of geo.features || []) {
    eachLineString(f.geometry, (raw) => {
      const coords = densify(raw, maxStepDeg);
      for (let i = 0; i < coords.length - 1; i++) {
        const [lon0, lat0] = coords[i];
        const [lon1, lat1] = coords[i + 1];
        if (Math.abs(lon1 - lon0) > 180) continue;
        const a = latLonToVector3(lat0, lon0, radius);
        const b = latLonToVector3(lat1, lon1, radius);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = true;
  lines.renderOrder = 2;
  return lines;
}

/** Dense lat/lon wire grid as vectors (sharp when zoomed). */
export function buildGraticuleLines({
  radius = 1.002,
  step = 10,
  majorStep = 30,
  color = 0x8a8a8a,
  majorColor = 0xc0c0c0,
} = {}) {
  const group = new THREE.Group();

  const pushMeridian = (lon, arr, segs = 128) => {
    for (let i = 0; i < segs; i++) {
      const lat0 = -90 + (180 * i) / segs;
      const lat1 = -90 + (180 * (i + 1)) / segs;
      const a = latLonToVector3(lat0, lon, radius);
      const b = latLonToVector3(lat1, lon, radius);
      arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };
  const pushParallel = (lat, arr, segs = 180) => {
    for (let i = 0; i < segs; i++) {
      const lon0 = -180 + (360 * i) / segs;
      const lon1 = -180 + (360 * (i + 1)) / segs;
      const a = latLonToVector3(lat, lon0, radius);
      const b = latLonToVector3(lat, lon1, radius);
      arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };

  const minor = [];
  const major = [];
  for (let lon = -180; lon < 180; lon += step) {
    pushMeridian(lon, lon % majorStep === 0 ? major : minor);
  }
  for (let lat = -80; lat <= 80; lat += step) {
    pushParallel(lat, lat % majorStep === 0 ? major : minor);
  }

  const mk = (arr, col, opacity) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity, depthWrite: false })
    );
  };

  group.add(mk(minor, color, 0.18));
  group.add(mk(major, majorColor, 0.35));
  group.renderOrder = 1;
  return group;
}
