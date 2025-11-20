/* ============================================================================
 * Parking ChatMap — parking.js
 * Master’s thesis prototype
 *
 * Responsibilities:
 *  - Initialize Leaflet map and basemaps
 *  - Manage layer list (uploaded GeoJSON + WFS layers)
 *  - Provide a 2-point measurement tool
 *  - Manage WFS connections and active datasource
 *  - Wire the chat UI to the Flask /chat endpoint and apply returned actions
 *  - Perform lightweight geocoding + “near me” resolution for parking searches
 * ========================================================================== */

console.log("parking.js loaded");

/* ============================================================================
 * Config toggles
 * ========================================================================== */

/**
 * If your backend /api/parking endpoint is not ready,
 * keep this false. (Currently we use only WFS as datasource.)
 */
const USE_BACKEND_PARKING = false;

/* ============================================================================
 * DOM references
 * ========================================================================== */

const lastUpdatedEl = document.getElementById("last-updated");
const mapEl = document.getElementById("map");

// Sidebar & layer list
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

// Theme / loader / toast helpers
const themeToggle = document.getElementById("theme-toggle");
const loader = document.getElementById("loader");
const toastArea = document.getElementById("toasts");

/* ============================================================================
 * UI helpers: loader + toast + theme
 * ========================================================================== */

/**
 * Show/hide the global loader overlay.
 */
function showLoader(on = true) {
  if (loader) loader.style.display = on ? "flex" : "none";
}

/**
 * Small toast notification helper.
 * Type can be "ok", "warn", "err" (CSS classes can style them differently).
 */
function toast(msg, type = "ok", ms = 2600) {
  if (!toastArea) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastArea.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Initialize theme from localStorage
(function initTheme() {
  const t = localStorage.getItem("theme") || "dark";
  document.documentElement.setAttribute("data-theme", t);
})();

// Toggle dark / light theme and persist
themeToggle?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
});

/* ============================================================================
 * Map & basemaps
 * ========================================================================== */

const map = L.map("map", { zoomControl: true }).setView([48.7758, 9.1829], 13);

// Base layers
let osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors",
});

let carto = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  { maxZoom: 20, attribution: "&copy; OpenStreetMap, &copy; CARTO" }
);

// Satellite: Esri World Imagery (no key required)
let sat = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
  }
);

// Start with OSM by default
let currentBase = osm.addTo(map);

/* --------------------------------------------------------------------------
 * Basemap picker UI
 * ------------------------------------------------------------------------ */

bmTrigger?.addEventListener("click", (e) => {
  e.stopPropagation();
  bmMenu.style.display =
    bmMenu.style.display === "none" || !bmMenu.style.display ? "grid" : "none";
});

// Close menu when clicking outside
document.addEventListener("click", (e) => {
  if (!bmMenu.contains(e.target) && e.target !== bmTrigger) {
    bmMenu.style.display = "none";
  }
});

// Switch basemap
bmMenu?.querySelectorAll(".bm-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    // UI state
    bmMenu.querySelectorAll(".bm-opt").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    // Swap base layer
    if (currentBase) map.removeLayer(currentBase);
    const key = btn.dataset.base;
    const next = { osm, carto, sat }[key] || osm;
    currentBase = next.addTo(map);

    bmMenu.style.display = "none";
  });
});

/* ============================================================================
 * Two-point distance measurement tool
 * ========================================================================== */

const measureBtn = document.getElementById("measureBtn");

// Measure state
let measureActive = false;
let measureStart = null; // L.LatLng or null
let measureLine = null; // L.Polyline
let measureMarkers = []; // start / end markers

/**
 * Pretty-print distance in meters or kilometres.
 */
function fmtMeters(m) {
  if (m < 1000) return `${m.toFixed(0)} m`;
  const km = m / 1000;
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

if (measureBtn) {
  measureBtn.addEventListener("click", () => {
    measureActive = !measureActive;
    measureBtn.classList.toggle("active", measureActive);

    if (!measureActive) {
      // Reset state when turning off
      if (measureLine) {
        map.removeLayer(measureLine);
        measureLine = null;
      }
      measureMarkers.forEach((m) => map.removeLayer(m));
      measureMarkers = [];
      measureStart = null;
      toast && toast("Measure off", "ok");
    } else {
      toast && toast("Click two points on the map to measure", "ok");
    }
  });
}

// Handle map clicks: collect 2 points and show distance
map.on("click", (e) => {
  if (!measureActive) return;

  if (!measureStart) {
    // First point
    measureStart = e.latlng;
    const m1 = L.circleMarker(measureStart, { radius: 6, weight: 2 }).addTo(map);
    measureMarkers.push(m1);
  } else {
    // Second point -> compute & draw
    const p2 = e.latlng;
    const dist = map.distance(measureStart, p2); // meters

    if (measureLine) map.removeLayer(measureLine);
    measureLine = L.polyline([measureStart, p2], { weight: 3, dashArray: "6,6" }).addTo(map);

    const m2 = L.circleMarker(p2, { radius: 6, weight: 2 }).addTo(map);
    measureMarkers.push(m2);

    const mid = L.latLng(
      (measureStart.lat + p2.lat) / 2,
      (measureStart.lng + p2.lng) / 2
    );
    L.popup({ autoClose: true, closeOnClick: false })
      .setLatLng(mid)
      .setContent(`<b>${fmtMeters(dist)}</b>`)
      .openOn(map);

    // Ready for a new measurement
    measureStart = null;
  }
});

// ESC key to clear current measurement
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    measureStart = null;
    if (measureLine) {
      map.removeLayer(measureLine);
      measureLine = null;
    }
    measureMarkers.forEach((m) => map.removeLayer(m));
    measureMarkers = [];
    toast && toast("Measurement cleared", "warn");
  }
});

/**
 * Snap a clicked location to the nearest feature in a given layer
 * within a pixel tolerance. Helpful for measuring from existing points.
 */
function snapToLayer(latlng, srcLayer, px = 20) {
  if (!srcLayer) return latlng;
  let best = { ll: latlng, d: Infinity };
  const p0 = map.latLngToContainerPoint(latlng);
  srcLayer.eachLayer((l) => {
    const ll = l.getLatLng
      ? l.getLatLng()
      : l.getBounds
      ? l.getBounds().getCenter()
      : null;
    if (!ll) return;
    const p = map.latLngToContainerPoint(ll);
    const d = p.distanceTo(p0);
    if (d < best.d) best = { ll, d };
  });
  return best.d <= px ? best.ll : latlng;
}

/* ============================================================================
 * Active datasource & simple auth helpers (for WFS)
 * ========================================================================== */

/**
 * ACTIVE_DS has the shape:
 *   {
 *     kind: "wfs",
 *     url: "<base WFS URL>",
 *     auth?: {
 *       mode: "query" | "header",
 *       name: "key",
 *       value: "TOKEN"
 *     }
 *   }
 */
let ACTIVE_DS = JSON.parse(localStorage.getItem("active.datasource") || "null");

function setActiveDataSource(ds) {
  ACTIVE_DS = ds;
  localStorage.setItem("active.datasource", JSON.stringify(ds));
  toast("Datasource set.", "ok");
}

// Helpers to attach auth to URLs and fetch init options
function applyAuthToUrl(url) {
  if (!ACTIVE_DS || !ACTIVE_DS.auth || ACTIVE_DS.auth.mode !== "query") return url;
  const u = new URL(url, location.origin);
  u.searchParams.set(ACTIVE_DS.auth.name, ACTIVE_DS.auth.value);
  return u.toString();
}

function applyAuthToFetchInit(init = {}) {
  if (!ACTIVE_DS || !ACTIVE_DS.auth || ACTIVE_DS.auth.mode !== "header") return init;
  return {
    ...init,
    headers: { ...(init.headers || {}), [ACTIVE_DS.auth.name]: ACTIVE_DS.auth.value },
  };
}

/* --------------------------------------------------------------------------
 * BBOX helpers: convert radius in km to EPSG:4326 degrees
 * ------------------------------------------------------------------------ */

function kmToDegLat(km) {
  return km / 111.0;
}

function kmToDegLon(km, lat) {
  const c = Math.cos((lat * Math.PI) / 180);
  return c ? km / (111.32 * c) : 0;
}

/**
 * Create a WFS URL with a bbox parameter around [lat, lon].
 */
function urlWithBbox(baseUrl, lat, lon, radiusKm) {
  const dy = kmToDegLat(radiusKm);
  const dx = kmToDegLon(radiusKm, lat);
  const minLon = lon - dx,
    minLat = lat - dy,
    maxLon = lon + dx,
    maxLat = lat + dy;
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}bbox=${minLon},${minLat},${maxLon},${maxLat},CRS:84`;
}

/* ============================================================================
 * Cluster layer for parking points (MarkerCluster)
 * ========================================================================== */

const clusters = L.markerClusterGroup({
  spiderfyOnEveryZoom: false,
  showCoverageOnHover: false,
  disableClusteringAtZoom: 16,
});
map.addLayer(clusters);

/* ============================================================================
 * Sidebar: menu & collapse behaviour
 * ========================================================================== */

btnAddData?.addEventListener("click", () => {
  addMenu.style.display =
    addMenu.style.display === "none" || !addMenu.style.display ? "block" : "none";
});

let collapsed = false;
btnCollapse?.addEventListener("click", () => {
  collapsed = !collapsed;
  sidebar.style.width = collapsed ? "56px" : "260px";
  mapEl.style.left = collapsed ? "56px" : "260px";
  btnCollapse.textContent = collapsed ? "⟩" : "⟨";
  addMenu.style.display = "none";
});

/* ============================================================================
 * Layer registry UI (for uploaded / WFS layers)
 * ========================================================================== */

const userLayers = new Map(); // id -> { layer, name }
let layerAutoId = 1;

/**
 * Register a Leaflet layer in the sidebar with:
 *  - visibility checkbox
 *  - "Zoom" button
 *  - "Remove" button
 */
function addLayerToList(name, layer) {
  const id = `usr-${layerAutoId++}`;
  userLayers.set(id, { layer, name });

  const row = document.createElement("div");
  row.className = "layer-row";
  row.innerHTML = `
    <input type="checkbox" checked style="accent-color:#2d6cdf;" />
    <div class="name">${name}</div>
    <button class="btn-mini zoom" title="Zoom">Zoom</button>
    <button class="btn-mini remove" title="Remove">✕</button>
  `;
  const [chk, , btnZoom, btnRemove] = row.children;

  chk.addEventListener("change", () => {
    if (chk.checked) layer.addTo(map);
    else map.removeLayer(layer);
  });

  btnZoom.addEventListener("click", () => {
    try {
      map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    } catch {}
  });

  btnRemove.addEventListener("click", () => {
    map.removeLayer(layer);
    userLayers.delete(id);
    row.remove();
  });

  layerList.prepend(row);
}

/* ============================================================================
 * Upload local GeoJSON
 * ========================================================================== */

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
    try {
      map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    } catch {}
  } catch (err) {
    alert("Failed to load GeoJSON: " + err.message);
  } finally {
    fileInput.value = "";
  }
});

/* ============================================================================
 * WFS modal: connect and add remote vector data
 * ========================================================================== */

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

/**
 * Connect to a WFS GetFeature URL (optionally restricted to current map bbox),
 * load it as a GeoJSON layer, add to map + layer list, and set it as
 * ACTIVE_DS for later LLM-powered parking queries.
 */
wfsConnect?.addEventListener("click", async () => {
  const urlInput = wfsFullUrl.value.trim();
  const name = wfsLayerName.value.trim() || "WFS Layer";

  if (!/^https?:\/\//i.test(urlInput)) {
    wfsStatus.textContent = "Please enter a valid WFS URL.";
    wfsStatus.style.color = "crimson";
    return;
  }

  // Add map bounding box filter (if user didn't specify one)
  const bounds = map.getBounds();
  const bboxParam = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()},CRS:84`;
  const hasBbox = urlInput.includes("bbox=");
  const url = hasBbox
    ? urlInput
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
          .map((k) => `<b>${k}:</b> ${p[k]}`)
          .join("<br>");
        l.bindPopup(html || name);
      },
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, { radius: 5 }),
    }).addTo(map);

    addLayerToList(name, layer);

    // Keep a reference so chat can filter nearest points later
    window._lastDataLayer = layer;

    // Make the just-added WFS the active datasource for chat
    setActiveDataSource({ kind: "wfs", url });

    // Persist WFS layer info (for future extensions)
    try {
      const rec = { type: "wfs", name, url };
      const saved = JSON.parse(localStorage.getItem("layers.wfs") || "[]");
      saved.push(rec);
      localStorage.setItem("layers.wfs", JSON.stringify(saved));
      toast(`Added WFS layer: ${name}`, "ok");
    } catch {}

    try {
      map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    } catch {}

    wfsStatus.textContent = "Layer added successfully (within view).";
    wfsStatus.style.color = "lightgreen";
    setTimeout(() => (wfsModal.style.display = "none"), 400);
  } catch (err) {
    wfsStatus.textContent = "Failed: " + err.message;
    wfsStatus.style.color = "crimson";
  }
});

/* ============================================================================
 * Parking layer based on active WFS datasource
 * ========================================================================== */

let parkingAbort = null;
let parkingLayer = null;

/**
 * Load parking features from the ACTIVE_DS WFS within a radius (km)
 * around [lat, lon], and render them as a clustered circleMarker layer.
 */
async function loadParking(opts = {}) {
  const { lat, lon, radius_km = 2 } = opts;

  if (!ACTIVE_DS || ACTIVE_DS.kind !== "wfs") {
    console.warn("No active datasource set. Add a WFS first.");
    toast("No datasource set. Add a WFS first.", "warn");
    return;
  }
  if (typeof lat !== "number" || typeof lon !== "number") {
    console.warn("loadParking: missing lat/lon");
    return;
  }

  let url = urlWithBbox(ACTIVE_DS.url, lat, lon, radius_km);
  url = applyAuthToUrl(url);

  if (parkingAbort) parkingAbort.abort();
  parkingAbort = new AbortController();

  showLoader(true);
  try {
    const init = applyAuthToFetchInit({ signal: parkingAbort.signal });
    const resp = await fetch(url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (parkingLayer) clusters.removeLayer(parkingLayer);

    parkingLayer = L.geoJSON(data, {
      onEachFeature: (f, l) => {
        const p = f.properties || {};
        const html = Object.keys(p)
          .slice(0, 10)
          .map((k) => `<b>${k}:</b> ${p[k]}`)
          .join("<br>");
        l.bindPopup(html || "Parking");
      },
      pointToLayer: (_f, ll) =>
        L.circleMarker(ll, { radius: 6, weight: 1, fillOpacity: 0.85 }),
    });

    clusters.addLayer(parkingLayer);
    try {
      map.fitBounds(parkingLayer.getBounds(), {
        maxZoom: 16,
        padding: [20, 20],
      });
    } catch {}
  } catch (err) {
    if (err.name !== "AbortError")
      console.error("Active WFS fetch failed:", err);
  } finally {
    showLoader(false);
  }
}

// Expose for debugging or manual calls from the console
window.loadParking = loadParking;

/* ============================================================================
 * Highlight nearby features from the active layer
 * ========================================================================== */

let nearbyLayer = null;

/**
 * Highlight features from srcLayer that fall within radiusKm of [lat, lon].
 * Used after an LLM parking query to visually emphasise relevant features.
 */
function highlightNearbyFromLayer(srcLayer, lat, lon, radiusKm = 2) {
  if (!srcLayer) {
    console.warn("No data layer to filter.");
    return;
  }
  if (nearbyLayer) {
    map.removeLayer(nearbyLayer);
    nearbyLayer = null;
  }

  const center = L.latLng(lat, lon);
  const radiusM = (radiusKm || 2) * 1000;
  const hits = [];

  srcLayer.eachLayer((l) => {
    const ll = l.getLatLng
      ? l.getLatLng()
      : l.getBounds
      ? l.getBounds().getCenter()
      : null;
    if (!ll) return;
    if (center.distanceTo(ll) <= radiusM) {
      if (l.feature) hits.push(l.feature);
    }
  });

  if (!hits.length) {
    toast && toast("No points within radius.", "warn");
    return;
  }

  nearbyLayer = L.geoJSON(
    { type: "FeatureCollection", features: hits },
    {
      pointToLayer: (_f, ll) =>
        L.circleMarker(ll, {
          radius: 7,
          color: "#c00",
          weight: 2,
          fillOpacity: 0.9,
        }),
    }
  ).addTo(map);
}

/* ============================================================================
 * Chat wiring (frontend part of LLM interaction)
 * ========================================================================== */

/**
 * Append a message to the chat log.
 * who = "you" (user) or "bot" (LLM).
 */
function addLog(text, who = "bot") {
  if (!chatLog) return;
  const msg = document.createElement("div");
  msg.className = `chat-msg ${who === "you" ? "chat-user" : "chat-bot"}`;
  msg.textContent = text;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/**
 * Execute an array of actions produced by the /chat endpoint.
 * Supported action types:
 *   - setView
 *   - loadParking
 *   - loadWFS
 */
async function applyActions(actions = []) {
  for (const a of actions || []) {
    try {
      switch (a.type) {
        case "setView": {
          const { lat, lon, zoom } = a;
          if (typeof lat === "number" && typeof lon === "number") {
            map.setView(
              [lat, lon],
              typeof zoom === "number" ? zoom : map.getZoom()
            );
          }
          break;
        }

        case "loadParking": {
          let { city, lat, lon, radiusKm, place, nearMe } = a;

          // If the model only provided "city", use it as a place hint.
          if (!place && city) place = city;

          const loc = await resolveLocation({
            lat,
            lon,
            place,
            preferUser: !!nearMe, // "near me"
          });

          await loadParking({
            city,
            lat: loc.lat,
            lon: loc.lon,
            radius_km: typeof radiusKm === "number" ? radiusKm : 5,
          });

          // Highlight subset around the resolved location
          if (window._lastDataLayer) {
            highlightNearbyFromLayer(
              window._lastDataLayer,
              loc.lat,
              loc.lon,
              typeof radiusKm === "number" ? radiusKm : 5
            );
          } else {
            console.warn("No WFS layer loaded; nothing to filter.");
          }

          map.setView([loc.lat, loc.lon], 13);
          break;
        }

        case "loadWFS": {
          const { url } = a;
          if (!/^https?:\/\//i.test(url || "")) break;
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          const layer = L.geoJSON(data, {
            pointToLayer: (_f, ll) => L.circleMarker(ll, { radius: 5 }),
          }).addTo(map);
          addLayerToList("WFS", layer);
          try {
            map.fitBounds(layer.getBounds(), { padding: [20, 20] });
          } catch {}
          break;
        }
      }
    } catch (e) {
      console.error("Action failed:", a, e);
    }
  }
}

/**
 * Send a user message to the Flask /chat endpoint and display the reply.
 * The backend returns:
 *   {
 *     reply: "short user-facing message",
 *     actions: [ ... ]
 *   }
 */
async function runChat(message) {
  addLog(message, "you");

  const typing = document.createElement("div");
  typing.className = "typing";
  typing.textContent = "Assistant is typing…";
  chatLog.appendChild(typing);
  chatLog.scrollTop = chatLog.scrollHeight;

  try {
    const ctr = map.getCenter();
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        center: { lat: ctr.lat, lon: ctr.lng },
      }),
    });
    const payload = await res.json();
    typing.remove();
    addLog(payload.reply || "✓", "bot");
    await applyActions(payload.actions || []);
  } catch (err) {
    typing.remove();
    console.error("runChat error:", err);
    addLog("Error contacting the model. Check the server logs.", "bot");
  }
}

// Basic chat UI events
if (chatSend && chatInput) {
  chatSend.addEventListener("click", () => {
    const t = chatInput.value.trim();
    if (t) {
      runChat(t);
      chatInput.value = "";
    }
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") chatSend.click();
  });
}

/* ============================================================================
 * Geocoding + "near me" helpers
 * ========================================================================== */

const geocodeCache = new Map(); // q -> {lat, lon, name}

/**
 * Small normalisation for place names: expands abbreviations like "Hbf".
 */
function normalizePlaceText(t = "") {
  return t
    .replace(/\bHbf\b/gi, "Hauptbahnhof")
    .replace(/\bStn\b/gi, "Station")
    .trim();
}

/**
 * Call the Flask /geocode endpoint with a free-text query.
 * Optionally bias by current map bounds.
 */
async function geocodeFreeText(query, biasBounds) {
  const q = normalizePlaceText(query);
  if (geocodeCache.has(q)) return geocodeCache.get(q);

  const b = biasBounds || map.getBounds();
  const viewbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;

  const url = `/geocode?q=${encodeURIComponent(
    q
  )}&viewbox=${encodeURIComponent(viewbox)}&countrycodes=de`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (data.ok) {
    const hit = { lat: data.lat, lon: data.lon, name: data.name };
    geocodeCache.set(q, hit);
    return hit;
  }
  return null;
}

/**
 * Request the user's browser location once (if permission is granted).
 */
function getBrowserLocationOnce() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000 }
    );
  });
}

/**
 * Resolve the location to use for a parking query.
 * Priority:
 *  1) Explicit lat/lon from the LLM action
 *  2) Device location ("near me")
 *  3) Geocode text (station, POI, etc.)
 *  4) Current map center as a fallback
 */
async function resolveLocation({ lat, lon, place, preferUser = false }) {
  // 1) explicit coordinates from action
  if (typeof lat === "number" && typeof lon === "number") {
    return { lat, lon, source: "action" };
  }

  // 2) "near me" -> device location
  if (preferUser) {
    const me = await getBrowserLocationOnce();
    if (me) return { ...me, source: "device" };
  }

  // 3) Map center as default context
  const ctr = map.getCenter();
  const centerGuess = { lat: ctr.lat, lon: ctr.lng, source: "center" };

  // 4) Optional free-text geocoding
  if (place && place.trim()) {
    const hit = await geocodeFreeText(place);
    if (hit) {
      return { lat: hit.lat, lon: hit.lon, source: "geocode", name: hit.name };
    }
  }

  return centerGuess;
}
