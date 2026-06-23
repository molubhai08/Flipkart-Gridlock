/**
 * mappls-init.js — EnforceIQ AI
 *
 * Bootstraps Mappls (MapmyIndia) map tiles across all three map instances
 * (mainMap, predictMap, patrolMap).  Falls back silently to OpenStreetMap
 * if the Mappls SDK fails to load or the key is invalid.
 *
 * Architecture:
 *   - Mappls SDK is loaded as a <script> tag in index.html with the real key
 *   - This file waits for the SDK's `mappls` global, then patches the tile
 *     layer factory used by main.js
 *   - Also provides mapplsGeocodeSearch() and mapplsNearbyParking() helpers
 *     that main.js can call for enriched data
 */

const MAPPLS_KEY = 'tixojjropqmbacoxrqsklzfujcmjuooamygh';
const BENGALURU_CENTER = [12.9716, 77.5946];

/* ── OSM fallback tile layer ─────────────────────────────────────────────── */
function osmTileLayer() {
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  });
}

/* ── Mappls vector tile layer (Leaflet-compatible) ───────────────────────── */
function mapplsTileLayer() {
  // Mappls raster tile endpoint — works with standard Leaflet TileLayer
  return L.tileLayer(
    `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_KEY}/still_map/{z}/{x}/{y}.png`,
    {
      attribution: '© <a href="https://www.mapmyindia.com">MapmyIndia</a> | © EnforceIQ AI',
      maxZoom: 20,
      subdomains: [],
      crossOrigin: true
    }
  );
}

/* ── Mappls Hybrid tile layer (satellite + roads) ────────────────────────── */
function mapplsHybridLayer() {
  return L.tileLayer(
    `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_KEY}/hybrid_map/{z}/{x}/{y}.png`,
    {
      attribution: '© MapmyIndia | © EnforceIQ AI',
      maxZoom: 20,
      crossOrigin: true
    }
  );
}

/* ── Global tile layer factory — called by main.js ───────────────────────── */
window.MAPPLS_READY = false;
window.getBaseTileLayer = function (type = 'standard') {
  if (window.MAPPLS_READY) {
    return type === 'hybrid' ? mapplsHybridLayer() : mapplsTileLayer();
  }
  return osmTileLayer();
};

/* -- Patch existing maps once they are created ----------------------------- */
function patchMapsWithMappls() {
  // Poll until main.js has initialised ALL map globals
  // (mainMap is lazy-init on MAP tab; dashMiniMap on DASHBOARD load;
  //  predictMap/patrolMap on their respective tabs)
  const MAX_WAIT = 30000; // give up after 30 s
  const start    = Date.now();
  const interval = setInterval(() => {
    // dashMiniMap is the first to appear (dashboard is default tab)
    // We swap as soon as at least dashMiniMap exists; the others get
    // swapped when they are individually initialised later.
    const anyReady = window.dashMiniMap || window.mainMap ||
                     window.predictMap  || window.patrolMap;
    if (anyReady || Date.now() - start > MAX_WAIT) {
      clearInterval(interval);
      swapTileLayers();
    }
  }, 300);
}

function swapTileLayers() {
  // Include dashMiniMap alongside the other three map instances
  [window.dashMiniMap, window.mainMap, window.predictMap, window.patrolMap].forEach(map => {
    if (!map) return;
    map.eachLayer(layer => {
      if (layer instanceof L.TileLayer) map.removeLayer(layer);
    });
    mapplsTileLayer().addTo(map);
  });

  // Update the attribution watermark in the nav bar
  const badge = document.createElement('span');
  badge.style.cssText = 'font-size:9px;color:#10b981;border:1px solid rgba(16,185,129,0.4);border-radius:4px;padding:2px 7px;font-weight:700;margin-left:8px;letter-spacing:0.5px;';
  badge.textContent = '🗺 MapmyIndia';
  const brand = document.querySelector('.nav-brand');
  if (brand && !document.getElementById('mappls-badge')) {
    badge.id = 'mappls-badge';
    brand.appendChild(badge);
  }

  window.MAPPLS_READY = true;
  console.log('✓ Mappls tile layers active across all map instances');

  // Add layer switcher to main map
  addMapplsLayerSwitcher();
}

/* ── Layer switcher (Standard / Hybrid) ─────────────────────────────────── */
function addMapplsLayerSwitcher() {
  const map = window.mainMap;
  if (!map) return;

  const ctrl = document.getElementById('layer-controller');
  if (!ctrl || document.getElementById('mappls-layer-switcher')) return;

  const switcher = document.createElement('div');
  switcher.id = 'mappls-layer-switcher';
  switcher.style.cssText = 'margin-top:10px;border-top:1px solid #334155;padding-top:8px;';
  switcher.innerHTML = `
    <div class="layer-ctrl-title" style="margin-bottom:6px;">MAP STYLE</div>
    <div style="display:flex;gap:5px;">
      <button id="ms-btn-standard" onclick="setMapplsStyle('standard')"
        style="flex:1;padding:4px 6px;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer;
               background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd;letter-spacing:0.5px;">
        STANDARD
      </button>
      <button id="ms-btn-hybrid" onclick="setMapplsStyle('hybrid')"
        style="flex:1;padding:4px 6px;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer;
               background:none;border:1px solid #334155;color:#64748b;letter-spacing:0.5px;">
        HYBRID
      </button>
    </div>`;
  ctrl.appendChild(switcher);
}

window.setMapplsStyle = function (style) {
  const map = window.mainMap;
  if (!map) return;
  map.eachLayer(layer => { if (layer instanceof L.TileLayer) map.removeLayer(layer); });
  (style === 'hybrid' ? mapplsHybridLayer() : mapplsTileLayer()).addTo(map);

  document.getElementById('ms-btn-standard').style.background = style === 'standard' ? '#1e3a5f' : 'none';
  document.getElementById('ms-btn-standard').style.borderColor = style === 'standard' ? '#3b82f6' : '#334155';
  document.getElementById('ms-btn-standard').style.color = style === 'standard' ? '#93c5fd' : '#64748b';
  document.getElementById('ms-btn-hybrid').style.background = style === 'hybrid' ? '#1e3a5f' : 'none';
  document.getElementById('ms-btn-hybrid').style.borderColor = style === 'hybrid' ? '#3b82f6' : '#334155';
  document.getElementById('ms-btn-hybrid').style.color = style === 'hybrid' ? '#93c5fd' : '#64748b';
};

/* ── Mappls Geocode (place search) ───────────────────────────────────────── */
window.mapplsGeocodeSearch = async function (query) {
  try {
    const url = `https://atlas.mappls.com/api/places/geocode?address=${encodeURIComponent(query)}&region=IND`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${MAPPLS_KEY}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.copResults?.[0];
    if (!result) return null;
    return { lat: parseFloat(result.latitude), lng: parseFloat(result.longitude), name: result.placeName };
  } catch (e) {
    return null;
  }
};

/* ── Mappls Nearby Parking search ────────────────────────────────────────── */
window.mapplsNearbyParking = async function (lat, lng, radius = 500) {
  try {
    const url = `https://atlas.mappls.com/api/places/nearby/json?keywords=parking&refLocation=${lat},${lng}&radius=${radius}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${MAPPLS_KEY}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.suggestedLocations || []).map(p => ({
      name: p.placeName,
      lat:  parseFloat(p.latitude),
      lng:  parseFloat(p.longitude),
      dist: p.distance
    }));
  } catch (e) {
    return [];
  }
};

/* ── Mappls Routing (driving directions) ─────────────────────────────────── */
window.mapplsRoute = async function (waypoints) {
  // waypoints: [{lat, lng}, ...]
  if (waypoints.length < 2) return null;
  try {
    const coords = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
    const url = `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_KEY}/route_adv/driving/${coords}?geometries=geojson&overview=full`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null;
    return {
      distance_km: (route.distance / 1000).toFixed(2),
      duration_min: Math.round(route.duration / 60),
      geometry: route.geometry
    };
  } catch (e) {
    return null;
  }
};

/* ── Startup sequence ────────────────────────────────────────────────────── */
(function init() {
  // Try Mappls SDK load  test tile URL with HEAD request
  fetch(`https://apis.mappls.com/advancedmaps/v1/${MAPPLS_KEY}/still_map/12/2879/1761.png`, {
    method: 'HEAD'
  }).then((res) => {
    if (!res.ok) throw new Error('Mappls returned ' + res.status);
    // SDK loaded  swap tiles once main.js creates map instances
    patchMapsWithMappls();
  }).catch((e) => {
    console.warn('⚠ Mappls tiles unreachable — using fallback. Error:', e.message);
    window.MAPPLS_READY = false;
    
    // If Mappls fails, ensure the mini-map uses CartoDB Dark (since it looks better)
    if (window.dashMiniMap) {
      window.dashMiniMap.eachLayer(layer => {
        if (layer instanceof L.TileLayer) window.dashMiniMap.removeLayer(layer);
      });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
      }).addTo(window.dashMiniMap);
    }
  });
})();
