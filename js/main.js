import { Globe } from "./globe.js";
import {
  searchWord,
  selectCandidate,
  normalizeQuery,
  setMultiSource,
  getMultiSource,
} from "./pipeline.js";
import {
  toGlobePayload,
  topologicalOrder,
  STATUS_LABEL,
  cleanForm,
  isUnrecordedForm,
  needsRomanization,
  stripDisplayText,
  buildLineageSummary,
  countUncertainLinks,
  approxLanguageSpan,
  isBadGapText,
  sanitizeRecordGaps,
} from "./model.js";
import { atlasStats, ATLAS_META, GEO_DISCLAIMER } from "./languages.js";
import { listSourceCredits } from "./sources/index.js";
import { enrichNodeRomanizations } from "./sources/wiktionary.js";
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

const RECENT_KEY = "lx_recent_searches";
const RECENT_MAX = 8;

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(word) {
  const w = String(word || "").trim();
  if (!w) return;
  const next = [w, ...loadRecent().filter((x) => x.toLowerCase() !== w.toLowerCase())].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

function showRecentSearches() {
  const input = $("searchInput");
  if (!input || input.value.trim()) return;
  const recent = loadRecent();
  if (!recent.length) {
    hideTypeahead();
    return;
  }
  showTypeahead(recent, "Recent");
}

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

function showTypeahead(items, heading = "") {
  const list = $("typeaheadList");
  const input = $("searchInput");
  if (!list || !input) return;
  list.replaceChildren();
  if (!items.length) {
    hideTypeahead();
    return;
  }
  if (heading) {
    const h = document.createElement("div");
    h.className = "typeahead-heading";
    h.textContent = heading;
    list.appendChild(h);
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
  onSuggestions: (items) => {
    if ($("searchInput")?.value.trim()) showTypeahead(items);
    else hideTypeahead();
  },
  onClear: () => {
    if (document.activeElement === $("searchInput") && !$("searchInput")?.value.trim()) {
      showRecentSearches();
    } else hideTypeahead();
  },
});

function syncClearBtn() {
  const btn = $("searchClear");
  if (!btn) return;
  btn.hidden = !String($("searchInput")?.value || "").trim();
}

$("searchInput")?.addEventListener("input", syncClearBtn);
$("searchInput")?.addEventListener("focus", () => {
  if (!$("searchInput").value.trim()) showRecentSearches();
});
$("searchInput")?.addEventListener("blur", () => {
  setTimeout(hideTypeahead, 150);
});
$("searchClear")?.addEventListener("click", () => {
  const input = $("searchInput");
  if (!input) return;
  input.value = "";
  syncClearBtn();
  hideTypeahead();
  input.focus();
  showRecentSearches();
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

function syncPanelToggle(minimized) {
  const btn = $("panelToggle");
  const tab = $("panelTabTitle");
  const eyebrow = $("panelEyebrow");
  if (btn) {
    btn.textContent = minimized ? "+" : "−";
    btn.setAttribute("aria-expanded", minimized ? "false" : "true");
    btn.setAttribute("aria-label", minimized ? "Expand panel" : "Minimize panel");
    btn.title = minimized ? "Expand panel" : "Minimize panel";
  }
  if (tab) {
    const label = stripDisplayText(active?.word || active?.queryOriginal || "Word");
    tab.textContent = label;
    tab.hidden = !minimized;
  }
  if (eyebrow) eyebrow.hidden = !!minimized;
}

function setPanelMinimized(on) {
  const panel = $("infoPanel");
  if (!panel || !panel.classList.contains("visible")) return;
  panel.classList.toggle("minimized", !!on);
  syncPanelToggle(!!on);
}

function setPanelOpen(on, { minimized = false } = {}) {
  const panel = $("infoPanel");
  if (!panel) return;
  panel.classList.toggle("visible", !!on);
  if (!on) panel.classList.remove("minimized");
  else panel.classList.toggle("minimized", !!minimized);
  panel.setAttribute("aria-hidden", on ? "false" : "true");
  if (on) panel.removeAttribute("inert");
  else panel.setAttribute("inert", "");
  if (on) syncPanelToggle(!!minimized);
}

function recordNeedsRomanization(record) {
  return (record?.nodes || []).some(
    (n) => needsRomanization(n.form) && !String(n.transliteration || "").trim()
  );
}

/** Backfill Latin readings for cached lineages that predate {{xlit}} enrichment. */
async function ensureRomanizations(record) {
  if (!record || !navigator.onLine || !recordNeedsRomanization(record)) return false;
  try {
    await enrichNodeRomanizations(record.nodes || []);
  } catch {
    return false;
  }
  const filled = (record.nodes || []).some((n) => String(n.transliteration || "").trim());
  if (filled && record.cacheKey) {
    try {
      const { fromCache: _fc, ...toStore } = record;
      await putEntry(record.cacheKey, toStore);
    } catch {
      /* ignore cache write failures */
    }
  }
  return filled;
}

function showRecord(record, opts = {}) {
  active = sanitizeRecordGaps(record);
  if (Object.prototype.hasOwnProperty.call(opts, "siblings")) {
    pendingCandidates = opts.siblings?.length ? opts.siblings : null;
  } else {
    pendingCandidates = null;
  }
  const payload = toGlobePayload(record);
  const ordered = topologicalOrder(record.nodes, record.edges);
  selectedNode = payload.nodes[0] || ordered[0] || null;

  $("searchInput").value = record.queryOriginal || record.word;
  syncClearBtn();
  setPanelOpen(true, { minimized: false });
  $("emptyNote").style.display = "none";
  if ($("canvasHint")) $("canvasHint").hidden = true;

  if (payload.hasGeo) {
    globe.setGraph(payload, selectedNode);
    globe.frameRegion(payload.nodes);
    zoom = globe.getZoomFactor();
    $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
    if (payload.hasPath) {
      $("coordsLabel").textContent = `${payload.nodes.length} mapped · ${record.word.toUpperCase()} · schematic routes`;
      $("noGeoNote").hidden = true;
    } else {
      $("coordsLabel").textContent = `1 mapped · ${record.word.toUpperCase()} · single form`;
      $("noGeoNote").textContent =
        "Only one form is mapped — no path between languages. Globe is resting on that location.";
      $("noGeoNote").hidden = false;
    }
  } else {
    globe.setGraph({ nodes: [], arcs: [] });
    globe.setIdleSpin(true);
    $("coordsLabel").textContent = `No map path · ${record.word.toUpperCase()}`;
    $("noGeoNote").textContent =
      "Evidence does not support a meaningful map path — see lineage below.";
    $("noGeoNote").hidden = false;
  }
  renderPanel();
  const shown = active;
  ensureRomanizations(shown).then((changed) => {
    if (!changed || active !== shown) return;
    renderPanel();
  });
}

function wiktionaryUrl(record) {
  const c = (record.citations || []).find((x) => x.url && /wiktionary/i.test(x.url + (x.dataset || "")));
  if (c?.url) return c.url;
  const title = record.word || record.queryOriginal || record.query;
  return title ? `https://en.wiktionary.org/wiki/${encodeURIComponent(title)}` : null;
}

function candidateMatchesRecord(c, r) {
  if (!c || !r) return false;
  if (r.candidateId && c.id && r.candidateId === c.id) return true;
  const sameLang = (c.languageCode || "en") === (r.languageCode || "en");
  if (sameLang && c.sense && r.sense && c.sense === r.sense) return true;
  if (sameLang && c.meta?.etyIndex != null && /etymology\s+(\d+)/i.test(r.sense || "")) {
    const m = /etymology\s+(\d+)/i.exec(r.sense);
    if (m && Number(m[1]) - 1 === c.meta.etyIndex) return true;
  }
  return false;
}

function renderEtymAlternatives() {
  const host = $("etymAlternatives");
  if (!host) return;
  host.replaceChildren();
  const list = pendingCandidates;
  if (!list || list.length < 2 || !active) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const intro = document.createElement("div");
  intro.className = "etym-alts-intro";
  intro.textContent = `${list.length} etymologies — choose a sense:`;
  host.appendChild(intro);

  list.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "etym-alt" + (candidateMatchesRecord(c, active) ? " on" : "");
    b.innerHTML =
      `<span class="etym-alt-row"><strong></strong><em></em></span>` +
      `<span class="etym-alt-gloss"></span>`;
    const pos = c.pos ? String(c.pos).toLowerCase() : "";
    const sense = c.sense || "Entry";
    const senseLabel = /^etymology$/i.test(sense.trim())
      ? `Etymology ${i + 1}`
      : sense;
    b.querySelector("strong").textContent = pos
      ? `${c.lemma} · ${pos}`
      : `${c.lemma} · ${c.language || "English"}`;
    b.querySelector("em").textContent = senseLabel;
    const gloss = stripDisplayText(c.gloss || "");
    const detail =
      gloss && !/^english\b/i.test(gloss) && gloss !== sense ? gloss : "";
    b.querySelector(".etym-alt-gloss").textContent = detail || senseLabel;
    b.disabled = candidateMatchesRecord(c, active);
    b.addEventListener("click", async () => {
      if (candidateMatchesRecord(c, active)) return;
      const siblings = pendingCandidates;
      setLoading(true, `Loading ${c.lemma} (${sense})…`);
      try {
        const record = await selectCandidate(c, {
          original: lastQuery || c.lemma,
          query: normalizeQuery(lastQuery || c.lemma).keyForm,
        });
        if (record?.cancelled) return;
        setLoading(false);
        setMessage("");
        showRecord(record, { siblings });
      } catch (e) {
        setLoading(false);
        setMessage(e.message || "Failed to load entry.");
      }
    });
    host.appendChild(b);
  });
}

function renderPanel() {
  const r = active;
  if (!r) return;
  const N = topologicalOrder(r.nodes, r.edges);
  const titleEl = $("panelTitle");
  const headForm = stripDisplayText(r.word);
  const headNode =
    [...N].reverse().find((n) => cleanForm(n.form) === cleanForm(r.word)) ||
    N[N.length - 1] ||
    r.nodes[r.nodes.length - 1];
  const headRoman = stripDisplayText(headNode?.transliteration || "");
  titleEl.replaceChildren();
  titleEl.append(document.createTextNode(headForm || "—"));
  if (headRoman && needsRomanization(headForm) && headRoman.toLowerCase() !== headForm.toLowerCase()) {
    const rom = document.createElement("span");
    rom.className = "word-roman";
    rom.textContent = headRoman;
    titleEl.append(document.createTextNode(" "));
    titleEl.append(rom);
  }
  $("panelDefinition").textContent = stripDisplayText(r.definition) || "Definition unavailable.";
  renderEtymAlternatives();
  const mapped = N.filter((n) => n.lat != null && n.lon != null);
  const unmapped = N.filter((n) => n.lat == null || n.lon == null);
  const summary = buildLineageSummary(r);
  const gapEl = $("gapNote");
  gapEl.replaceChildren();
  if (summary) {
    const p = document.createElement("p");
    p.className = "lineage-summary";
    p.textContent = summary;
    gapEl.appendChild(p);
  }
  (r.gaps || []).forEach((g) => {
    const t = stripDisplayText(g);
    if (
      !t ||
      isBadGapText(t) ||
      /geographic association|language heartland|language range|not a documented travel/i.test(t)
    ) {
      return;
    }
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = t;
    gapEl.appendChild(p);
  });
  if (unmapped.length) {
    const p = document.createElement("p");
    p.className = "note map-count";
    const langs = [...new Set(unmapped.map((n) => n.language || cleanForm(n.form) || "?"))];
    p.textContent = `${mapped.length} of ${N.length} forms mapped. Unmapped: ${langs.join(", ")}.`;
    gapEl.appendChild(p);
  } else if (N.length) {
    const p = document.createElement("p");
    p.className = "note map-count";
    p.textContent = `${mapped.length} of ${N.length} forms mapped.`;
    gapEl.appendChild(p);
  }
  const wiki = wiktionaryUrl(r);
  if (wiki) {
    const a = document.createElement("a");
    a.className = "wiki-link";
    a.href = wiki;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Read the full etymology on Wiktionary";
    gapEl.appendChild(a);
  }

  const span = approxLanguageSpan(N);
  $("statSteps").textContent = N.length;
  $("statSpan").textContent = span
    ? span.years >= 1000
      ? (span.years / 1000).toFixed(1) + "k yrs"
      : span.years + " yrs"
    : "—";
  $("statSpanLabel").textContent = "Language period";
  $("statRegions").textContent = countUncertainLinks(r);
  $("timelineCount").textContent = N.length ? `01 — ${String(N.length).padStart(2, "0")}` : "—";

  const legend = $("heartlandLegend");
  if (legend) {
    const hasHeartland = N.some((n) => n.geoBasis === "language_heartland");
    legend.hidden = !hasHeartland;
    if (hasHeartland) {
      legend.textContent =
        "Geographic association = language heartland (inferred). Some positions are approximate or reconstructed — see per-stage notes.";
    }
  }

  const tl = $("panelTimeline");
  tl.replaceChildren();
  N.forEach((n) => {
    const el = document.createElement("button");
    el.type = "button";
    const isSel =
      selectedNode && (n === selectedNode || (n.id != null && n.id === selectedNode.id));
    el.className = "timeline-item" + (isSel ? " selected" : "");
    el.style.setProperty("--node", n.color || "#9a988e");
    el.innerHTML =
      '<div class="lang-era"></div><div class="term"></div><div class="place"></div><div class="tag"></div>';
    const unrecorded = isUnrecordedForm(n);
    const form = unrecorded ? "Unrecorded form" : cleanForm(n.form);
    const era =
      !unrecorded && n.yearStart != null
        ? n.yearStart < 0
          ? `${-n.yearStart} BCE`
          : `${n.yearStart} CE`
        : "";
    const region = n.region || "";
    el.querySelector(".lang-era").textContent = `${n.language}${region ? " · " + region : ""}${
      era ? " · language period c. " + era : ""
    }`;
    const termEl = el.querySelector(".term");
    termEl.replaceChildren();
    termEl.append(document.createTextNode(form));
    const roman = !unrecorded ? stripDisplayText(n.transliteration) : "";
    if (
      roman &&
      needsRomanization(form) &&
      roman.toLowerCase() !== form.toLowerCase() &&
      roman.toLowerCase() !== form.replace(/^\*/, "").toLowerCase()
    ) {
      const rom = document.createElement("span");
      rom.className = "term-roman";
      rom.textContent = roman;
      termEl.append(document.createTextNode(" "));
      termEl.append(rom);
    }
    const pl = el.querySelector(".place");
    const gloss = stripDisplayText(n.gloss);
    if (gloss) {
      pl.className = "place gloss";
      pl.textContent = "“" + gloss + "”";
    } else pl.remove();
    const tg = el.querySelector(".tag");
    const epi = unrecorded ? "unknown" : n.epistemic || "attested";
    const c = document.createElement("span");
    c.className = "st " + epi;
    c.textContent = STATUS_LABEL[epi] || epi;
    tg.append(c);
    const conf = n.geoConfidence || (n.lat == null ? "unavailable" : "precise");
    if (conf && conf !== "precise") {
      const confTag = document.createElement("span");
      confTag.className = "st geo-" + conf;
      confTag.textContent =
        conf === "approximate"
          ? "Approx. position"
          : conf === "uncertain"
            ? "Uncertain homeland"
            : conf === "period_only"
              ? "Period (parent region)"
              : "Unmapped";
      tg.append(confTag);
    }
    const note = stripDisplayText(n.note);
    const disclaimer = GEO_DISCLAIMER[conf] || "";
    const shownNotes = [];
    if (note && !/geographic association|language heartland|language range/i.test(note)) {
      shownNotes.push(note);
    }
    if (disclaimer && !shownNotes.some((t) => t.includes(disclaimer.slice(0, 20)))) {
      shownNotes.push(disclaimer);
    }
    shownNotes.forEach((t) => {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = t;
      tg.append(d);
    });
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
      const ff = isUnrecordedForm(from) ? "Unrecorded form" : cleanForm(from.form);
      const tf = isUnrecordedForm(to) ? "Unrecorded form" : cleanForm(to.form);
      row.querySelector(".le-from").textContent = `${ff} (${from.language})`;
      row.querySelector(".le-rel").textContent = `${e.type} · ${e.epistemic}${e.schematic ? " · schematic" : ""}${
        e.bridged ? " · bridged" : ""
      }`;
      row.querySelector(".le-to").textContent = `${tf} (${to.language})`;
      lg.appendChild(row);
    });
    if (!r.edges.length) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "No relationship edges recorded — lineage view limited to forms listed above.";
      lg.appendChild(empty);
    }
  }

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
  const stats = atlasStats();
  const atlasLine =
    stats.withCoords > 0
      ? ` Language atlas: ${stats.withCoords.toLocaleString()} mapped / ${stats.total.toLocaleString()} codes (Wiktionary + Glottolog).`
      : "";
  $("attrib").innerHTML =
    `Sources: ${(r.sourcesUsed || []).join(", ") || "—"}${cached}. ` +
    `Wiktionary content © contributors · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>. ` +
    `Heartlands: <a href="https://glottolog.org/" target="_blank" rel="noopener">Glottolog</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.` +
    atlasLine +
    ` Routes are schematic language associations, not attested itineraries.`;

  $("arcLegend")?.removeAttribute("hidden");
}

function renderCandidates(list, original) {
  pendingCandidates = list;
  const box = document.createElement("div");
  box.className = "candidate-list";
  const intro = document.createElement("div");
  intro.className = "candidate-intro";
  intro.textContent = `Multiple senses for “${original}”. Choose one:`;
  box.appendChild(intro);
  list.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "candidate";
    b.innerHTML = `<strong></strong><em></em><span></span>`;
    const pos = c.pos ? String(c.pos).toLowerCase() : "";
    const sense = c.sense || "Entry";
    b.querySelector("strong").textContent = pos
      ? `${c.lemma} · ${pos}`
      : `${c.lemma} · ${c.language || "English"}`;
    b.querySelector("em").textContent = sense;
    const gloss = stripDisplayText(c.gloss || "");
    const detail = gloss && !/^english\b/i.test(gloss) && gloss !== sense ? gloss : "";
    b.querySelector("span").textContent = detail || `${c.sourceId || "wiktionary"}`;
    b.addEventListener("click", async () => {
      setLoading(true, `Loading ${c.lemma} (${sense})…`);
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
  $("searchInput")?.blur();
  setLoading(true, navigator.onLine ? "Searching dictionaries…" : "Checking local cache…");
  $("retryBtn").hidden = true;
  /* Keep current word as a docked tab while a new search runs */
  if (active) setPanelMinimized(true);
  syncClearBtn();

  const result = await searchWord(query, {
    onProgress: (m) => setLoading(true, m),
  });

  if (result.status === "cancelled") return;

  setLoading(false);

  if (result.status === "ready") {
    if (result.warning) toast(result.warning);
    setMessage("");
    pushRecent(result.record.queryOriginal || result.record.word || query);
    showRecord(result.record);
    return;
  }
  if (result.status === "candidates") {
    const list = result.candidates;
    const first = list[0];
    setLoading(true, `Loading ${first.lemma} (${first.sense || "entry"})…`);
    try {
      const record = await selectCandidate(first, {
        original: result.original || query,
        query: result.query || query,
      });
      if (record?.cancelled) return;
      setLoading(false);
      setMessage("");
      pushRecent(result.original || record.queryOriginal || record.word || query);
      showRecord(record, { siblings: list });
    } catch (e) {
      setLoading(false);
      /* Fallback: picker under search if auto-load fails */
      renderCandidates(list, result.original || query);
      setMessage(e.message || "Choose a sense below.");
    }
    return;
  }
  if (result.status === "suggestions") {
    const wrap = document.createElement("div");
    wrap.className = "suggest-wrap";
    const intro = document.createElement("div");
    intro.className = "suggest-intro";
    intro.textContent = `No exact Wiktionary page for “${query}”. Closest titles:`;
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
      setMessage(`No Wiktionary entry found for “${query}”.`);
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
/* Keep Journey slider in lockstep with arc/marker draw animation */
globe.onTimeline = (t) => {
  const el = $("timelineRange");
  if (!el || document.activeElement === el) return;
  el.value = String(Math.round(t * 100));
};
function updateZoom() {
  $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
  globe.setZoomFactor(zoom);
}

$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  typeahead.cancel();
  hideTypeahead();
  $("searchInput")?.blur();
  chooseWord($("searchInput").value);
});

$("retryBtn").addEventListener("click", () => chooseWord(lastQuery || $("searchInput").value));

function togglePanelMinimized() {
  const panel = $("infoPanel");
  if (!panel?.classList.contains("visible") || !active) return;
  setPanelMinimized(!panel.classList.contains("minimized"));
}

$("panelToggle")?.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePanelMinimized();
});

$("infoPanel")?.addEventListener("click", (e) => {
  const panel = $("infoPanel");
  if (!panel?.classList.contains("minimized")) return;
  if (e.target.closest("#panelToggle")) return;
  setPanelMinimized(false);
});

$("infoPanel")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const panel = $("infoPanel");
  if (!panel?.classList.contains("minimized")) return;
  e.preventDefault();
  setPanelMinimized(false);
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
  const stats = atlasStats();
  const tag = ATLAS_META.glottologTag ? ` · ${ATLAS_META.glottologTag}` : "";
  const atlas = document.createElement("li");
  atlas.innerHTML =
    `<a href="https://glottolog.org/" target="_blank" rel="noopener">Glottolog</a> language heartlands (CC BY 4.0) + Wiktionary language modules (CC BY-SA 4.0)` +
    (stats.total
      ? ` — atlas ${stats.withCoords.toLocaleString()} mapped / ${stats.total.toLocaleString()} codes${tag}`
      : "") +
    `.`;
  list.appendChild(atlas);
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
    else if (
      $("infoPanel")?.classList.contains("visible") &&
      !$("infoPanel").classList.contains("minimized")
    ) {
      setPanelMinimized(true);
    }
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
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => reg.update())
      .catch(() => {
      /* ignore — HTTP context / unsupported */
    });
  });
}
