import { Globe } from "./globe.js";
import {
  searchWord,
  selectCandidate,
  normalizeQuery,
  setMultiSource,
  getMultiSource,
} from "./pipeline.js";
import { toGlobePayload, topologicalOrder, STATUS_LABEL } from "./model.js";
import { listSourceCredits } from "./sources/index.js";
import { createTypeahead } from "./typeahead.js";
import {
  importJson,
  exportJson,
  clearEntries,
  listEntries,
  putEntry,
  cacheKey,
  migrateLegacyLocalStorage,
} from "./db.js";

const $ = (id) => document.getElementById(id);

const canvas = $("globeCanvas");
const labelLayer = $("globeLabels");
const globe = new Globe(canvas, labelLayer);

let active = null;
let selectedNode = null;
let zoom = 1;
let lastToast = 0;
let pendingCandidates = null;
let lastQuery = "";

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(lastToast);
  lastToast = setTimeout(() => $("toast").classList.remove("show"), 2800);
}

function updateOnlineStatus() {
  const el = $("status");
  if (!el) return;
  if (navigator.onLine) {
    el.textContent = getMultiSource() ? "Live · Multi-source" : "Live · Wiktionary";
    el.classList.remove("offline");
  } else {
    el.textContent = "Offline · Cache";
    el.classList.add("offline");
  }
}
updateOnlineStatus();
addEventListener("online", updateOnlineStatus);
addEventListener("offline", updateOnlineStatus);

const multiToggle = $("multiSourceToggle");
if (multiToggle) {
  multiToggle.checked = getMultiSource();
  multiToggle.addEventListener("change", () => {
    setMultiSource(multiToggle.checked);
    updateOnlineStatus();
    toast(multiToggle.checked ? "Multi-source on (slower)" : "Wiktionary only");
  });
}

function hideTypeahead() {
  const list = $("typeaheadList");
  if (!list) return;
  list.hidden = true;
  list.replaceChildren();
  $("searchInput")?.setAttribute("aria-expanded", "false");
}

function showTypeahead(items) {
  const list = $("typeaheadList");
  const input = $("searchInput");
  if (!list || !input) return;
  list.replaceChildren();
  if (!items.length) {
    hideTypeahead();
    return;
  }
  items.forEach((word, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "typeahead-item";
    btn.setAttribute("role", "option");
    btn.id = `typeahead-opt-${i}`;
    btn.textContent = word;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = word;
      hideTypeahead();
      chooseWord(word);
    });
    list.appendChild(btn);
  });
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

const typeahead = createTypeahead({
  input: $("searchInput"),
  onSuggestions: (items) => showTypeahead(items),
  onClear: hideTypeahead,
});

$("searchInput")?.addEventListener("blur", () => {
  setTimeout(hideTypeahead, 150);
});

function setMessage(htmlOrText, isHtml = false) {
  const msg = $("searchMessage");
  if (isHtml) msg.innerHTML = htmlOrText;
  else msg.textContent = htmlOrText;
}

function setLoading(on, label = "Looking up…") {
  const area = $("searchArea");
  area?.classList.toggle("loading", on);
  $("searchInput")?.setAttribute("aria-busy", on ? "true" : "false");
  if (on) {
    const safe = String(label).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    setMessage(
      `<div class="loading-state" role="status" aria-live="polite">` +
        `<span class="spinner" aria-hidden="true"></span>` +
        `<span class="loading-text">${safe}</span>` +
        `</div>`,
      true
    );
  }
}

function setPanelOpen(on) {
  const panel = $("infoPanel");
  if (!panel) return;
  panel.classList.toggle("visible", !!on);
  panel.setAttribute("aria-hidden", on ? "false" : "true");
  if (on) panel.removeAttribute("inert");
  else panel.setAttribute("inert", "");
}

function showRecord(record) {
  active = record;
  pendingCandidates = null;
  const payload = toGlobePayload(record);
  const ordered = topologicalOrder(record.nodes, record.edges);
  selectedNode = payload.nodes[0] || ordered[0] || null;

  $("searchInput").value = record.queryOriginal || record.word;
  setPanelOpen(true);
  $("emptyNote").style.display = "none";

  if (payload.hasGeo) {
    globe.setGraph(payload, selectedNode);
    globe.frameRegion(payload.nodes);
    zoom = globe.getZoomFactor();
    $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
    $("coordsLabel").textContent = `${payload.nodes.length} mapped · ${record.word.toUpperCase()} · schematic routes`;
    $("noGeoNote").hidden = true;
  } else {
    globe.setGraph({ nodes: [], arcs: [] });
    $("coordsLabel").textContent = `No map path · ${record.word.toUpperCase()}`;
    $("noGeoNote").hidden = false;
  }
  renderPanel();
}

function renderPanel() {
  const r = active;
  if (!r) return;
  $("panelTitle").textContent = r.word;
  $("panelDefinition").textContent = r.definition || "Definition unavailable.";
  $("gapNote").textContent = (r.gaps || []).join(" ");

  const N = topologicalOrder(r.nodes, r.edges);
  const ys = N.map((n) => n.yearStart).filter((y) => y != null);
  $("statSteps").textContent = N.length;
  $("statSpan").textContent =
    ys.length > 1
      ? ((v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k yrs" : v + " yrs"))(2026 - Math.min(...ys))
      : "—";
  $("statRegions").textContent = r.edges.filter((e) => e.epistemic !== "attested").length;
  $("timelineCount").textContent = N.length ? `01 — ${String(N.length).padStart(2, "0")}` : "—";

  const tl = $("panelTimeline");
  tl.replaceChildren();
  N.forEach((n) => {
    const el = document.createElement("button");
    el.type = "button";
    const isSel =
      selectedNode &&
      (n === selectedNode || (n.id != null && n.id === selectedNode.id));
    el.className = "timeline-item" + (isSel ? " selected" : "");
    el.style.setProperty("--node", n.color || "#9a988e");
    el.innerHTML =
      '<div class="lang-era"></div><div class="term"></div><div class="place"></div><div class="tag"></div>';
    const era =
      n.yearStart != null
        ? n.yearStart < 0
          ? `${-n.yearStart} BCE`
          : `${n.yearStart} CE`
        : "";
    const region = n.region || "";
    el.querySelector(".lang-era").textContent = `${n.language}${region ? " · " + region : ""}${era ? " · c. " + era : ""}`;
    el.querySelector(".term").textContent = n.form + (n.transliteration ? ` (${n.transliteration})` : "");
    const pl = el.querySelector(".place");
    if (n.gloss) {
      pl.className = "place gloss";
      pl.textContent = "“" + n.gloss + "”";
    } else if (region) {
      pl.textContent = region;
    } else pl.remove();
    const tg = el.querySelector(".tag");
    const c = document.createElement("span");
    c.className = "st " + (n.epistemic || "attested");
    c.textContent = STATUS_LABEL[n.epistemic] || n.epistemic;
    tg.append(c);
    if (n.geoBasis === "language_heartland") {
      const g = document.createElement("span");
      g.className = "st inferred_geo";
      g.textContent = STATUS_LABEL.inferred_geo;
      tg.append(g);
    }
    if (n.note) {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = n.note;
      tg.append(d);
    }
    el.addEventListener("click", () => {
      selectedNode = n;
      if (n.lat != null) {
        globe.focus(n.lat, n.lon);
        globe.setSelected(n);
      }
      renderPanel();
      requestAnimationFrame(() => {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
    tl.appendChild(el);
  });

  /* lineage graph (non-geo) */
  const lg = $("lineageGraph");
  if (lg) {
    lg.replaceChildren();
    r.edges.forEach((e) => {
      const from = r.nodes.find((n) => n.id === e.fromId);
      const to = r.nodes.find((n) => n.id === e.toId);
      if (!from || !to) return;
      const row = document.createElement("div");
      row.className = "lineage-edge";
      row.innerHTML = `<span class="le-from"></span><span class="le-rel"></span><span class="le-to"></span>`;
      row.querySelector(".le-from").textContent = `${from.form} (${from.language})`;
      row.querySelector(".le-rel").textContent = `${e.type} · ${e.epistemic}${e.schematic ? " · schematic" : ""}`;
      row.querySelector(".le-to").textContent = `${to.form} (${to.language})`;
      lg.appendChild(row);
    });
    if (!r.edges.length) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "No relationship edges recorded — lineage view limited to forms listed above.";
      lg.appendChild(empty);
    }
  }

  /* sources drawer */
  const src = $("sourcesList");
  if (src) {
    src.replaceChildren();
    (r.citations || []).forEach((c) => {
      const item = document.createElement("div");
      item.className = "source-item";
      item.innerHTML = `<strong></strong><div class="note"></div><div class="attrib"></div>`;
      item.querySelector("strong").textContent = c.title;
      const meta = [];
      if (c.url) meta.push(`<a href="${c.url}" target="_blank" rel="noopener">Open source</a>`);
      if (c.dataset) meta.push(c.dataset);
      if (c.license) meta.push(c.license);
      if (c.retrievedAt) meta.push("Retrieved " + c.retrievedAt.slice(0, 10));
      item.querySelector(".note").innerHTML = meta.join(" · ");
      item.querySelector(".attrib").textContent = [c.attribution, c.transform].filter(Boolean).join(" — ");
      src.appendChild(item);
    });
    if (!(r.citations || []).length) {
      src.innerHTML = '<p class="note">No citations attached to this record.</p>';
    }
  }

  const cached = r.fromCache ? " · from local cache" : "";
  $("attrib").innerHTML =
    `Sources: ${(r.sourcesUsed || []).join(", ") || "—"}${cached}. ` +
    `Routes are schematic language associations, not attested itineraries.`;
}

function renderCandidates(list, original) {
  pendingCandidates = list;
  const box = document.createElement("div");
  box.className = "candidate-list";
  const intro = document.createElement("div");
  intro.textContent = `Multiple entries for “${original}”. Choose one:`;
  box.appendChild(intro);
  list.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "candidate";
    b.innerHTML = `<strong></strong><span></span>`;
    b.querySelector("strong").textContent = `${c.lemma} · ${c.language}`;
    b.querySelector("span").textContent = `${c.sense}${c.gloss ? " — " + c.gloss : ""} · ${c.sourceId}`;
    b.addEventListener("click", async () => {
      setLoading(true, `Loading ${c.lemma} from ${c.sourceId}…`);
      try {
        const record = await selectCandidate(c, { original, query: normalizeQuery(original).keyForm });
        if (record?.cancelled) return;
        setLoading(false);
        setMessage("");
        showRecord(record);
      } catch (e) {
        setLoading(false);
        setMessage(e.message || "Failed to load entry.");
      }
    });
    box.appendChild(b);
  });
  $("searchMessage").replaceChildren(box);
}

async function chooseWord(raw) {
  typeahead.cancel();
  hideTypeahead();
  lastQuery = raw;
  const { query } = normalizeQuery(raw);
  if (!query) return;
  setLoading(true, navigator.onLine ? "Searching dictionaries…" : "Checking local cache…");
  $("retryBtn").hidden = true;
  setPanelOpen(false);

  const result = await searchWord(query, {
    onProgress: (m) => setLoading(true, m),
  });

  if (result.status === "cancelled") return;

  setLoading(false);

  if (result.status === "ready") {
    if (result.warning) toast(result.warning);
    setMessage("");
    showRecord(result.record);
    return;
  }
  if (result.status === "candidates") {
    renderCandidates(result.candidates, result.original || query);
    return;
  }
  if (result.status === "suggestions") {
    const wrap = document.createElement("div");
    wrap.className = "suggest-wrap";
    const intro = document.createElement("div");
    intro.className = "suggest-intro";
    intro.textContent = `No English entry for “${query}”. Try:`;
    wrap.appendChild(intro);
    const row = document.createElement("div");
    row.className = "suggest-row";
    const seen = new Set();
    result.suggestions.forEach((s) => {
      const lemma = String(s.lemma || "").trim();
      const key = lemma.toLowerCase();
      if (!lemma || seen.has(key) || key === query.toLowerCase()) return;
      seen.add(key);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = lemma;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        $("searchInput").value = lemma;
        chooseWord(lemma);
      });
      row.append(b);
    });
    if (!row.childElementCount) {
      setMessage(`No English entry found for “${query}”.`);
      return;
    }
    wrap.appendChild(row);
    $("searchMessage").replaceChildren(wrap);
    return;
  }
  if (result.status === "miss") {
    setMessage(result.message || "No entry found.");
    return;
  }
  if (result.status === "error") {
    setMessage(result.message || "Lookup failed.");
    $("retryBtn").hidden = !result.retryable;
    return;
  }
}

/* Globe callbacks */
globe.onZoom = (factor) => {
  zoom = Math.max(0.7, Math.min(2, factor));
  $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
};
globe.onSelect = (n) => {
  selectedNode = n;
  renderPanel();
  requestAnimationFrame(() => {
    const item = $("panelTimeline")?.querySelector(".timeline-item.selected");
    item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
};

function updateZoom() {
  $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
  globe.setZoomFactor(zoom);
}

$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  typeahead.cancel();
  hideTypeahead();
  chooseWord($("searchInput").value);
});

$("retryBtn").addEventListener("click", () => chooseWord(lastQuery || $("searchInput").value));

$("closePanel").addEventListener("click", () => {
  setPanelOpen(false);
  active = null;
  selectedNode = null;
  globe.setGraph({ nodes: [], arcs: [] });
  globe.setIdleSpin(true);
  globe.targetDistance = Math.max(globe.targetDistance, 2.05);
  zoom = globe.getZoomFactor();
  $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
  $("emptyNote").style.display = "";
  $("coordsLabel").textContent = "Earth · Vector wireframe · Natural Earth";
  $("searchInput").value = "";
  setMessage("");
  $("noGeoNote").hidden = true;
});

$("resetBtn").addEventListener("click", () => {
  globe.resetView();
  if (!active) globe.setIdleSpin(true);
  zoom = globe.getZoomFactor();
  $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
  toast("Globe view reset");
});
$("zoomIn").addEventListener("click", () => {
  zoom = Math.min(2, zoom + 0.15);
  updateZoom();
});
$("zoomOut").addEventListener("click", () => {
  zoom = Math.max(0.7, zoom - 0.15);
  updateZoom();
});

$("timelineRange")?.addEventListener("input", (e) => {
  globe.setTimelineProgress(Number(e.target.value) / 100);
});

/* Sources / about drawers */
let aboutReturnFocus = null;

function openAboutModal() {
  const dlg = $("aboutModal");
  if (!dlg) return;
  aboutReturnFocus = document.activeElement;
  const list = $("creditsList");
  list.replaceChildren();
  listSourceCredits().forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<a href="${s.homepage}" target="_blank" rel="noopener"></a> — <span></span>`;
    li.querySelector("a").textContent = s.name;
    li.querySelector("span").textContent = `${s.license}; ${s.attribution}`;
    list.appendChild(li);
  });
  const geo = document.createElement("li");
  geo.innerHTML =
    `<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> land & coastline (1:50m, public domain) — B&W topographic wireframe rendered in-app.`;
  list.appendChild(geo);
  const three = document.createElement("li");
  three.textContent = "three.js (MIT) via jsDelivr CDN.";
  list.appendChild(three);
  if (typeof dlg.showModal === "function") dlg.showModal();
  else {
    dlg.setAttribute("open", "");
    dlg.classList.add("open");
  }
}

function closeAboutModal() {
  const dlg = $("aboutModal");
  if (!dlg) return;
  if (typeof dlg.close === "function" && dlg.open) dlg.close();
  else {
    dlg.removeAttribute("open");
    dlg.classList.remove("open");
  }
  aboutReturnFocus?.focus?.();
  aboutReturnFocus = null;
}

$("aboutBtn").addEventListener("click", () => openAboutModal());

$("aboutModal")?.addEventListener("close", () => {
  aboutReturnFocus?.focus?.();
  aboutReturnFocus = null;
});

$("sourcesToggle")?.addEventListener("click", () => {
  $("sourcesDrawer")?.classList.toggle("open");
});

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.close === "aboutModal") closeAboutModal();
  });
});

/* Cache tools */
$("exportCache")?.addEventListener("click", async () => {
  const data = await exportJson();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lexicon-earth-cache-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${data.entries.length} entries`);
});

$("importCache")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = await importJson(data);
    toast(`Imported ${n} entries`);
    await refreshCacheList();
  } catch (err) {
    toast(err.message || "Import failed");
  }
  e.target.value = "";
});

$("clearCache")?.addEventListener("click", async () => {
  if (!confirm("Clear all cached etymology records from this browser?")) return;
  await clearEntries();
  toast("Cache cleared");
  await refreshCacheList();
  await seedStarter(true);
});

async function refreshCacheList() {
  const el = $("cacheList");
  if (!el) return;
  const rows = await listEntries();
  el.textContent = rows.length ? `${rows.length} cached entries` : "Cache empty";
}

async function seedStarter(force = false) {
  const rows = await listEntries();
  if (!force && rows.length) return;
  try {
    const res = await fetch("./data/starter.json");
    if (!res.ok) return;
    const data = await res.json();
    for (const record of data.entries || []) {
      const key = cacheKey(record.query, record.languageCode || "en", record.id || "starter");
      record.cacheKey = key;
      record.cachedAt = record.cachedAt || Date.now();
      await putEntry(key, record);
    }
    toast("Starter etymologies ready offline");
  } catch {
    /* ignore */
  }
  await refreshCacheList();
}

$("loadStarter")?.addEventListener("click", async () => {
  await seedStarter(true);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const dlg = $("aboutModal");
    if (dlg?.open) closeAboutModal();
    else if ($("infoPanel")?.classList.contains("visible")) $("closePanel")?.click();
  }
  if (e.key === "/" && document.activeElement !== $("searchInput")) {
    e.preventDefault();
    $("searchInput").focus();
  }
});

updateZoom();
migrateLegacyLocalStorage()
  .then(() => seedStarter(false))
  .then(refreshCacheList);

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* ignore — HTTP context / unsupported */
    });
  });
}
