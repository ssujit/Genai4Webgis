/* ---------------------------
  GENIA — Geospatial Natural-language Interaction Assistant (parking.js)

  Purpose
  - Frontend logic for the chat-driven WebGIS prototype (Leaflet-based).
  - Implements deterministic GIS functions (load layers, zoom, filter, measure).
  - Consumes backend /chat JSON that contains:
      { reply: string, actions: [ ... ] }
  - Displays explainability metadata next to assistant messages.

  Architecture note (important for thesis)
  - The LLM does NOT execute GIS operations directly.
  - The LLM only proposes structured actions.
  - This file deterministically executes those actions using Leaflet/JS.

  Key modules inside this file
  1) UI bindings (sidebar, theme, menus)
  2) Leaflet map + basemap switching
  3) Layer registry + attribute table
  4) WFS loading + session restore
  5) Parking loading via active WFS datasource (bbox/radius)
  6) Chat UI + explainability rendering
  7) Location resolver (geocode/device/map center)

  NOTE: Comments were added for GitHub readability. No logic changed.
---------------------------- */

console.log("parking.js loaded");

/* ====== Config toggles ====== */

// If your backend API key isn't ready, set this to false to skip loading /api/parking.
// (Currently kept for compatibility, but your active flow uses WFS + bbox.)
const USE_BACKEND_PARKING = false;

/* ====== DOM refs ======
   All UI elements are queried once to avoid repeated DOM lookups.
*/

const lastUpdatedEl = document.getElementById("last-updated");
const mapEl = document.getElementById("map");

// Sidebar
const sidebar = document.getElementById("sidebar");
const addMenu = document.getElementById("addMenu");
const btnAddData = document.getElementById("btnAddData");
const btnCollapse = document.getElementById("btnCollapse");
const fileInput = document.getElementById("fileInput");
const layerList = document.getElementById("layerList");

// WFS modal
const wfsModal = document.getElementById("wfsModal");
const wfsCancel = document.getElementById("wfsCancel");
const wfsConnect = document.getElementById("wfsConnect");
const wfsStatus = document.getElementById("wfsStatus");
const wfsFullUrl = document.getElementById("wfsFullUrl");
const wfsLayerName = document.getElementById("wfsLayerName");

// Chat
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");

// Basemap trigger/menu
const bmTrigger = document.getElementById("bm-trigger");
const bmMenu = document.getElementById("bm-menu");

// === Theme / loader / toast helpers ===
const themeToggle = document.getElementById("theme-toggle");
const loader = document.getElementById("loader");
const toastArea = document.getElementById("toasts");

/**
 * Show or hide the global loader overlay.
 * @param {boolean} on
 */
function showLoader(on=true){ if(loader) loader.style.display = on ? "flex" : "none"; }

/**
 * Lightweight toast notifications for UX feedback.
 * @param {string} msg
 * @param {"ok"|"warn"|"err"} type
 * @param {number} ms
 */
function toast(msg, type="ok", ms=2600){
  if(!toastArea) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastArea.appendChild(el);
  setTimeout(()=> el.remove(), ms);
}

// ----- Sidebar 3-dot menu -----
// Provides quick actions: reset map, clear layers, clear chat, about dialog.
const sbMenuBtn = document.getElementById("sbMenuBtn");
const sbMenu = document.getElementById("sbMenu");

if (sbMenuBtn && sbMenu) {
  // Toggle menu open/close
  sbMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sbMenu.classList.toggle("sb-menu-hidden");
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!sbMenu.contains(e.target) && e.target !== sbMenuBtn) {
      sbMenu.classList.add("sb-menu-hidden");
    }
  });

  // Handle click on menu items
  sbMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".sb-menu-item");
    if (!item) return;

    const action = item.dataset.action;
    sbMenu.classList.add("sb-menu-hidden");

    switch (action) {
      case "reset":
        // Default map extent (set to your preferred demo region).
        map.setView([48.7758, 9.1829], 12);
        break;

      case "clearLayers":
        // Clears the legacy array-based registry if present.
        // Your primary registry in this file is `userLayers` (Map), but this is kept
        // for backwards compatibility and quick clearing.
        if (window.userLayers) {
          window.userLayers.forEach((l) => map.removeLayer(l));
          window.userLayers.length = 0;
        }
        if (window.layerList) {
          window.layerList.innerHTML = "";
        }
        break;

      case "clearChat":
        if (window.chatLog) {
          window.chatLog.innerHTML = "";
        }
        break;

      case "about":
        alert(
          "GENIA – Geospatial Natural-language Interaction Assistant\n\n" +
          "Prototype local LLM-based WebGIS for your Master's thesis.\n" +
          "Tech: Leaflet, WFS, OSM, Flask, Ollama."
        );
        break;
    }
  });
}


// Init & toggle theme (persist)
// Theme is stored in localStorage so it survives page reloads.
(function initTheme(){
  const t = localStorage.getItem("theme") || "dark";
  document.documentElement.setAttribute("data-theme", t);
})();
themeToggle?.addEventListener("click", ()=>{
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
});


/* ====== Map & basemaps ======
   Leaflet map creation + base layer switching UI.
*/

const map = L.map("map", { zoomControl: true }).setView([48.7758, 9.1829], 13);

let osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors",
});

let carto = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  { maxZoom: 20, attribution: "&copy; OpenStreetMap, &copy; CARTO" }
);

// === Measure tool ===
// Provides a simple 2-point straight-line distance tool for manual map interaction.
const measureBtn = document.getElementById("measureBtn");
if (measureBtn) {
  measureBtn.addEventListener("click", () => {
    measureActive = !measureActive;
    measureBtn.classList.toggle("active", measureActive);

    // reset state when turning off
    if (!measureActive) {
      if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
      measureMarkers.forEach(m => map.removeLayer(m));
      measureMarkers = [];
      measureStart = null;
      toast && toast("Measure off","ok");
    } else {
      toast && toast("Click two points on the map to measure","ok");
    }
  });
}

// Click handler: pick two points and measure
map.on("click", (e) => {
  if (!measureActive) return;

  if (!measureStart) {
    // First point
    measureStart = e.latlng;
    const m1 = L.circleMarker(measureStart, {radius:6, weight:2}).addTo(map);
    measureMarkers.push(m1);
  } else {
    // Second point -> compute & draw
    const p2 = e.latlng;
    const dist = map.distance(measureStart, p2); // meters
    if (measureLine) map.removeLayer(measureLine);
    measureLine = L.polyline([measureStart, p2], {weight:3, dashArray:"6,6"}).addTo(map);

    const m2 = L.circleMarker(p2, {radius:6, weight:2}).addTo(map);
    measureMarkers.push(m2);

    // Popup at midpoint
    const mid = L.latLng(
      (measureStart.lat + p2.lat) / 2,
      (measureStart.lng + p2.lng) / 2
    );
    L.popup({autoClose:true, closeOnClick:false})
      .setLatLng(mid)
      .setContent(`<b>${fmtMeters(dist)}</b>`)
      .openOn(map);

    // Prepare for a new measurement (two-point tool)
    measureStart = null;
  }
});

// ESC to cancel current measurement
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    measureStart = null;
    if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
    measureMarkers.forEach(m => map.removeLayer(m));
    measureMarkers = [];
    toast && toast("Measurement cleared","warn");
  }
});


/**
 * Snap a clicked point to the nearest feature in a given layer.
 * Useful when user wants “click near point” interactions.
 * NOTE: Not enabled by default; call this inside map.on("click") if needed.
 */
function snapToLayer(latlng, srcLayer, px=20){
  if (!srcLayer) return latlng;
  let best = { ll: latlng, d: Infinity };
  const p0 = map.latLngToContainerPoint(latlng);
  srcLayer.eachLayer(l => {
    const ll = l.getLatLng ? l.getLatLng()
              : (l.getBounds ? l.getBounds().getCenter() : null);
    if (!ll) return;
    const p = map.latLngToContainerPoint(ll);
    const d = p.distanceTo(p0);
    if (d < best.d) best = { ll, d };
  });
  return best.d <= px ? best.ll : latlng;
}
// then inside map.on("click", e) use:
// const clicked = snapToLayer(e.latlng, window._lastDataLayer)  || e.latlng;


// Satellite: Esri World Imagery (free, no key)
let sat = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics"
  }
);

// Start with OSM by default
let currentBase = osm.addTo(map);

// Floating basemap picker behavior (UI-only)
bmTrigger?.addEventListener("click", (e) => {
  e.stopPropagation();
  bmMenu.style.display = (bmMenu.style.display === "none" || !bmMenu.style.display) ? "grid" : "none";
});
document.addEventListener("click", (e) => {
  if (!bmMenu.contains(e.target) && e.target !== bmTrigger) {
    bmMenu.style.display = "none";
  }
});
bmMenu?.querySelectorAll(".bm-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    // UI state
    bmMenu.querySelectorAll(".bm-opt").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // swap base layer
    if (currentBase) map.removeLayer(currentBase);
    const key = btn.dataset.base;
    const next = { osm, carto, sat }[key] || osm;
    currentBase = next.addTo(map);

    bmMenu.style.display = "none";
  });
});

/* ====== Active datasource (persisted) ======
   The chat actions like "loadParking" rely on having an active datasource.
   This prototype uses a WFS GetFeature URL that is stored in sessionStorage.
*/
let ACTIVE_DS = JSON.parse(sessionStorage.getItem("active.datasource") || "null");
// ACTIVE_DS = { kind:"wfs", url:"...", auth:{ mode:"query"|"header", name:"key", value:"TOKEN" } }

/**
 * Persist an active datasource for the current session.
 * @param {object|null} ds
 */
function setActiveDataSource(ds) {
  ACTIVE_DS = ds;
  sessionStorage.setItem("active.datasource", JSON.stringify(ds));
  toast("Datasource set.", "ok");
}

// Optional auth helpers (kept simple; safe no-op if unused)
/**
 * If datasource auth is query-based, append auth token as a URL parameter.
 */
function applyAuthToUrl(url) {
  if (!ACTIVE_DS || !ACTIVE_DS.auth || ACTIVE_DS.auth.mode !== "query") return url;
  const u = new URL(url, location.origin);
  u.searchParams.set(ACTIVE_DS.auth.name, ACTIVE_DS.auth.value);
  return u.toString();
}
/**
 * If datasource auth is header-based, inject headers into fetch init.
 */
function applyAuthToFetchInit(init = {}) {
  if (!ACTIVE_DS || !ACTIVE_DS.auth || ACTIVE_DS.auth.mode !== "header") return init;
  return { ...init, headers: { ...(init.headers||{}), [ACTIVE_DS.auth.name]: ACTIVE_DS.auth.value } };
}

// BBOX helpers
// Used to reduce data transfer: query only the relevant area (radius around a location).
function kmToDegLat(km){ return km / 111.0; }
function kmToDegLon(km, lat){ const c = Math.cos(lat * Math.PI/180); return c ? km / (111.320*c) : 0; }
function urlWithBbox(baseUrl, lat, lon, radiusKm){
  const dy = kmToDegLat(radiusKm);
  const dx = kmToDegLon(radiusKm, lat);
  const minLon = lon - dx, minLat = lat - dy, maxLon = lon + dx, maxLat = lat + dy;
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}bbox=${minLon},${minLat},${maxLon},${maxLat},CRS:84`;
}


// Cluster layer for parking points (performance + decluttering)
const clusters = L.markerClusterGroup({
  spiderfyOnEveryZoom: false,
  showCoverageOnHover: false,
  disableClusteringAtZoom: 16,
});
map.addLayer(clusters);


/* ====== Sidebar: menu & collapse ====== */

btnAddData?.addEventListener("click", () => {
  addMenu.style.display = (addMenu.style.display === "none" || !addMenu.style.display) ? "block" : "none";
});

let collapsed = false;
btnCollapse?.addEventListener("click", () => {
  collapsed = !collapsed;
  sidebar.style.width = collapsed ? "56px" : "260px";
  mapEl.style.left = collapsed ? "56px" : "260px";
  btnCollapse.textContent = collapsed ? "⟩" : "⟨";
  addMenu.style.display = "none";
});


/* ====== Layer registry UI ======
   Maintains a lightweight client-side registry of user layers so they can be toggled,
   zoomed, removed, and opened in an attribute table (GIS-like UX).
*/

const userLayers = new Map(); // id -> { layer, name }
let layerAutoId = 1;

/**
 * Add a Leaflet layer to the sidebar list with:
 * - visibility toggle
 * - zoom button
 * - "more" menu (attribute table / remove)
 */
function addLayerToList(name, layer) {
  const id = `usr-${layerAutoId++}`;
  userLayers.set(id, { layer, name });

  const row = document.createElement("div");
  row.className = "layer-row";
  row.style.position = "relative";
  row.innerHTML = `
    <input type="checkbox" checked style="accent-color:#2d6cdf;" />
    <div class="name">${name}</div>
    <button class="btn-mini zoom" title="Zoom">Zoom</button>

    <button class="btn-mini more" title="Layer menu">⋮</button>
    <div class="layer-menu" style="display:none; position:absolute; right:10px; margin-top:36px;
        background:var(--bg-dark-2); border:1px solid var(--border-dark); border-radius:8px; overflow:hidden; z-index:5000;">
      <button class="layer-menu-item" data-act="table" style="width:100%; text-align:left; padding:10px 12px; background:transparent; color:var(--text-light); border:0; cursor:pointer;">Show attribute table</button>
      <button class="layer-menu-item" data-act="remove" style="width:100%; text-align:left; padding:10px 12px; background:transparent; color:var(--text-light); border:0; cursor:pointer;">Remove layer</button>
    </div>
  `;
  const chk = row.querySelector('input[type="checkbox"]');
  const btnZoom = row.querySelector(".btn-mini.zoom");
  const btnMore = row.querySelector(".btn-mini.more");
  const layerMenu = row.querySelector(".layer-menu");

  // Visibility toggle (add/remove from map)
  chk.addEventListener("change", () => {
    if (chk.checked) layer.addTo(map); else map.removeLayer(layer);
  });

  // Zoom to layer extent
  btnZoom.addEventListener("click", () => {
    try { map.fitBounds(layer.getBounds(), { padding: [20, 20] }); } catch {}
  });

  // Layer menu open/close
  btnMore.addEventListener("click", (e) => {
    e.stopPropagation();
    layerMenu.style.display = (layerMenu.style.display === "none" || !layerMenu.style.display) ? "block" : "none";
  });

  // Click outside closes menu
  document.addEventListener("click", () => {
    layerMenu.style.display = "none";
  });

  // Menu actions: attribute table / remove
  layerMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".layer-menu-item");
    if (!item) return;

    const act = item.dataset.act;
    layerMenu.style.display = "none";

    if (act === "table") {
      openAttributeTable(name, layer);
    }
    if (act === "remove") {
      map.removeLayer(layer);
      userLayers.delete(id);
      row.remove();
    }
  });

  layerList.prepend(row);
}


/* ====== Upload (GeoJSON) ======
   Lets users load their own local GeoJSON file into the map.
*/

document.getElementById("menuUpload")?.addEventListener("click", () => {
  addMenu.style.display = "none";
  fileInput.click();
});

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const gj = JSON.parse(text);
    const layer = L.geoJSON(gj, {
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, { radius: 5 }),
    }).addTo(map);
    addLayerToList(file.name.replace(/\.[^/.]+$/, ""), layer);
    try { map.fitBounds(layer.getBounds(), { padding: [20, 20] }); } catch {}
  } catch (err) {
    alert("Failed to load GeoJSON: " + err.message);
  } finally {
    fileInput.value = "";
  }
});


/* ====== WFS modal (Mundi-style) ======
   Loads a WFS GetFeature URL and restricts it to the current map extent via bbox.
   The loaded WFS becomes the active datasource for chat-driven operations.
*/

document.getElementById("menuWfs")?.addEventListener("click", () => {
  addMenu.style.display = "none";
  wfsModal.style.display = "flex";
  wfsFullUrl.value = "";
  wfsLayerName.value = "";
  wfsStatus.textContent = "";
});

wfsCancel?.addEventListener("click", () => {
  wfsModal.style.display = "none";
});

wfsConnect?.addEventListener("click", async () => {
  const urlInput = wfsFullUrl.value.trim();
  const name = wfsLayerName.value.trim() || "WFS Layer";
  if (!/^https?:\/\//i.test(urlInput)) {
    wfsStatus.textContent = "Please enter a valid WFS URL.";
    wfsStatus.style.color = "crimson";
    return;
  }
  
  // ---- Add map bounding box filter ----
  // This reduces network load and improves responsiveness during demos.
  const bounds = map.getBounds();
  const bboxParam = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()},CRS:84`;

  // If the user pasted a base URL (no bbox yet), append it
  const hasBbox = urlInput.includes("bbox=");
  const url = hasBbox
    ? urlInput  // user already defined bbox
    : urlInput.includes("?")
      ? `${urlInput}&bbox=${bboxParam}`
      : `${urlInput}?bbox=${bboxParam}`;

  console.log("Fetching WFS within current map view:", url);

  wfsStatus.textContent = "Loading WFS…";
  wfsStatus.style.color = "#aaa";

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const layer = L.geoJSON(data, {
      onEachFeature: (f, l) => {
        const p = f.properties || {};
        const html = Object.keys(p)
          .slice(0, 10)
          .map(k => `<b>${k}:</b> ${p[k]}`)
          .join("<br>");

        l.bindPopup(html);

        // Link map clicks to attribute table behavior (GIS-like inspection).
        l.on("click", () => {
          if (attrPanel && attrPanel.style.display !== "flex") {
            openAttributeTable("BW", window._lastDataLayer);
          }
          highlightTableRowByFeature(f);
        });
      },
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, { radius: 5 })
    }).addTo(map);

    addLayerToList(name, layer);

    // Store references for chat operations (filter, describe, count, search).
    window._lastDataLayer = layer; // keep a reference so chat can filter it

    // Make this layer the active datasource for chat-driven bbox fetches.
    setActiveDataSource({ kind:"wfs", url });

    // Persist layer for this session (reload restores it).
    try {
      const rec = { type:"wfs", name, url };
      const saved = JSON.parse(sessionStorage.getItem("layers.wfs") || "[]");
      saved.push(rec);
      sessionStorage.setItem("layers.wfs", JSON.stringify(saved));
      toast(`Added WFS layer: ${name}`,"ok");
    } catch {}

    try { map.fitBounds(layer.getBounds(), { padding: [20, 20] }); } catch {}

    wfsStatus.textContent = "Layer added successfully (within view).";
    wfsStatus.style.color = "lightgreen";
    setTimeout(() => (wfsModal.style.display = "none"), 400);
  } catch (err) {
    wfsStatus.textContent = "Failed: " + err.message;
    wfsStatus.style.color = "crimson";
  }
});

// Attribute Table Function
// Provides a GIS-like attribute table for the currently active layer.
const attrPanel = document.getElementById("attrPanel");
const attrTitle = document.getElementById("attrTitle");
const attrTable = document.getElementById("attrTable");
const attrClose = document.getElementById("attrClose");

attrClose?.addEventListener("click", () => {
  if (attrPanel) attrPanel.style.display = "none";
});

// sorting column in attribute table (GLOBAL)
let currentSort = { colIndex: null, dir: 1 }; // 1=asc, -1=desc

/**
 * Enable clickable column sorting in the attribute table.
 * Sorting is client-side (DOM reorder).
 */
function enableTableSorting() {
  const thead = attrTable.querySelector("thead");
  if (!thead) return;

  const headers = Array.from(thead.querySelectorAll("th"));

  headers.forEach((th) => {
    const label = th.textContent.trim();
    th.innerHTML = `
      <span class="th-label">${escapeHtml(label)}</span>
      <span class="th-sort" style="margin-left:6px; font-size:10px; opacity:.75;"></span>
    `;
    th.style.cursor = "pointer";
    th.style.userSelect = "none";
  });

  headers.forEach((th, colIndex) => {
    th.addEventListener("click", () => {
      if (currentSort.colIndex === colIndex) currentSort.dir = -currentSort.dir;
      else { currentSort.colIndex = colIndex; currentSort.dir = 1; }

      headers.forEach(h => {
        const s = h.querySelector(".th-sort");
        if (s) s.textContent = "";
      });
      th.querySelector(".th-sort").textContent = (currentSort.dir === 1) ? "▲" : "▼";

      const tbody = attrTable.querySelector("tbody");
      const rows = Array.from(tbody.querySelectorAll("tr"));

      rows.sort((a, b) => {
        const va = a.children[colIndex]?.textContent.trim() ?? "";
        const vb = b.children[colIndex]?.textContent.trim() ?? "";

        const na = parseFloat(va), nb = parseFloat(vb);
        const bothNum = !isNaN(na) && !isNaN(nb);

        if (bothNum) return currentSort.dir * (na - nb);
        return currentSort.dir * va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
      });

      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

/**
 * Render and open an attribute table for a Leaflet GeoJSON layer.
 * Clicking a row zooms to that feature and opens its popup.
 */
function openAttributeTable(layerName, layer){
  if (!attrPanel || !attrTitle || !attrTable) return;

  // Collect features
  const feats = [];
  layer.eachLayer(l => { if (l.feature) feats.push(l.feature); });

  if (!feats.length) {
    attrTitle.textContent = `Attribute table — ${layerName} (0 features)`;
    attrTable.innerHTML = "<tr><td>No features loaded.</td></tr>";
    enableTableSorting();
    attrPanel.style.display = "flex";
    return;
  }

  // Union of all keys (stable, GIS-like)
  const keySet = new Set();
  feats.forEach(f => Object.keys(f.properties || {}).forEach(k => keySet.add(k)));
  const keys = Array.from(keySet);

  // Header
  const thead = `<thead><tr>${keys.map(k => `<th>${escapeHtml(k)}</th>`).join("")}</tr></thead>`;

  // Body
  const rows = feats.map((f, idx) => {
    const p = f.properties || {};
    const fid = (p.id ?? p.ID ?? p.fid ?? idx);
    const tds = keys.map(k => `<td>${escapeHtml(String(p[k] ?? ""))}</td>`).join("");
    return `<tr data-row="${idx}" data-fid="${escapeHtml(String(fid))}">${tds}</tr>`;
  }).join("");

  attrTitle.textContent = `Attribute table — ${layerName} (${feats.length} features)`;
  attrTable.innerHTML = thead + `<tbody>${rows}</tbody>`;
  enableTableSorting();
  attrPanel.style.display = "flex";

  // Row click -> zoom to feature + open popup (GIS feel)
  attrTable.querySelectorAll("tbody tr").forEach(tr => {
    tr.addEventListener("click", () => {
      const i = Number(tr.dataset.row);
      const feature = feats[i];
      if (!feature) return;

      // find corresponding Leaflet layer
      let hitLayer = null;
      layer.eachLayer(l => {
        if (l.feature === feature) hitLayer = l;
      });
      if (!hitLayer) return;

      if (hitLayer.getLatLng) {
        map.setView(hitLayer.getLatLng(), Math.max(map.getZoom(), 16));
        if (hitLayer.openPopup) hitLayer.openPopup();
      } else if (hitLayer.getBounds) {
        map.fitBounds(hitLayer.getBounds(), { padding: [20,20], maxZoom: 18 });
        if (hitLayer.openPopup) hitLayer.openPopup();
      }
    });
  });
}

// maximize attribute table
const attrMax = document.getElementById("attrMax");
let attrWasMaximized = false;

attrMax?.addEventListener("click", () => {
  if (!attrPanel) return;

  attrWasMaximized = !attrWasMaximized;
  attrPanel.classList.toggle("maximized", attrWasMaximized);
  attrMax.textContent = attrWasMaximized ? "🗗" : "⬜";
});

/**
 * Highlight the corresponding attribute table row when a feature is clicked on the map.
 */
function highlightTableRowByFeature(feature){
  if (!feature || !attrTable) return;

  const rows = attrTable.querySelectorAll("tbody tr");
  rows.forEach(r => r.classList.remove("active"));

  const fid = feature.properties?.id;
  if (fid === undefined || fid === null) return;

  const row = Array.from(rows).find(r => r.dataset.fid == fid);
  if (!row) return;

  row.classList.add("active");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
}

const attrSearch = document.getElementById("attrSearch");

// search filtering for attribute table
attrSearch?.addEventListener("input", () => {
  const q = attrSearch.value.trim().toLowerCase();
  const rows = attrTable.querySelectorAll("tbody tr");

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(q) ? "" : "none";
  });
});

/**
 * Basic HTML escaping for attribute table text output (prevents injection in table cells).
 */
function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

/**
 * Restore WFS layers from sessionStorage after reload.
 * This supports demo stability (refresh doesn't wipe work).
 */
async function restoreSessionLayers() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem("layers.wfs") || "[]");
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved) || !saved.length) return;

  for (const rec of saved) {
    try {
      if (!rec.url) continue;
      const resp = await fetch(rec.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const layer = L.geoJSON(data, {
        onEachFeature: (f, l) => {
          const p = f.properties || {};
          const html = Object.keys(p)
            .slice(0, 10)
            .map(k => `<b>${k}:</b> ${p[k]}`)
            .join("<br>");

          l.bindPopup(html);

          l.on("click", () => {
            if (attrPanel && attrPanel.style.display !== "flex") {
              openAttributeTable("BW", window._lastDataLayer);
            }
            highlightTableRowByFeature(f);
          });
        },
        pointToLayer: (_f, latlng) => L.circleMarker(latlng, { radius: 5 })
      }).addTo(map);

      addLayerToList(rec.name || "WFS Layer", layer);

      // Keep references for chat actions
      window._lastDataLayer = layer;
      window._lastLayerName = rec.name || "WFS Layer";
    } catch (err) {
      console.error("Failed to restore WFS layer", rec, err);
    }
  }
}


/* ====== Parking layer (backend / active WFS datasource) ======
   In this prototype, "loadParking" fetches features from the ACTIVE_DS WFS URL
   using a bbox computed from the requested lat/lon and radius.
*/
let parkingAbort = null;   // AbortController for in-flight parking fetch
let parkingLayer = null;   // Leaflet GeoJSON layer for fetched parking points
let searchLayer = null;    // Leaflet GeoJSON layer for attribute search results

/**
 * Fetch and render parking features from the ACTIVE_DS WFS datasource.
 * - Uses bbox filtering to keep payload small.
 * - Adds result to cluster group for better performance.
 *
 * opts:
 *   - lat, lon: search center (required)
 *   - radius_km: radius in kilometers (default 2)
 */
async function loadParking(opts = {}) {
  const { lat, lon, radius_km = 2 } = opts;

  // The datasource must be set first (via WFS modal or session restore).
  if (!ACTIVE_DS || ACTIVE_DS.kind !== "wfs") {
    console.warn("No active datasource set. Use the WFS button or tell the chat: 'Use this WFS ...'");
    toast("No datasource set. Add a WFS first.", "warn");
    return;
  }
  if (typeof lat !== "number" || typeof lon !== "number") {
    console.warn("loadParking: missing lat/lon");
    return;
  }

  // Build request URL (bbox around requested location)
  let url = urlWithBbox(ACTIVE_DS.url, lat, lon, radius_km);
  url = applyAuthToUrl(url);

  // Abort any previous fetch (prevents race conditions during rapid chat use)
  if (parkingAbort) parkingAbort.abort();
  parkingAbort = new AbortController();

  showLoader(true);
  try {
    const init = applyAuthToFetchInit({ signal: parkingAbort.signal });
    const resp = await fetch(url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Clear old result layer from clusters (if any)
    if (parkingLayer) clusters.removeLayer(parkingLayer);

    parkingLayer = L.geoJSON(data, {
      onEachFeature: (f, l) => {
        const p = f.properties || {};
        const html = Object.keys(p).slice(0,10).map(k => `<b>${k}:</b> ${p[k]}`).join("<br>");
        l.bindPopup(html || "Parking");
      },
      pointToLayer: (_f, ll) => L.circleMarker(ll, { radius: 6, weight: 1, fillOpacity: 0.85 })
    });

    clusters.addLayer(parkingLayer);
    try { map.fitBounds(parkingLayer.getBounds(), { maxZoom: 16, padding: [20, 20] }); } catch {}
  } catch (err) {
    if (err.name !== "AbortError") console.error("Active WFS fetch failed:", err);
  } finally {
    showLoader(false);
  }
}

// --- Measure state ---
// Used by the manual measure tool (NOT the chat distance routing tool).
let measureActive = false;
let measureStart = null;     // L.LatLng or null
let measureLine = null;      // L.Polyline
let measureMarkers = [];     // start/end markers

/**
 * Format meters as a human-friendly string (m or km).
 */
function fmtMeters(m){
  if (m < 1000) return `${m.toFixed(0)} m`;
  const km = m / 1000;
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

// --- Chat-driven routing / distance ---
let chatRouteLine = null;

// Highlight layer for “within radius” type requests
let nearbyLayer = null;

/**
 * Highlight features within a radius around a given location.
 * This operates on the currently loaded data layer (window._lastDataLayer).
 */
function highlightNearbyFromLayer(srcLayer, lat, lon, radiusKm=2){
  if (!srcLayer) { console.warn("No data layer to filter."); return; }
  if (nearbyLayer) { map.removeLayer(nearbyLayer); nearbyLayer = null; }

  const center = L.latLng(lat, lon);
  const radiusM = (radiusKm || 2) * 1000;
  const hits = [];

  srcLayer.eachLayer(l => {
    // works for markers/circleMarkers; fallback for polygons/lines uses centroid
    const ll = l.getLatLng ? l.getLatLng()
            : (l.getBounds ? l.getBounds().getCenter() : null);
    if (!ll) return;
    if (center.distanceTo(ll) <= radiusM) {
      // keep original feature to re-render in a different style
      if (l.feature) hits.push(l.feature);
    }
  });

  if (!hits.length) { toast && toast("No points within radius.", "warn"); return; }

  nearbyLayer = L.geoJSON({ type:"FeatureCollection", features:hits }, {
    pointToLayer: (_f, ll) => L.circleMarker(ll, { radius: 7, color: "#c00", weight: 2, fillOpacity: 0.9 })
  }).addTo(map);
}

// show point 
function getFeatureFieldValue(feature, field) {
  const props = (feature && feature.properties) ? feature.properties : {};
  const v = props[field];
  return (v === null || v === undefined) ? "" : String(v);
}

// Expose for the Refresh button in the status bar
window.loadParking = loadParking;

/* ====== Chat wiring ======
   addLog() handles chat UI messages and attaches explainability panels for bot replies.
*/

/**
 * Append a message to the chat log.
 * who: "you" | "bot"
 * meta: explainability metadata returned by backend (optional, only for bot)
 */
function addLog(text, who = "bot", meta = null) {
  if (!chatLog) return;

  const wrap = document.createElement("div");
  wrap.className = `chat-msg ${who === "you" ? "chat-user" : "chat-bot"}`;

  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text;

  wrap.appendChild(body);

  // Add explainability only for bot messages
  if (who !== "you" && meta) {
    const details = document.createElement("details");
    details.className = "chat-explain";

    const summary = document.createElement("summary");
    summary.textContent = "Why this response?";

    // Toggle buttons
    const tabs = document.createElement("div");
    tabs.className = "explain-tabs";

    const btnText = document.createElement("button");
    btnText.type = "button";
    btnText.className = "explain-tab active";
    btnText.textContent = "Text";

    const btnJson = document.createElement("button");
    btnJson.type = "button";
    btnJson.className = "explain-tab";
    btnJson.textContent = "JSON";

    tabs.appendChild(btnText);
    tabs.appendChild(btnJson);

    // Views
    const textView = document.createElement("pre");
    textView.className = "explain-view explain-text";
    textView.textContent = explainMetaAsText(meta);

    const jsonView = document.createElement("pre");
    jsonView.className = "explain-view explain-json";
    jsonView.textContent = JSON.stringify(meta, null, 2);
    jsonView.style.display = "none";

    // Tab behavior
    btnText.addEventListener("click", (e) => {
      e.preventDefault();
      btnText.classList.add("active");
      btnJson.classList.remove("active");
      textView.style.display = "block";
      jsonView.style.display = "none";
    });

    btnJson.addEventListener("click", (e) => {
      e.preventDefault();
      btnJson.classList.add("active");
      btnText.classList.remove("active");
      textView.style.display = "none";
      jsonView.style.display = "block";
    });

    details.appendChild(summary);
    details.appendChild(tabs);
    details.appendChild(textView);
    details.appendChild(jsonView);
    wrap.appendChild(details);

    // "Model thoughts" (SAFE summary, not chain-of-thought)
    // This is intentionally a high-level explanation for your evaluation chapter.
    const thoughts = document.createElement("details");
    thoughts.className = "chat-thoughts";

    const thoughtsSummary = document.createElement("summary");
    thoughtsSummary.textContent = "Model thoughts (summary)";

    const box = document.createElement("div");
    box.className = "thoughts-box";

    const steps = explainMetaAsThoughts(meta);
    steps.forEach((s) => {
      const item = document.createElement("div");
      item.className = "thought-item";

      const t = document.createElement("div");
      t.className = "thought-title";
      t.textContent = s.title;

      const d = document.createElement("div");
      d.className = "thought-detail";
      d.textContent = s.detail;

      item.appendChild(t);
      item.appendChild(d);
      box.appendChild(item);
    });

    thoughts.appendChild(thoughtsSummary);
    thoughts.appendChild(box);
    wrap.appendChild(thoughts);
  }

  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;

  // Persist chat history per session (so refresh keeps conversation)
  chatHistory.push({ text, who, meta: meta || null });

  try {
    sessionStorage.setItem("chat.history", JSON.stringify(chatHistory));
  } catch (e) {
    console.warn("Failed to persist chat history", e);
  }
}

let chatHistory = [];

// -----------------------------------------------------------------------------
// ACTION EXECUTION (Deterministic WebGIS functions)
// -----------------------------------------------------------------------------
// The backend returns: { reply: "...", actions: [ ... ] }
// This function is the "executor" side of the architecture.
// IMPORTANT: The LLM only proposes actions; this code executes them safely.
//
// Supported actions (must match backend schema):
// - setView
// - loadParking
// - findByAttribute
// - openAttributeTable
// - filterWithin
// - loadWFS
// - describeLayer
// - countLayer
// - measureDistance
// -----------------------------------------------------------------------------

// --- Execute actions from /chat (setView | loadParking | loadWFS | measureDistance)
async function applyActions(actions = []) {
  for (const a of actions || []) {
    try {
      switch (a.type) {
        case "setView": {
          const { lat, lon, zoom, place } = a;

          if (typeof lat === "number" && typeof lon === "number") {
            // Direct coordinates (no geocoding needed).
            map.setView(
              [lat, lon],
              typeof zoom === "number" ? zoom : map.getZoom()
            );
          } else if (place && place.trim()) {
            // Place name -> resolve via frontend geocoder / resolver.
            const loc = await resolveLocation({ place });
            map.setView(
              [loc.lat, loc.lon],
              typeof zoom === "number" ? zoom : 12
            );
          }
          break;
        }

        case "loadParking": {
          let { city, lat, lon, radiusKm, place, nearMe } = a;

          // If the model passed only “city”, reuse it as a geocoding hint.
          if (!place && city) place = city;

          // Resolve target location using: explicit coords > device > geocode > map center
          const loc = await resolveLocation({
            lat,
            lon,
            place,
            preferUser: !!nearMe, // when user says “near me”
          });

          // Default radius: 5 km (unless specified)
          let rKm = (typeof radiusKm === "number") ? radiusKm : 5;

          // Defensive: sometimes model outputs meters as "radiusKm"
          // Example: 200 (meters) mistakenly sent as 200 (km) -> treat as meters when huge.
          if (rKm >= 50) rKm = rKm / 1000;

          // Fetch parking features from ACTIVE_DS WFS (bbox around loc)
          await loadParking({
            city,
            lat: loc.lat,
            lon: loc.lon,
            radius_km: rKm,
          });

          // Highlight subset from user's loaded WFS layer, if present
          if (window._lastDataLayer) {
            highlightNearbyFromLayer(
              window._lastDataLayer,
              loc.lat,
              loc.lon,
              rKm
            );
          } else {
            console.warn("No WFS layer loaded via button; nothing to filter.");
          }

          // Center map on the resolved location
          map.setView([loc.lat, loc.lon], 13);
          break;
        }

        case "findByAttribute": {
          // Searches within the currently loaded data layer (window._lastDataLayer)
          const layer = window._lastDataLayer;
          if (!layer) {
            addLog("No layer loaded yet. Add a WFS layer first.", "bot");
            break;
          }

          const field = (a.field || "*").trim();
          const values = Array.isArray(a.values)
            ? a.values.map(v => String(v).toLowerCase())
            : [];

          if (!values.length) {
            addLog("No values provided to search for.", "bot");
            break;
          }

          // Clear previous search highlight
          if (searchLayer) {
            map.removeLayer(searchLayer);
            searchLayer = null;
          }

          const hits = [];

          // Iterate all features in the layer and match against given values
          layer.eachLayer(l => {
            const f = l.feature;
            if (!f || !f.properties) return;

            const props = f.properties;

            for (const val of values) {
              if (field === "*") {
                // wildcard: check all properties
                for (const k of Object.keys(props)) {
                  const v = String(props[k] ?? "").toLowerCase();
                  if (v === val) {
                    hits.push(f);
                    return;
                  }
                }
              } else {
                // field-specific match
                const v = String(props[field] ?? "").toLowerCase();
                if (v === val) {
                  hits.push(f);
                  return;
                }
              }
            }
          });

          if (!hits.length) {
            addLog("No matching features found.", "bot");
            break;
          }

          // Create a highlight layer for found features (red)
          searchLayer = L.geoJSON(
            { type: "FeatureCollection", features: hits },
            {
              onEachFeature: (f, l) => {
                const p = f.properties || {};
                const html = Object.keys(p)
                  .slice(0, 20)
                  .map(k => `<b>${k}:</b> ${p[k]}`)
                  .join("<br>");
                l.bindPopup(html || "Feature");
              },
              pointToLayer: (_f, ll) =>
                L.circleMarker(ll, {
                  radius: 9,
                  color: "#c00",
                  weight: 3,
                  fillColor: "#c00",
                  fillOpacity: 0.95
                })
            }
          ).addTo(map);

          // Zoom to results
          map.fitBounds(searchLayer.getBounds(), {
            padding: [20, 20],
            maxZoom: 18
          });

          addLog(`Found ${hits.length} matching feature(s).`, "bot");
          break;
        }

        case "openAttributeTable": {
          // Opens the attribute panel for the active layer
          const layer = window._lastDataLayer;
          if (!layer) {
            addLog("No layer loaded yet. Add a WFS layer first.", "bot");
            break;
          }
          openAttributeTable(window._lastLayerName || "Layer", layer);
          break;
        }

        case "filterWithin": {
          // Highlight features within radiusM meters around a location
          const { place, lat, lon, radiusM } = a;

          const loc = await resolveLocation({ lat, lon, place });
          const rM = (typeof radiusM === "number" && radiusM > 0) ? radiusM : 500;

          const layer = window._lastDataLayer;
          if (!layer) {
            addLog("No layer loaded yet. Add a WFS layer first.", "bot");
            break;
          }

          // Remove old highlight
          if (nearbyLayer) { map.removeLayer(nearbyLayer); nearbyLayer = null; }

          const center = L.latLng(loc.lat, loc.lon);
          const hits = [];

          layer.eachLayer(l => {
            const ll = l.getLatLng ? l.getLatLng()
                    : (l.getBounds ? l.getBounds().getCenter() : null);
            if (!ll) return;
            if (center.distanceTo(ll) <= rM) {
              if (l.feature) hits.push(l.feature);
            }
          });

          if (!hits.length) {
            addLog(`No points found within ${rM} m of ${place || "that location"}.`, "bot");
            break;
          }

          // Create a highlight layer for results
          nearbyLayer = L.geoJSON({ type:"FeatureCollection", features:hits }, {
            onEachFeature: (f, l) => {
              const p = f.properties || {};
              const html = Object.keys(p)
                .slice(0, 20)
                .map(k => `<b>${k}:</b> ${p[k]}`)
                .join("<br>");
              l.bindPopup(html || "Feature");
            },
            pointToLayer: (_f, ll) => L.circleMarker(ll, {
              radius: 7, color: "#c00", weight: 2, fillColor: "#c00", fillOpacity: 0.9
            })
          }).addTo(map);

          addLog(`Found ${hits.length} points within ${rM} m of ${place || "the location"}.`, "bot");
          map.fitBounds(nearbyLayer.getBounds(), { padding: [20, 20], maxZoom: 17 });
          break;
        }

        case "loadWFS": {
          // Load arbitrary WFS GeoJSON URL as a new layer
          const { url } = a;
          if (!/^https?:\/\//i.test(url || "")) break;

          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const data = await resp.json();
          const layer = L.geoJSON(data, {
            pointToLayer: (_f, ll) => L.circleMarker(ll, { radius: 5 }),
          }).addTo(map);

          addLayerToList("WFS", layer);

          // Update active layer references used by chat actions
          window._lastDataLayer = layer;

          // NOTE: `name` is not defined in this scope in your current code.
          // Keeping as-is to avoid behavior changes (as requested).
          window._lastLayerName = name;

          try {
            map.fitBounds(layer.getBounds(), { padding: [20, 20] });
          } catch {}
          break;
        }

        case "describeLayer": {
          // Summarize current layer: feature count, bbox, data completeness, categories
          const info = describeCurrentLayer();

          if (!info.ok) {
            addLog(info.msg, "bot");
            toast && toast(info.msg, "warn");
            break;
          }

          // Sort fields for "best" (lowest empty) and "worst" (highest empty)
          const byBest = [...info.fields].sort((a, b) => a.nullPct - b.nullPct);
          const byWorst = [...info.fields].sort((a, b) => b.nullPct - a.nullPct);

          const best = byBest.slice(0, 6);
          const worst = byWorst.slice(0, 6);

          // Pick categorical fields: low unique count + not mostly empty
          const categorical = [...info.fields]
            .filter(f => f.uniqueCount > 0 && f.uniqueCount <= 12 && f.nullPct <= 80)
            .sort((a, b) => a.uniqueCount - b.uniqueCount)
            .slice(0, 6);

          const lines = [];
          lines.push(`🧾 Dataset summary`);
          lines.push(`• Features: ${info.featureCount}`);
          lines.push(`• Geometry: ${info.geomType}`);

          if (info.bbox) {
            const bb = info.bbox.map(n => Number(n).toFixed(4)).join(", ");
            lines.push(`• BBox: ${bb}`);
          }

          lines.push(``);
          lines.push(`✅ Best-populated fields (lowest missing):`);
          best.forEach(f => {
            lines.push(`• ${f.key} — ${f.nullPct.toFixed(0)}% missing`);
          });

          lines.push(``);
          lines.push(`⚠️ Mostly-empty fields (data gaps):`);
          worst.forEach(f => {
            // only show the truly bad ones
            if (f.nullPct >= 80) lines.push(`• ${f.key} — ${f.nullPct.toFixed(0)}% missing`);
          });

          // Categorical summary (compact)
          if (categorical.length) {
            lines.push(``);
            lines.push(`🏷️ Common categories:`);
            categorical.forEach(f => {
              const tops = (f.topValues || [])
                .slice(0, 3)
                .map(tv => `${tv.val} (${tv.cnt})`)
                .join(", ");
              if (tops) lines.push(`• ${f.key}: ${tops}`);
            });
          }

          addLog(lines.join("\n"), "bot");
          break;
        }

        case "countLayer": {
          // Count total features or realtime subset (has_realtime_data === true)
          const metric = a.metric || "total";
          const res = countCurrentLayer(metric);

          if (!res.ok) {
            addLog(res.msg, "bot");
            toast && toast(res.msg, "warn");
            break;
          }

          if (metric === "realtime") {
            addLog(`📡 With realtime data: ${res.realtime} / ${res.total}`, "bot");
          } else {
            addLog(`🔢 Total features loaded: ${res.total}`, "bot");
          }

          break;
        }

        case "measureDistance": {
          // Route or straight-line distance between two locations.
          // Default mode: "car" -> OSRM driving route
          // Optional mode: "air" -> straight-line (Leaflet distance)
          let {
            fromPlace,
            toPlace,
            fromLat,
            fromLon,
            toLat,
            toLon,
            mode = "car", // 🚗 default
          } = a;

          const fromLoc = await resolveLocation({
            lat: fromLat,
            lon: fromLon,
            place: fromPlace,
          });
          const toLoc = await resolveLocation({
            lat: toLat,
            lon: toLon,
            place: toPlace,
          });

          const p1 = L.latLng(fromLoc.lat, fromLoc.lon);
          const p2 = L.latLng(toLoc.lat, toLoc.lon);

          // Clear previous distance line
          if (chatRouteLine) {
            map.removeLayer(chatRouteLine);
            chatRouteLine = null;
          }

          // ✈️ AIR / FLIGHT distance (straight line)
          if (mode === "air") {
            const distM = map.distance(p1, p2);
            const label = fmtMeters(distM);

            chatRouteLine = L.polyline([p1, p2], {
              weight: 3,
              dashArray: "6,6",
            }).addTo(map);

            const mid = L.latLng(
              (p1.lat + p2.lat) / 2,
              (p1.lng + p2.lng) / 2
            );

            L.popup()
              .setLatLng(mid)
              .setContent(`<b>Air distance: ${label}</b>`)
              .openOn(map);

            addLog(`✈️ Air distance: ${label}`, "bot");
            map.fitBounds(chatRouteLine.getBounds(), { padding: [20, 20] });
            break;
          }

          // 🚗 DRIVING distance (DEFAULT) using OSRM public demo server
          const url =
            `https://router.project-osrm.org/route/v1/driving/` +
            `${fromLoc.lon},${fromLoc.lat};${toLoc.lon},${toLoc.lat}` +
            `?overview=full&geometries=geojson`;

          const r = await fetch(url);
          const data = await r.json();
          if (!data.routes?.length) throw new Error("No route found");

          const route = data.routes[0];
          const coords = route.geometry.coordinates.map(
            ([lon, lat]) => [lat, lon]
          );

          chatRouteLine = L.polyline(coords, {
            weight: 4,
          }).addTo(map);

          const km = route.distance / 1000;
          const min = route.duration / 60;

          addLog(
            `🚗 Driving distance: ${km.toFixed(1)} km (~${min.toFixed(0)} min)`,
            "bot"
          );

          map.fitBounds(chatRouteLine.getBounds(), { padding: [20, 20] });
          break;
        }
      }
    } catch (e) {
      // Fail-soft: one action failing should not crash the entire sequence
      console.error("Action failed:", a, e);
    }
  }
}

// -----------------------------------------------------------------------------
// EXPLAINABILITY HELPERS
// -----------------------------------------------------------------------------
// These functions render the backend meta object into:
// - "AI Studio style" thought steps (SAFE summary; not chain-of-thought)
// - human-readable explainability text
// -----------------------------------------------------------------------------

// meta → "AI Studio style" thoughts (SAFE summary, not chain-of-thought)
function explainMetaAsThoughts(meta) {
  if (!meta || typeof meta !== "object") {
    return [{ title: "No explanation", detail: "No metadata available." }];
  }

  const src = meta.decision_source || "unknown";
  const actions = Array.isArray(meta.action_types) ? meta.action_types : [];
  const latency = typeof meta.latency_ms === "number"
    ? `${(meta.latency_ms / 1000).toFixed(1)}s`
    : "n/a";

  const steps = [];

  // 1️⃣ Intent interpretation
  steps.push({
    title: "Understanding the request",
    detail:
      src === "ollama"
        ? "The system interpreted the request using the local language model."
        : "The system interpreted the request using predefined rules."
  });

  // 2️⃣ Action-specific reasoning (high-level)
  if (!actions.length) {
    steps.push({
      title: "Action selection",
      detail:
        "No supported spatial action was detected for this request."
    });
  } else {
    actions.forEach((a) => {
      let reason = "The system selected this action based on the interpreted intent.";

      if (a === "describeLayer") {
        reason =
          "The user requested information about the dataset, so the system selected a dataset introspection operation.";
      } else if (a === "setView") {
        reason =
          "The user requested a map navigation operation, so the system adjusted the map view.";
      } else if (a === "measureDistance") {
        reason =
          "The user requested a distance query, so the system planned a routing or distance measurement.";
      } else if (a === "countLayer") {
        reason =
          "The user requested a quantitative summary, so the system planned a feature-counting operation.";
      }

      steps.push({
        title: "Action selection",
        detail: reason
      });
    });
  }

  // 3️⃣ Validation (schema gate)
  const validTxt =
    meta.schema_valid === false ? "Failed" :
    meta.schema_valid === true  ? "Passed" : "Not reported";

  const actionTxt = actions.length ? actions.join(", ") : "none";
  steps.push({
    title: "Schema validation",
    detail: `Validation: ${validTxt}. Actions: ${actionTxt}.`
  });

  // 4️⃣ Fallback explanation (only if used)
  if (src === "rule_fallback" && meta.llm_error) {
    steps.push({
      title: "Fallback reason",
      detail:
        "The language model did not respond in time, so the system used deterministic rules instead."
    });
  }

  // 5️⃣ Deterministic execution note (what actually ran)
  const actionTypes = Array.isArray(meta?.action_types) ? meta.action_types : [];
  const services = Array.isArray(meta?.services_used) ? meta.services_used : [];

  let detTitle = "Deterministic execution";
  let detDetail = "";

  if (!actionTypes.length || actionTypes.includes("none")) {
    detDetail = "No spatial action executed; only a text response was generated.";
  } else {
    detDetail = "Actions were executed by predefined WebGIS functions (Leaflet/JS), not by the LLM.";

    const addons = [];

    if (actionTypes.includes("measureDistance") || services.includes("OSRM")) {
      addons.push("Route computed via OSRM (road network), then rendered in the client.");
    }
    if (actionTypes.includes("setView")) {
      addons.push("Place/coordinates resolved and applied via deterministic pan/zoom logic.");
    }
    if (actionTypes.includes("loadWFS")) {
      addons.push("Features fetched from a WFS endpoint and added as a layer.");
    }
    if (actionTypes.includes("loadParking")) {
      addons.push("Parking features fetched and filtered using the current spatial extent (bbox/radius).");
    }
    if (actionTypes.includes("describeDataset") || actionTypes.includes("countFeatures")) {
      addons.push("Result derived from loaded layer metadata/features.");
    }

    if (addons.length) detDetail += " " + addons.join(" ");
  }

  steps.push({ title: detTitle, detail: detDetail });

  // 6️⃣ Timing (performance metric for evaluation)
  steps.push({
    title: "Timing",
    detail: `Total response time: ${latency}.`
  });

  return steps;
}

// meta → human explanation
function explainMetaAsText(meta) {
  if (!meta || typeof meta !== "object") return "No explainability data available.";

  const src = meta.decision_source || "unknown";
  const actions = Array.isArray(meta.action_types) ? meta.action_types.filter(Boolean) : [];
  const latency = (typeof meta.latency_ms === "number") ? `${(meta.latency_ms/1000).toFixed(1)}s` : "n/a";
  const schemaOk = (meta.schema_valid === true) ? "passed" : (meta.schema_valid === false ? "failed" : "n/a");
  const reqId = meta.request_id || "n/a";

  const srcLabel =
    src === "ollama" ? "Local LLM (Ollama)" :
    src === "rule_fallback" ? "Rule-based fallback" :
    src;

  const lines = [];
  lines.push(`Decision source: ${srcLabel}`);
  lines.push(`Schema validation: ${schemaOk}`);
  lines.push(`Planned actions: ${actions.length ? actions.join(", ") : "none"}`);
  lines.push(`Response time: ${latency}`);
  lines.push(`Request ID: ${reqId}`);

  if (meta.llm_error) {
    lines.push(`LLM status: failed (${meta.llm_error})`);
    lines.push(`Why fallback? The LLM did not return a valid answer in time, so the system used deterministic rules.`);
  } else if (src === "ollama") {
    lines.push(`LLM status: OK (response generated by the local model)`);
  }

  // Optional context (if center provided)
  if (typeof meta.lat === "number" && typeof meta.lon === "number") {
    lines.push(`Context: map center was (${meta.lat.toFixed(4)}, ${meta.lon.toFixed(4)})`);
  }

  return lines.join("\n");
}


// -----------------------------------------------------------------------------
// CHAT REQUEST FLOW
// -----------------------------------------------------------------------------
// - Sends user message + map center context to backend /chat
// - Receives reply + actions + meta
// - Renders reply and explainability
// - Executes actions deterministically via applyActions(...)
// -----------------------------------------------------------------------------

// --- Chat: now consumes { reply, actions[] } (NO L.geoJSON here)
async function runChat(message) {
  addLog(message, "you");

  // “typing…” indicator for UX
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.textContent = "Assistant is typing…";
  chatLog.appendChild(typing);
  chatLog.scrollTop = chatLog.scrollHeight;

  try {
    // Provide map context (center) so “near me / around here” can be interpreted
    const ctr = map.getCenter();
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, center: { lat: ctr.lat, lon: ctr.lng } }),
    });

    const payload = await res.json();
    console.log("CHAT PAYLOAD:", payload);   // debugging aid during dev/demos
    typing.remove();

    // If backend reply is empty, generate a safe fallback reply based on actions
    const reply =
      (payload.reply && payload.reply.trim()) ||
      fallbackReplyFromActions(payload.actions || []);

    // Prepare meta for explainability panel
    const meta = payload.meta ? { ...payload.meta } : {};
    meta.action_types = Array.isArray(meta.action_types) ? meta.action_types : (payload.actions || []).map(a => a.type);

    // If distance is involved, OSRM is used by the frontend
    if (meta.action_types.includes("measureDistance")) {
      meta.services_used = Array.isArray(meta.services_used) ? meta.services_used : [];
      if (!meta.services_used.includes("OSRM")) meta.services_used.push("OSRM");
      meta.distance_mode = meta.distance_mode || "driving (routing)"; // optional
    }

    addLog(reply, "bot", meta);
    await applyActions(payload.actions || []);

  } catch (err) {
    typing.remove();
    console.error("runChat error:", err);
    addLog("Error contacting the model. Check the server logs.", "bot");
  }
}


// -----------------------------------------------------------------------------
// SESSION RESTORE
// -----------------------------------------------------------------------------
// Restores chat + layers on refresh to make demos more stable.
// -----------------------------------------------------------------------------

// restore chat history from this session
function loadChatHistoryFromSession() {
  try {
    const raw = sessionStorage.getItem("chat.history");
    if (!raw) return;

    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return;

    // clear UI + memory to avoid duplicates
    chatHistory = [];
    if (chatLog) chatLog.innerHTML = "";

    saved.forEach((m) => {
      // backward compatible: old items were {text, who}
      const text = m?.text ?? "";
      const who  = m?.who ?? "bot";
      const meta = m?.meta ?? null;

      if (text) addLog(text, who, meta);
    });
  } catch (e) {
    console.warn("Failed to load chat history", e);
  }
}

// -----------------------------------------------------------------------------
// LOCATION RESOLUTION / GEOCODING
// -----------------------------------------------------------------------------
// A single resolver used consistently by:
// - setView(place)
// - loadParking(place / nearMe)
// - filterWithin(place)
// - measureDistance(from/to)
// -----------------------------------------------------------------------------

// Normalize place strings for stable geocoding + caching
function normalizePlaceText(s) {
  return (s || "")
    .toString()
    .trim()
    .replace(/\s+/g, " "); // collapse multiple spaces
}

// Simple in-memory geocode cache (session-level)
const geocodeCache = new Map();

async function geocodeFreeText(query, biasBounds) {
  const q = normalizePlaceText(query);
  if (geocodeCache.has(q)) return geocodeCache.get(q);

  // bias using current map bounds; restrict to Germany for precision
  const b = biasBounds || map.getBounds();
  const viewbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;

  const url = `/geocode?q=${encodeURIComponent(q)}&viewbox=${encodeURIComponent(viewbox)}&countrycodes=de`;
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));

  if (data.ok) {
    geocodeCache.set(q, { lat: data.lat, lon: data.lon, name: data.name });
    return { lat: data.lat, lon: data.lon, name: data.name };
  }
  return null;
}

// Device location helper (one-shot, fail-soft)
function getBrowserLocationOnce() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      _err => resolve(null),
      { enableHighAccuracy: true, timeout: 6000 }
    );
  });
}

// The ONE resolver to rule them all
async function resolveLocation({ lat, lon, place, preferUser=false }) {
  // 1) Explicit coords from action
  if (typeof lat === "number" && typeof lon === "number") return { lat, lon, source: "action" };

  // 2) “near me”
  if (preferUser) {
    const me = await getBrowserLocationOnce();
    if (me) return { ...me, source: "device" };
  }

  // 3) Map center as a decent fallback context
  const ctr = map.getCenter();
  const centerGuess = { lat: ctr.lat, lon: ctr.lng, source: "center" };

  // 4) Free-text geocode (Hbf, street, POI, etc.)
  if (place && place.trim()) {
    const hit = await geocodeFreeText(place);
    if (hit) return { lat: hit.lat, lon: hit.lon, source: "geocode", name: hit.name };
  }

  return centerGuess;
}


// -----------------------------------------------------------------------------
// LAYER INTROSPECTION (describeLayer / countLayer)
// -----------------------------------------------------------------------------

function describeCurrentLayer() {
  const layer = window._lastDataLayer;
  if (!layer) {
    return { ok: false, msg: "No layer loaded yet. Add a WFS layer first." };
  }

  let featureCount = 0;
  const fieldStats = new Map(); // key -> { total, nulls, nonNulls, samples: Map(value->count) }
  let geomType = null;

  layer.eachLayer((l) => {
    const f = l.feature;
    if (!f) return;

    featureCount++;

    // geometry type (best effort)
    if (!geomType && f.geometry && f.geometry.type) {
      geomType = f.geometry.type;
    }

    const props = f.properties || {};
    for (const [k, v] of Object.entries(props)) {
      if (!fieldStats.has(k)) {
        fieldStats.set(k, { total: 0, nulls: 0, nonNulls: 0, samples: new Map() });
      }

      const st = fieldStats.get(k);
      st.total++;

      const isNull = v === null || v === undefined || String(v).trim() === "";
      if (isNull) {
        st.nulls++;
      } else {
        st.nonNulls++;
        const vv = String(v);
        st.samples.set(vv, (st.samples.get(vv) || 0) + 1);
      }
    }
  });

  // bounds (if possible)
  let bbox = null;
  try {
    const b = layer.getBounds();
    bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  } catch {
    // ignore
  }

  // Convert stats into a sorted summary
  const fields = Array.from(fieldStats.entries()).map(([key, st]) => {
    const nullPct = st.total ? (st.nulls / st.total) * 100 : 0;
    const uniqueCount = st.samples.size;

    // only show top values for low-cardinality fields (avoid spam)
    const topValues =
      uniqueCount <= 12
        ? Array.from(st.samples.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([val, cnt]) => ({ val, cnt }))
        : [];

    return {
      key,
      total: st.total,
      nulls: st.nulls,
      nonNulls: st.nonNulls,
      nullPct,
      uniqueCount,
      topValues,
    };
  });

  fields.sort((a, b) => a.key.localeCompare(b.key));

  // pick a few “best” fields to show (lowest nullPct)
  const bestFields = [...fields]
    .filter((f) => f.total > 0)
    .sort((a, b) => a.nullPct - b.nullPct)
    .slice(0, 6);

  return {
    ok: true,
    featureCount,
    geomType: geomType || "Unknown",
    bbox,
    fields,
    bestFields,
  };
}

/**
 * Count features in the currently loaded layer.
 * metric:
 *   - "total"    -> total feature count
 *   - "realtime" -> count where properties.has_realtime_data === true
 */
function countCurrentLayer(metric = "total") {
  const layer = window._lastDataLayer;
  if (!layer) {
    return { ok: false, msg: "No layer loaded yet. Add a WFS layer first." };
  }

  let total = 0;
  let realtime = 0;

  layer.eachLayer((l) => {
    const f = l.feature;
    if (!f) return;

    total++;

    const props = f.properties || {};
    if (props.has_realtime_data === true) {
      realtime++;
    }
  });

  return { ok: true, total, realtime };
}


// -----------------------------------------------------------------------------
// BOOTSTRAP (restore session + attach chat listeners)
// -----------------------------------------------------------------------------

// Restore per-session state on reload
restoreSessionLayers();
loadChatHistoryFromSession();

// --- Chat send wiring (required) ---
if (chatSend && chatInput) {
  chatSend.addEventListener("click", () => {
    const t = chatInput.value.trim();
    if (!t) return;
    runChat(t);
    chatInput.value = "";
    chatInput.focus();
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      chatSend.click();
    }
  });
} else {
  console.warn("Chat UI elements not found:", { chatSend, chatInput, chatLog });
}

