import * as THREE from "three";
import { renderSketchEarth } from "./sketch-earth.js";
import { buildCoastLineSegments, buildGraticuleLines } from "./vector-coast.js";

const EARTH_RADIUS = 1;
const DEFAULT_LAT = 15;
const DEFAULT_LON = -18;
const MIN_DIST = 1.06;
const MAX_DIST = 3.55;
const DEFAULT_DIST = 2.2;

/** Matches Three.js SphereGeometry UVs with equirectangular maps (lon 0 at texture center). */
function latLonToVector3(lat, lon, radius = EARTH_RADIUS, out = new THREE.Vector3()) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return out.set(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function greatCirclePoints(aLat, aLon, bLat, bLon, segments = 64) {
  const va = latLonToVector3(aLat, aLon, 1).normalize();
  const vb = latLonToVector3(bLat, bLon, 1).normalize();
  const dot = Math.max(-1, Math.min(1, va.dot(vb)));
  const omega = Math.acos(dot);
  const pts = [];
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    let v;
    if (omega < 0.001) {
      v = va.clone().lerp(vb, t).normalize();
    } else {
      const u = Math.sin((1 - t) * omega) / Math.sin(omega);
      const w = Math.sin(t * omega) / Math.sin(omega);
      v = va.clone().multiplyScalar(u).add(vb.clone().multiplyScalar(w)).normalize();
    }
    /* altitude so arcs clear the surface and read clearly */
    const lift = 1.02 + 0.055 * Math.sin(Math.PI * t);
    pts.push(v.multiplyScalar(EARTH_RADIUS * lift));
  }
  return pts;
}

function boostColor(hex) {
  const c = new THREE.Color(hexColor(hex));
  c.offsetHSL(0, 0.12, 0.06);
  return c;
}

function hexColor(c) {
  if (!c) return 0xb54b3d;
  return parseInt(String(c).replace("#", ""), 16);
}

function easeInOutCubic(t) {
  const u = Math.max(0, Math.min(1, t));
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** Softer than cubic — longer ease at the ends for a more deliberate pace. */
function easeInOutQuint(t) {
  const u = Math.max(0, Math.min(1, t));
  return u < 0.5 ? 16 * u * u * u * u * u : 1 - Math.pow(-2 * u + 2, 5) / 2;
}

/**
 * Pace a 0–1 journey across `hopCount` legs so most time is spent traveling
 * between locations (not rushing the middle hops).
 * Returns continuous position in [0, hopCount].
 */
function pacedHopPosition(t, hopCount) {
  const hops = Math.max(1, hopCount | 0);
  const u = Math.max(0, Math.min(1, t));
  /* Equal wall-clock per hop (linear). Global ease-in-out was skipping middles. */
  const x = u * hops;
  const i = Math.min(hops - 1, Math.floor(x));
  const local = x - i;
  /* Dwell briefly, then crawl across the gap, then settle */
  const DWELL = 0.14;
  const SETTLE = 0.12;
  const TRAVEL = 1 - DWELL - SETTLE;
  let seg;
  if (local < DWELL) seg = 0;
  else if (local > 1 - SETTLE) seg = 1;
  else seg = easeInOutQuint((local - DWELL) / TRAVEL);
  return i + seg;
}

function lerpAngleDeg(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

/** Average lat/lon via unit-vector mean (handles date-line wrap). */
function centroidLatLon(nodes) {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (const node of nodes) {
    if (node.lat == null || node.lon == null) continue;
    const lat = (node.lat * Math.PI) / 180;
    const lon = (node.lon * Math.PI) / 180;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
    n += 1;
  }
  if (!n) return null;
  const len = Math.hypot(x, y, z) || 1;
  x /= len;
  y /= len;
  z /= len;
  return {
    lat: (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

/** Great-circle angular separation in degrees. */
function angularDistanceDeg(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const φ1 = aLat * r;
  const φ2 = bLat * r;
  const dφ = (bLat - aLat) * r;
  const dλ = (bLon - aLon) * r;
  const h =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180) / Math.PI;
}

export class Globe {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.trajectory = [];
    this.arcs = [];
    this.selectedIdx = -1;
    this.hoverIdx = -1;
    this.onSelect = null;
    this.animProgress = 1;
    this._animTarget = 1;
    this._flowT = 0;
    this._journeyStart = 0;
    this._journeyDuration = 0;
    this._journeyCam = null;
    this._manualTimeline = false;

    this.rot = { lat: DEFAULT_LAT, lon: DEFAULT_LON };
    this.target = { lat: DEFAULT_LAT, lon: DEFAULT_LON };
    this.distance = DEFAULT_DIST;
    this.targetDistance = DEFAULT_DIST;
    this.vel = { lat: 0, lon: 0 };

    this.dragging = false;
    this.pointer = null;
    this._pinch = null;
    /** Slow auto-rotate while waiting for a search (disabled after a lineage loads). */
    this.idleSpin = true;
    this.idleSpinSpeed = 0.022; /* ~1.3°/sec at 60fps */
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    this._labelsDirty = true;
    this._markerByIdx = new Map();
    this._lastLabelCam = { lat: NaN, lon: NaN, dist: NaN };
    this._scratchWorld = new THREE.Vector3();
    this._scratchNormal = new THREE.Vector3();
    this._scratchView = new THREE.Vector3();
    this._scratchProjected = new THREE.Vector3();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf5f2e9); /* warm UI chrome; globe itself is B&W */

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.globe = new THREE.Group();
    this.root.add(this.globe);

    this.markers = new THREE.Group();
    this.routes = new THREE.Group();
    this.globe.add(this.markers);
    this.globe.add(this.routes);

    this._buildLights();
    this._buildEarth();
    this._bindPointer();
    this.resize();
    addEventListener("resize", () => this.resize());
    if (typeof ResizeObserver !== "undefined" && this.canvas.parentElement) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas.parentElement);
    }

    this._raf = 0;
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  _buildLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(3.2, 2.2, 2.6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfbfbf, 0.25);
    fill.position.set(-2.5, -0.8, -2);
    this.scene.add(fill);
  }

  _buildEarth() {
    const geo = new THREE.SphereGeometry(EARTH_RADIUS, 128, 96);

    this.earthMat = new THREE.MeshStandardMaterial({
      color: 0x0a1628, /* navy ocean fallback before texture loads */
      roughness: 1,
      metalness: 0,
    });
    this.earth = new THREE.Mesh(geo, this.earthMat);
    this.globe.add(this.earth);

    /* coarse sphere wire (distant); denser LOD swaps in when zoomed */
    this._wireLod = {
      far: this._makeSphereWire(36, 24, 0.22),
      near: this._makeSphereWire(72, 48, 0.16),
    };
    this.sphereWire = this._wireLod.far;
    this.globe.add(this.sphereWire);

    this.vectorDetail = new THREE.Group();
    this.globe.add(this.vectorDetail);

    this._loadEarthDetail();

    const atmoGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.02, 64, 48);
    const atmoMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        glowColor: { value: new THREE.Color(0x9a9a9a) },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.74 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.6);
          gl_FragColor = vec4(glowColor, clamp(intensity * 0.28, 0.0, 0.35));
        }
      `,
    });
    this.atmo = new THREE.Mesh(atmoGeo, atmoMat);
    this.root.add(this.atmo);

    const rimGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.004, 64, 48);
    const rimMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        glowColor: { value: new THREE.Color(0xe8e8e8) },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.2);
          gl_FragColor = vec4(glowColor, fresnel * 0.22);
        }
      `,
    });
    this.rim = new THREE.Mesh(rimGeo, rimMat);
    this.root.add(this.rim);
  }

  _makeSphereWire(wSeg, hSeg, opacity) {
    const wireGeo = new THREE.WireframeGeometry(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.0012, wSeg, hSeg)
    );
    return new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({
        color: 0x5c5c5c,
        transparent: true,
        opacity,
        depthWrite: false,
      })
    );
  }

  _setWireLod(near) {
    const next = near ? this._wireLod.near : this._wireLod.far;
    if (this.sphereWire === next) return;
    this.globe.remove(this.sphereWire);
    this.sphereWire = next;
    this.globe.add(this.sphereWire);
  }

  async _loadEarthDetail() {
    try {
      const hiRes = (devicePixelRatio || 1) > 1.25 || innerWidth > 1400;
      const sketchCanvas = await renderSketchEarth({
        width: hiRes ? 4096 : 3072,
        height: hiRes ? 2048 : 1536,
        landUrl: "./assets/earth/ne_50m_land.geojson",
      });
      const tex = new THREE.CanvasTexture(sketchCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      this.earthMat.map = tex;
      this.earthMat.color.set(0xffffff);
      this.earthMat.needsUpdate = true;
    } catch (e) {
      console.warn("Earth fill texture failed; using dark fallback.", e);
    }

    try {
      const [coast, grid] = await Promise.all([
        buildCoastLineSegments({
          url: "./assets/earth/ne_50m_coastline.geojson",
          radius: EARTH_RADIUS * 1.0038,
          maxStepDeg: 0.22,
        }),
        Promise.resolve(
          buildGraticuleLines({
            radius: EARTH_RADIUS * 1.0024,
            step: 10,
            majorStep: 30,
          })
        ),
      ]);
      this.vectorDetail.clear();
      this.vectorDetail.add(grid);
      this.vectorDetail.add(coast);
    } catch (e) {
      console.warn("Vector coastline overlay failed.", e);
    }
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const w = Math.max(1, wrap?.clientWidth || innerWidth);
    const h = Math.max(1, wrap?.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setZoomFactor(factor) {
    /* factor ~0.7–2.0 maps to camera distance */
    const t = (Math.max(0.7, Math.min(2, factor)) - 0.7) / 1.3;
    this.targetDistance = MAX_DIST - t * (MAX_DIST - MIN_DIST);
    this.targetDistance = Math.max(MIN_DIST, Math.min(MAX_DIST, this.targetDistance));
  }

  getZoomFactor() {
    const t = (MAX_DIST - this.targetDistance) / (MAX_DIST - MIN_DIST);
    return 0.7 + t * 1.3;
  }

  resetView() {
    this.target.lat = DEFAULT_LAT;
    this.target.lon = DEFAULT_LON;
    this.targetDistance = DEFAULT_DIST;
    this.vel.lat = 0;
    this.vel.lon = 0;
    this.onZoom?.(this.getZoomFactor());
  }

  setIdleSpin(on) {
    this.idleSpin = !!on && !this.reducedMotion;
    if (this.idleSpin) {
      this.vel.lat = 0;
      this.vel.lon = 0;
    }
  }

  /** Degrees of rotation per screen pixel — lower when zoomed in for fine control. */
  _panSensitivity() {
    const t = (this.distance - MIN_DIST) / (MAX_DIST - MIN_DIST);
    return 0.055 + 0.22 * Math.max(0, Math.min(1, t));
  }

  focus(lat, lon) {
    this.target.lat = Math.max(-75, Math.min(75, lat));
    this.target.lon = lon;
  }

  /**
   * Ease camera along the lineage, then settle on the region centroid.
   * @param {Array<{lat?: number, lon?: number}>} nodes
   */
  frameRegion(nodes) {
    const geo = (nodes || []).filter((n) => n.lat != null && n.lon != null);
    if (!geo.length) return;

    this.setIdleSpin(false);
    this.vel.lat = 0;
    this.vel.lon = 0;

    const center = centroidLatLon(geo);
    if (!center) return;

    let maxSpan = 10;
    for (const n of geo) {
      maxSpan = Math.max(maxSpan, angularDistanceDeg(center.lat, center.lon, n.lat, n.lon));
    }
    /* Light framing only — stay near default distance, just center the region */
    const framed = 2.05 + (maxSpan / 80) * 0.45;
    const endDist = Math.max(1.95, Math.min(DEFAULT_DIST + 0.25, framed));

    if (!this.reducedMotion && geo.length > 1) {
      this._journeyCam = {
        active: true,
        points: geo.map((n) => ({ lat: n.lat, lon: n.lon })),
        endLat: center.lat,
        endLon: center.lon,
        endDist,
      };
      this.focus(geo[0].lat, geo[0].lon);
      this.targetDistance = Math.min(endDist + 0.12, DEFAULT_DIST + 0.15);
    } else {
      this._journeyCam = null;
      this.focus(center.lat, center.lon);
      this.targetDistance = endDist;
    }
    this.onZoom?.(this.getZoomFactor());
  }

  setTrajectory(nodes, selectedNode = null) {
    this.setGraph({ nodes: nodes || [], arcs: null }, selectedNode);
  }

  /** @param {{nodes: any[], arcs?: any[]}} payload */
  setGraph(payload, selectedNode = null) {
    const nodes = payload?.nodes || [];
    this.trajectory = nodes;
    if (Array.isArray(payload?.arcs) && payload.arcs.length) {
      this.arcs = payload.arcs;
    } else {
      /* Empty [] is truthy — still fall back to consecutive mapped nodes */
      this.arcs = [];
      for (let i = 0; i < nodes.length - 1; i++) {
        this.arcs.push({
          from: nodes[i],
          to: nodes[i + 1],
          epistemic: nodes[i + 1].status || "attested",
          schematic: true,
          color: nodes[i + 1].color,
        });
      }
    }
    this.selectedIdx = selectedNode ? this.trajectory.indexOf(selectedNode) : nodes.length ? 0 : -1;
    if (selectedNode && this.selectedIdx < 0 && selectedNode.id != null) {
      this.selectedIdx = this.trajectory.findIndex((n) => n.id === selectedNode.id);
    }
    this.animProgress = this.reducedMotion ? 1 : 0;
    this._animTarget = 1;
    this._manualTimeline = false;
    this._journeyStart = performance.now();
    /* ~1.35s per hop so travel between locations stays readable */
    const hops = Math.max(1, Math.max(nodes.length - 1, this.arcs.length));
    this._journeyDuration = this.reducedMotion
      ? 0
      : Math.min(16000, 1800 + hops * 1350);
    if (!nodes.length) {
      this.setIdleSpin(true);
      this._journeyCam = null;
    }
    this._rebuildOverlay();
  }

  setSelected(node) {
    if (!node) {
      this.selectedIdx = -1;
    } else {
      let idx = this.trajectory.indexOf(node);
      if (idx < 0 && node.id != null) {
        idx = this.trajectory.findIndex((n) => n.id === node.id);
      }
      this.selectedIdx = idx;
    }
    this._updateMarkerScales();
    this._paintLabelSelection();
  }

  _paintLabelSelection() {
    if (!this.labelLayer) return;
    [...this.labelLayer.children].forEach((el) => {
      const i = Number(el.dataset.idx);
      el.classList.toggle("selected", i === this.selectedIdx);
      el.classList.toggle("hover", i === this.hoverIdx);
      el.setAttribute("aria-pressed", i === this.selectedIdx ? "true" : "false");
    });
    this._labelsDirty = true;
  }

  _selectIndex(i) {
    if (i < 0 || i >= this.trajectory.length) return;
    this.selectedIdx = i;
    const n = this.trajectory[i];
    if (n?.lat != null) this.focus(n.lat, n.lon);
    this._updateMarkerScales();
    this._paintLabelSelection();
    this.onSelect?.(n);
  }

  setTimelineProgress(t) {
    this._animTarget = Math.max(0, Math.min(1, t));
    this._manualTimeline = true;
    this._journeyDuration = 0;
    if (this._journeyCam) this._journeyCam.active = false;
    if (this.reducedMotion) this.animProgress = this._animTarget;
  }

  _clearGroup(g) {
    while (g.children.length) {
      const c = g.children.pop();
      c.geometry?.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose();
      }
    }
  }

  _rebuildOverlay() {
    this._clearGroup(this.markers);
    this._clearGroup(this.routes);
    this._markerByIdx.clear();
    this._labelsDirty = true;
    const nodes = this.trajectory;
    if (!nodes.length) {
      this._syncLabels();
      return;
    }

    const arcCount = Math.max(this.arcs.length, 1);
    this.arcs.forEach((arc, ai) => {
      const a = arc.from;
      const b = arc.to;
      if (!a || !b || a.lat == null || b.lat == null) return;
      const pts = greatCirclePoints(a.lat, a.lon, b.lat, b.lon, 96);
      if (pts.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(pts);
      const color = boostColor(arc.color || b.color);
      const uncertain =
        arc.epistemic === "disputed" ||
        arc.epistemic === "reconstructed" ||
        arc.epistemic === "uncertain";

      const group = new THREE.Group();
      group.userData.arcIndex = ai;
      group.userData.appearAt = ai / arcCount;
      group.userData.curve = curve;
      group.userData.kind = "arc";

      const glowGeo = new THREE.TubeGeometry(curve, 80, uncertain ? 0.0032 : 0.004, 6, false);
      const glowMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.userData.role = "glow";
      glow.userData.fullIndexCount = glowGeo.index ? glowGeo.index.count : 0;
      group.add(glow);

      const coreGeo = new THREE.TubeGeometry(curve, 80, uncertain ? 0.0014 : 0.0018, 5, false);
      const coreMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: uncertain ? 0.75 : 0.95,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.userData.role = "core";
      core.userData.fullIndexCount = coreGeo.index ? coreGeo.index.count : 0;
      group.add(core);

      /* bright traveler that flows along the route */
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.0065, 8, 8),
        new THREE.MeshBasicMaterial({
          color: 0xfff6e8,
          transparent: true,
          opacity: 0.9,
        })
      );
      const pulseHalo = new THREE.Mesh(
        new THREE.SphereGeometry(0.011, 8, 8),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        })
      );
      pulse.add(pulseHalo);
      pulse.userData.role = "pulse";
      pulse.position.copy(curve.getPoint(0));
      group.add(pulse);

      this.routes.add(group);
    });

    nodes.forEach((n, i) => {
      if (n.lat == null) return;
      const g = new THREE.Group();
      g.position.copy(latLonToVector3(n.lat, n.lon, EARTH_RADIUS * 1.014));
      g.userData.idx = i;
      g.userData.appearAt = nodes.length <= 1 ? 0 : i / (nodes.length - 1);

      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 12, 10),
        new THREE.MeshBasicMaterial({
          color: hexColor(n.color),
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        })
      );
      glow.userData.role = "markerGlow";
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.0095, 12, 10),
        new THREE.MeshBasicMaterial({ color: hexColor(n.color) })
      );
      core.userData.role = "markerCore";
      g.add(glow);
      g.add(core);
      if (n.status === "reconstructed" || n.epistemic === "reconstructed") {
        const hole = new THREE.Mesh(
          new THREE.SphereGeometry(0.0038, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xfbf9f2 })
        );
        g.add(hole);
      }
      g.userData.baseScale = 1;
      this.markers.add(g);
      this._markerByIdx.set(i, g);
    });

    this._updateMarkerScales();
    this._syncLabels();
  }

  _updateMarkerScales() {
    this.markers.children.forEach((g) => {
      const i = g.userData.idx;
      const sel = i === this.selectedIdx;
      const hov = i === this.hoverIdx;
      g.userData.baseScale = sel ? 1.45 : hov ? 1.2 : 1;
    });
  }

  _syncLabels() {
    if (!this.labelLayer) return;
    this.labelLayer.replaceChildren();
    this.trajectory.forEach((n, i) => {
      if (n.lat == null) return;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "globe-label" + (i === this.selectedIdx ? " selected" : "");
      const form = n.term || n.form || "";
      const place = n.place || n.region || n.lang || n.language || "";
      const lang = n.lang || n.language || "";
      el.setAttribute(
        "aria-label",
        `Select ${form}${place ? `, ${place}` : ""}${lang && lang !== place ? ` (${lang})` : ""} on the lineage`
      );
      el.setAttribute("aria-pressed", i === this.selectedIdx ? "true" : "false");
      el.innerHTML =
        `<span class="globe-label-stem" aria-hidden="true"></span>` +
        `<span class="globe-label-idx">${String(n.idx).padStart(2, "0")}</span>` +
        `<span class="globe-label-form"></span>` +
        (place ? `<span class="globe-label-lang"></span>` : "");
      el.querySelector(".globe-label-form").textContent = form;
      const langEl = el.querySelector(".globe-label-lang");
      if (langEl) langEl.textContent = place;
      el.dataset.idx = String(i);
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._selectIndex(i);
      });
      this.labelLayer.appendChild(el);
    });
    /* Measure once after mount — avoids layout thrash in the render loop */
    [...this.labelLayer.children].forEach((el) => {
      el.style.display = "flex";
      el.style.visibility = "hidden";
      el.style.left = "0px";
      el.style.top = "0px";
      el._rw = el.offsetWidth;
      el._rh = el.offsetHeight;
    });
    this._placeLabels();
  }

  _placeLabels() {
    if (!this.labelLayer) return;
    const layerRect = this.labelLayer.getBoundingClientRect();
    const w = layerRect.width || this.canvas.clientWidth || innerWidth;
    const h = layerRect.height || this.canvas.clientHeight || innerHeight;
    const GAP = 5;
    const SIDE = 18;
    const MARGIN = 8;
    const worldPos = this._scratchWorld;
    const normal = this._scratchNormal;
    const view = this._scratchView;
    const projected = this._scratchProjected;

    const items = [];
    [...this.labelLayer.children].forEach((el) => {
      const i = Number(el.dataset.idx);
      const n = this.trajectory[i];
      const marker = this._markerByIdx.get(i);
      if (!n || (marker && marker.visible === false)) {
        el.style.display = "none";
        return;
      }
      latLonToVector3(n.lat, n.lon, EARTH_RADIUS * 1.035, worldPos);
      worldPos.applyMatrix4(this.globe.matrixWorld);
      normal.copy(worldPos).normalize();
      view.copy(this.camera.position).normalize();
      if (normal.dot(view) <= 0.05) {
        el.style.display = "none";
        return;
      }
      projected.copy(worldPos).project(this.camera);
      if (projected.z > 1) {
        el.style.display = "none";
        return;
      }
      const sx = (projected.x * 0.5 + 0.5) * w;
      const sy = (-projected.y * 0.5 + 0.5) * h;
      el.style.display = "flex";
      el.classList.toggle("selected", i === this.selectedIdx);
      el.classList.toggle("hover", i === this.hoverIdx);
      items.push({
        el,
        i,
        sx,
        sy,
        rw: el._rw || el.offsetWidth,
        rh: el._rh || el.offsetHeight,
      });
    });

    /* Prefer right side; fall back left / staggered vertical when clustered */
    items.sort((a, b) => a.sy - b.sy || a.sx - b.sx || a.i - b.i);
    const placed = [];

    const overlaps = (a, b) =>
      a.left < b.right + GAP &&
      a.right + GAP > b.left &&
      a.top < b.bottom + GAP &&
      a.bottom + GAP > b.top;

    const clampBox = (left, top, rw, rh) => {
      const L = Math.max(MARGIN, Math.min(w - rw - MARGIN, left));
      const T = Math.max(MARGIN, Math.min(h - rh - MARGIN, top));
      return { left: L, top: T, right: L + rw, bottom: T + rh };
    };

    for (const item of items) {
      const { el, sx, sy, rw, rh } = item;
      const preferRight = sx < w * 0.62;
      const sides = preferRight
        ? [
            { side: "right", left: sx + SIDE, top: sy - rh / 2 },
            { side: "left", left: sx - SIDE - rw, top: sy - rh / 2 },
          ]
        : [
            { side: "left", left: sx - SIDE - rw, top: sy - rh / 2 },
            { side: "right", left: sx + SIDE, top: sy - rh / 2 },
          ];

      let best = null;
      let bestSide = preferRight ? "right" : "left";

      outer: for (const cand of sides) {
        for (let step = 0; step < 16; step++) {
          const dir = step % 2 === 0 ? 1 : -1;
          const mag = Math.ceil(step / 2);
          const top = cand.top + dir * mag * (rh + GAP);
          const box = clampBox(cand.left, top, rw, rh);
          if (!placed.some((p) => overlaps(p, box))) {
            best = box;
            bestSide = cand.side;
            break outer;
          }
        }
      }

      if (!best) {
        best = clampBox(sx + SIDE, sy - rh / 2, rw, rh);
        bestSide = "right";
      }

      placed.push(best);
      el.dataset.side = bestSide;
      el.style.left = `${best.left}px`;
      el.style.top = `${best.top}px`;
      el.style.visibility = "visible";

      const stem = el.querySelector(".globe-label-stem");
      if (stem) {
        const ax = bestSide === "right" ? 0 : rw;
        const ay = rh / 2;
        const dx = sx - best.left - ax;
        const dy = sy - best.top - ay;
        const len = Math.hypot(dx, dy);
        stem.style.left = `${ax}px`;
        stem.style.top = `${ay}px`;
        stem.style.width = `${Math.max(0, len - 3)}px`;
        stem.style.transform = `translate(0, -50%) rotate(${Math.atan2(dy, dx)}rad)`;
      }
    }
  }

  _applyCamera() {
    const pos = latLonToVector3(this.rot.lat, this.rot.lon, this.distance);
    this.camera.position.copy(pos);
    this.camera.lookAt(0, 0, 0);
    this.camera.up.set(0, 1, 0);
  }

  _bindPointer() {
    const c = this.canvas;
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const pointers = new Map();

    const pick = (clientX, clientY) => {
      const rect = c.getBoundingClientRect();
      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, this.camera);
      const hits = raycaster.intersectObjects(this.markers.children, true);
      if (!hits.length) return -1;
      let obj = hits[0].object;
      while (obj && obj.userData.idx == null) obj = obj.parent;
      return obj?.userData.idx ?? -1;
    };

    const setHover = (nearest) => {
      if (nearest === this.hoverIdx) return;
      this.hoverIdx = nearest;
      c.style.cursor = this.dragging ? "grabbing" : nearest >= 0 ? "pointer" : "grab";
      this._updateMarkerScales();
      this._paintLabelSelection();
    };

    const pinchDist = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    c.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture?.(e.pointerId);
      this.vel.lat = 0;
      this.vel.lon = 0;

      if (pointers.size === 2) {
        this.dragging = false;
        this.pointer = null;
        this._pinch = { dist: pinchDist(), distance: this.targetDistance };
        c.style.cursor = "grabbing";
        return;
      }

      this.dragging = true;
      this.pointer = {
        x: e.clientX,
        y: e.clientY,
        px: e.clientX,
        py: e.clientY,
        moved: false,
      };
      c.style.cursor = "grabbing";
    });

    c.addEventListener("pointermove", (e) => {
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this._pinch && pointers.size >= 2) {
        const d = pinchDist();
        if (d > 0 && this._pinch.dist > 0) {
          const ratio = this._pinch.dist / d;
          this.targetDistance = Math.max(
            MIN_DIST,
            Math.min(MAX_DIST, this._pinch.distance * ratio)
          );
          this.onZoom?.(this.getZoomFactor());
        }
        return;
      }

      if (this.dragging && this.pointer) {
        const dx = e.clientX - this.pointer.px;
        const dy = e.clientY - this.pointer.py;
        if (Math.abs(e.clientX - this.pointer.x) + Math.abs(e.clientY - this.pointer.y) > 3) {
          this.pointer.moved = true;
        }
        const sens = this._panSensitivity();
        const dLon = -dx * sens;
        const dLat = dy * sens * 0.85;
        this.target.lon += dLon;
        this.target.lat = Math.max(-85, Math.min(85, this.target.lat + dLat));
        this.vel.lon = dLon;
        this.vel.lat = dLat;
        this.pointer.px = e.clientX;
        this.pointer.py = e.clientY;
      } else if (pointers.size === 0) {
        setHover(pick(e.clientX, e.clientY));
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) this._pinch = null;
      if (pointers.size === 1) {
        const remaining = [...pointers.entries()][0];
        this.dragging = true;
        this.pointer = {
          x: remaining[1].x,
          y: remaining[1].y,
          px: remaining[1].x,
          py: remaining[1].y,
          moved: true,
        };
        return;
      }
      if (!this.dragging) {
        c.style.cursor = "grab";
        return;
      }
      this.dragging = false;
      if (this.pointer && !this.pointer.moved) {
        const nearest = pick(e.clientX, e.clientY);
        if (nearest >= 0) this._selectIndex(nearest);
      } else {
        /* light coast — decay in _loop */
        this.vel.lon *= 0.85;
        this.vel.lat *= 0.85;
      }
      this.pointer = null;
      c.style.cursor = "grab";
    };

    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      this._pinch = null;
      this.dragging = false;
      this.pointer = null;
      c.style.cursor = "grab";
    });

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= 800;
        /* Distance-proportional zoom: smooth on trackpads, gentler when close */
        const factor = Math.exp(dy * 0.00115);
        this.targetDistance = Math.max(
          MIN_DIST,
          Math.min(MAX_DIST, this.targetDistance * factor)
        );
        this.onZoom?.(this.getZoomFactor());
      },
      { passive: false }
    );
  }

  _loop() {
    const journeying = !this.reducedMotion && this.animProgress < 0.999 && this._journeyDuration > 0;
    /* Snap while dragging; softer glide otherwise — even softer during journey intro */
    const ease = this.reducedMotion
      ? 1
      : this.dragging || this._pinch
        ? 0.42
        : journeying
          ? 0.045
          : 0.16;
    const zoomEase = this.reducedMotion ? 1 : this._pinch ? 0.35 : journeying ? 0.04 : 0.2;

    if (!this.dragging && !this._pinch && !this.reducedMotion) {
      const speed = Math.hypot(this.vel.lat, this.vel.lon);
      if (speed > 0.002) {
        this.target.lon += this.vel.lon;
        this.target.lat = Math.max(-85, Math.min(85, this.target.lat + this.vel.lat));
        this.vel.lon *= 0.9;
        this.vel.lat *= 0.9;
      } else {
        this.vel.lat = 0;
        this.vel.lon = 0;
        if (this.idleSpin) {
          this.target.lon += this.idleSpinSpeed;
          /* Keep spin lat gently near default so idle view stays pleasant */
          this.target.lat += (DEFAULT_LAT - this.target.lat) * 0.01;
        }
      }
    }

    /* Timed ease-in-out intro; after that (or slider scrub) ease toward target */
    if (this.reducedMotion) {
      this.animProgress = this._animTarget;
    } else if (!this._manualTimeline && this._journeyDuration > 0) {
      /* Linear time → equal duration per hop (not global ease, which rushes mid-path) */
      const u = (performance.now() - this._journeyStart) / this._journeyDuration;
      this.animProgress = Math.min(this._animTarget, Math.max(0, Math.min(1, u)));
      if (u >= 1) this._journeyDuration = 0;
    } else {
      this.animProgress += (this._animTarget - this.animProgress) * 0.1;
      if (Math.abs(this._animTarget - this.animProgress) < 0.002) this.animProgress = this._animTarget;
    }

    /* Camera rides each hop slowly: dwell → crawl → settle, then frame the region */
    if (this._journeyCam?.active && !this.dragging && !this._pinch) {
      const jc = this._journeyCam;
      const pts = jc.points;
      const hopCount = Math.max(1, pts.length - 1);
      if (this.animProgress < 0.995 && pts.length > 1) {
        const f = pacedHopPosition(this.animProgress, hopCount);
        const i = Math.min(hopCount - 1, Math.floor(f));
        const t = f - i;
        const a = pts[i];
        const b = pts[i + 1];
        this.target.lat = a.lat + (b.lat - a.lat) * t;
        this.target.lon = lerpAngleDeg(a.lon, b.lon, t);
        this.targetDistance += (jc.endDist - this.targetDistance) * 0.015;
      } else {
        this.focus(jc.endLat, jc.endLon);
        this.targetDistance = jc.endDist;
        if (this.animProgress >= 1) jc.active = false;
      }
    }

    this.rot.lat += (this.target.lat - this.rot.lat) * ease;
    this.rot.lon += (this.target.lon - this.rot.lon) * (this.idleSpin && !this.dragging ? 0.08 : ease);
    this.distance += (this.targetDistance - this.distance) * zoomEase;
    if (Math.abs(this.rot.lat - this.target.lat) < 0.005) this.rot.lat = this.target.lat;
    if (Math.abs(this.rot.lon - this.target.lon) < 0.005) this.rot.lon = this.target.lon;
    if (Math.abs(this.distance - this.targetDistance) < 0.0005) this.distance = this.targetDistance;

    /* denser mesh wire when close */
    if (this._wireLod) this._setWireLod(this.distance < 1.85);

    this._applyCamera();
    this.root.rotation.set(0, 0, 0);

    if (!this.reducedMotion) this._flowT += 0.008;

    const hopCount = Math.max(1, this.arcs.length);
    const paced = pacedHopPosition(this.animProgress, hopCount);
    this.routes.children.forEach((group) => {
      const ai = group.userData.arcIndex ?? 0;
      const local = Math.max(0, Math.min(1, paced - ai));
      const draw = local;
      const visible = paced >= ai - 0.02;
      group.visible = visible;

      const curve = group.userData.curve;
      group.children.forEach((child) => {
        const role = child.userData.role;
        if (role === "core" || role === "glow") {
          const full = child.userData.fullIndexCount || (child.geometry.index ? child.geometry.index.count : 0);
          if (full && child.geometry.setDrawRange) {
            child.geometry.setDrawRange(0, Math.max(3, Math.floor(full * draw)));
          }
          if (child.material) {
            const base = role === "glow" ? 0.2 : 0.92;
            child.material.opacity = visible ? base * (0.4 + 0.6 * draw) : 0;
          }
        }
        if (role === "pulse" && curve) {
          if (this.reducedMotion || local < 0.08) {
            child.visible = false;
            return;
          }
          child.visible = true;
          const u = (((this._flowT * 0.85 + (group.userData.arcIndex || 0) * 0.23) % 1) * draw);
          child.position.copy(curve.getPointAt(Math.max(0.001, Math.min(0.999, u))));
          const pulse = 0.85 + 0.18 * Math.sin(this._flowT * 10 + (group.userData.arcIndex || 0));
          child.scale.setScalar(pulse);
        }
      });
    });
    this.markers.children.forEach((g) => {
      const idx = g.userData.idx ?? 0;
      /* Marker appears as its hop begins (first marker at 0) */
      const local = Math.max(0, Math.min(1, paced - (idx - 1) + 0.15));
      const appear = easeInOutQuint(Math.min(1, local * 1.4));
      g.visible = appear > 0.02;
      const base = g.userData.baseScale || 1;
      /* Soft breath — staggered per marker; respect reduced motion */
      const breath = this.reducedMotion
        ? 1
        : 1 + 0.07 * Math.sin(this._flowT * 2.4 + (g.userData.idx || 0) * 0.85);
      const pop = 0.25 + 0.75 * appear;
      g.scale.setScalar(base * breath * pop);
      g.children.forEach((child) => {
        if (child.userData.role === "markerGlow" && child.material) {
          const pulse = this.reducedMotion
            ? 0.32
            : 0.26 + 0.1 * Math.sin(this._flowT * 2.4 + (g.userData.idx || 0) * 0.85);
          child.material.opacity = pulse * appear;
        }
      });
    });

    this.renderer.render(this.scene, this.camera);

    const camMoved =
      Math.abs(this.rot.lat - this._lastLabelCam.lat) > 0.02 ||
      Math.abs(this.rot.lon - this._lastLabelCam.lon) > 0.02 ||
      Math.abs(this.distance - this._lastLabelCam.dist) > 0.002;
    const animating = this.animProgress < 0.999;
    if (this._labelsDirty || camMoved || this.dragging || this._pinch || animating) {
      this._placeLabels();
      this._lastLabelCam.lat = this.rot.lat;
      this._lastLabelCam.lon = this.rot.lon;
      this._lastLabelCam.dist = this.distance;
      this._labelsDirty = false;
    }

    this._raf = requestAnimationFrame(this._loop);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.renderer.dispose();
  }
}
