/* =========================================================
   EnforceIQ AI — main.js
   Vanilla JS + Leaflet + leaflet.heat
   Backend: http://localhost:8000
   ========================================================= */

const BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8000'
  : '';

// ── State ─────────────────────────────────────────────────
const state = {
  hour: -1, dow: -1, month: -1,
  vehicleType: 'all', violationType: 'all',
  predHour: 9, predDow: 0,
  patrolUnits: 4, shiftStart: 9, shiftDuration: 8,
  patrolStation: 'Upparpet', coverageThreshold: 0.4,
  heatmapWeightMode: 'volume'
};

// -- Map instances ---------------------------------------------------------
let mainMap, predictMap, patrolMap, dashMiniMap;
let mainHeatLayer, predictHeatLayer, dashMiniHeatLayer;
let dashMiniMarkers = [];
let junctionData  = [];   // flat array, populated by loadJunctions()
let PREDICTIONS_JS = {};  // loaded once at startup for simulation

// ── Utilities ─────────────────────────────────────────────
function fmt(n) {
  return Number(n).toLocaleString('en-IN');
}

function animateCount(element, target, duration, suffix = '') {
  const start    = performance.now();
  const isFloat  = !Number.isInteger(target);
  function tick(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current  = eased * target;
    element.textContent = (isFloat ? current.toFixed(2) : Math.round(current)) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

const DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR  = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';
const BENGALURU  = [12.9716, 77.5946];

// ── Smart tile layer: Mappls if ready, else CartoDB dark ──────────────────
function smartTileLayer() {
  // getBaseTileLayer is defined in mappls-init.js and returns Mappls tiles
  // if the SDK loaded successfully, else falls back to OSM/CartoDB.
  if (typeof window.getBaseTileLayer === 'function') {
    return window.getBaseTileLayer('standard');
  }
  return L.tileLayer(DARK_TILES, { attribution: TILE_ATTR });
}

// ── Map initialisation ────────────────────────────────────
// Only init mainMap on page load.
// predictMap and patrolMap are init lazily when their tabs open
// (hidden divs have zero size — Leaflet crashes on them).

function initMainMap() {
  mainMap = L.map('map', { zoomControl: true }).setView(BENGALURU, 12);
  smartTileLayer().addTo(mainMap);
  mainHeatLayer = L.heatLayer([], { radius: 25, blur: 20, maxZoom: 17, max: 10 }).addTo(mainMap);
}

function initPredictMap() {
  if (predictMap) { predictMap.invalidateSize(); return; }
  predictMap = L.map('predict-map', { zoomControl: true }).setView(BENGALURU, 12);
  smartTileLayer().addTo(predictMap);
  predictHeatLayer = L.heatLayer([], { radius: 25, blur: 20, maxZoom: 17, max: 2 }).addTo(predictMap);
}

function initPatrolMap() {
  if (patrolMap) { patrolMap.invalidateSize(); return; }
  patrolMap = L.map('patrol-map', { zoomControl: true }).setView(BENGALURU, 12);
  smartTileLayer().addTo(patrolMap);
}

// ── KPI bar ───────────────────────────────────────────────
async function loadKPIs() {
  const d = await fetch(`${BASE}/api/kpis`).then(r => r.json());
  document.getElementById('kpi-total').textContent      = fmt(d.total_violations);
  document.getElementById('kpi-actions').textContent    = fmt(d.actions_taken);
  document.getElementById('kpi-efficiency').textContent = d.enforcement_efficiency + '%';
  document.getElementById('kpi-null-text').textContent  =
    `${fmt(d.null_validation_count)} violations with zero enforcement follow-through`;
}

// ── UI Interactions (Accordions, Toasts) ──────────────────
function setupUIInteractions() {
  // Accordions
  document.querySelectorAll('.accordion-header').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('open');
      const target = document.getElementById(btn.dataset.target);
      if (target) target.classList.toggle('open');
    });
  });

  // KPI Null Toast Dismiss
  document.getElementById('null-toast-dismiss')?.addEventListener('click', () => {
    document.getElementById('kpi-null-toast').classList.add('dismissed');
  });

  // Export Itinerary Copy Summary
  document.getElementById('export-itinerary-btn')?.addEventListener('click', exportDispatchSummary);
}

function exportDispatchSummary() {
  if (!patrolDataGlobal || !patrolDataGlobal.units) {
    alert("Please generate optimal routes first!");
    return;
  }
  let summary = `📋 *ENFORCEIQ — PATROL DISPATCH SUMMARY*\n`;
  summary += `--------------------------------------------------\n`;
  summary += `Algorithm:  ${patrolDataGlobal.algorithm}\n`;
  summary += `Base Station: ${state.patrolStation}\n`;
  summary += `Shift Span:   ${String(state.shiftStart).padStart(2, '0')}:00 for ${state.shiftDuration} hours\n`;
  summary += `GA Coverage:  ${patrolDataGlobal.total_coverage_pct}%\n`;
  summary += `Baseline Coverage: ${patrolDataGlobal.baseline_fixed_shift_pct}%\n`;
  summary += `--------------------------------------------------\n\n`;

  patrolDataGlobal.units.forEach(unit => {
    summary += `🚔 *PATROL SQUAD ${unit.unit_id}* (Coverage: ${unit.unit_coverage_pct}%)\n`;
    if (!unit.route || unit.route.length === 0) {
      summary += `  • No checkpoints assigned.\n`;
    } else {
      unit.route.forEach((stop, i) => {
        summary += `  ${i+1}. [${stop.arrive} - ${stop.depart}] ${stop.junction}\n`;
        summary += `     • Action: ${stop.intervention_type} (LOS ${stop.los_grade})\n`;
        summary += `     • Predicted Violations/hr: ${stop.predicted_violations}\n`;
        summary += `     • Revisit Target: ${stop.revisit_at}\n`;
      });
    }
    summary += `\n`;
  });

  navigator.clipboard.writeText(summary).then(() => {
    // Open mailto with summary as body
    const email  = prompt('Enter officer email address to send dispatch to:');
    if (!email) return;
    const subject = encodeURIComponent('EnforceIQ Patrol Dispatch Summary');
    const body    = encodeURIComponent(summary);
    window.open(`mailto:${email}?subject=${subject}&body=${body}`, '_blank');

    const btn = document.getElementById('export-itinerary-btn');
    const origText = btn.innerHTML;
    btn.textContent = '✓ Opening Mail...';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.innerHTML = origText;
      btn.style.background = '#3b82f6';
    }, 2500);
  }).catch(() => {
    // Fallback if clipboard fails — open mailto directly
    const email  = prompt('Enter officer email address to send dispatch to:');
    if (!email) return;
    const subject = encodeURIComponent('EnforceIQ Patrol Dispatch Summary');
    const body    = encodeURIComponent(summary);
    window.open(`mailto:${email}?subject=${subject}&body=${body}`, '_blank');
  });
}

// ── Filter options ────────────────────────────────────────
async function loadFilterOptions() {
  const d = await fetch(`${BASE}/api/filter-options`).then(r => r.json());

  const vSel = document.getElementById('vehicle-select');
  (d.vehicle_types || []).forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    vSel.appendChild(o);
  });

  const viSel = document.getElementById('violation-select');
  (d.violation_types || []).forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    viSel.appendChild(o);
  });
}

// ── Heatmap ───────────────────────────────────────────────
async function updateHeatmap() {
  const params = new URLSearchParams({
    hour:           state.hour,
    dow:            state.dow,
    month:          state.month,
    vehicle_type:   state.vehicleType,
    violation_type: state.violationType,
  });
  const data = await fetch(`${BASE}/api/heatmap?${params}`).then(r => r.json());
  
  // Build a 3dp lookup mapping for cluster capacity_lost_pct
  const congestionMap = new Map();
  if (junctionData && junctionData.length > 0) {
    junctionData.forEach(j => {
      const key = `${j.lat.toFixed(3)},${j.lon.toFixed(3)}`;
      congestionMap.set(key, j.capacity_lost_pct || 0);
    });
  }

  const points = data.map(p => {
    let weightMultiplier = 1.0;
    if (state.heatmapWeightMode === 'congestion') {
      const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
      const loss = congestionMap.get(key) || 0;
      // Map 0-100% capacity loss to a multiplier range of 0.2 to 5.0
      weightMultiplier = 0.2 + (loss / 100) * 4.8;
    }
    return [p.lat, p.lon, p.weight * weightMultiplier];
  });
  mainHeatLayer.setLatLngs(points);

  // Only update circle sizes when a real filter is active.
  // If everything is at defaults (all hours, all days, all months, all types)
  // the circles should show their all-time totals — passing the full heatmap
  // as filteredCounts causes coordinate-precision mismatches that hide circles.
  const isFiltered = state.hour >= 0 || state.dow >= 0 || state.month >= 0
    || state.vehicleType !== 'all' || state.violationType !== 'all';

  if (isFiltered) {
    // Build a lat/lon key → weight map. Use 4dp rounding (~11m grid) so minor
    // float precision differences between the heatmap and junctions APIs don't
    // cause misses.
    const filteredCounts = new Map();
    data.forEach(p => {
      const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      filteredCounts.set(key, (filteredCounts.get(key) || 0) + p.weight);
    });
    renderJunctionMarkers(filteredCounts);
  } else {
    // No active filter — render circles using all-time totals as normal.
    renderJunctionMarkers();
  }
}

const debouncedHeatmap = debounce(updateHeatmap, 400);

// ── Junction markers & Layers ─────────────────────────────
const LOS_COLORS = {
  F: '#ef4444', E: '#f97316',
  D: '#eab308', C: '#eab308',
  B: '#22c55e', A: '#22c55e',
};

let markerLayerGroup = L.layerGroup(); // To hold all cluster markers

// filteredCounts: optional Map<"lat,lon" → weight> from the current heatmap
// response.  When provided, circle sizes/colors reflect the filtered period;
// when absent (initial load, toggle) all-time totals are used instead.
function renderJunctionMarkers(filteredCounts) {
  markerLayerGroup.clearLayers();

  const showClusters = document.getElementById('toggle-clusters')?.checked !== false;
  const showAll      = document.getElementById('toggle-all-clusters')?.checked === true;

  if (!showClusters) {
    if (mainMap.hasLayer(markerLayerGroup)) mainMap.removeLayer(markerLayerGroup);
    return;
  }

  // When a filteredCounts map is supplied, derive a max weight so radius
  // scaling is relative to the filtered dataset (not the all-time max).
  const useFiltered  = filteredCounts instanceof Map && filteredCounts.size > 0;
  const filteredMax  = useFiltered
    ? Math.max(...filteredCounts.values(), 1)
    : null;

  junctionData.forEach(d => {
    // Use 4dp rounding to match the key built in updateHeatmap()
    const key            = `${d.lat.toFixed(4)},${d.lon.toFixed(4)}`;
    const filteredWeight = useFiltered ? (filteredCounts.get(key) || 0) : null;

    // When filtered, hide junctions with zero counts in the selected period
    // unless "show all" is ticked — so the map stays uncluttered.
    if (useFiltered && !showAll && filteredWeight === 0) return;

    // Without filter, keep the previous behaviour (E/F only unless show-all).
    if (!useFiltered && !showAll && d.los_grade !== 'E' && d.los_grade !== 'F') return;

    // Radius: scale against filtered max when a filter is active,
    // otherwise fall back to all-time total.
    let radius;
    if (useFiltered && filteredWeight !== null) {
      radius = Math.max(5, Math.min(20, (filteredWeight / filteredMax) * 20));
    } else {
      radius = Math.max(6, Math.min(20, Math.sqrt(d.total_violations / 50)));
    }

    // Color: when filtered and weight is low relative to max, desaturate
    // toward grey so hotspots visually pop.
    let color = LOS_COLORS[d.los_grade] || '#94a3b8';
    let fillOpacity = 0.8;
    if (useFiltered && filteredMax !== null) {
      const intensity = filteredWeight / filteredMax; // 0..1
      fillOpacity = Math.max(0.2, intensity * 0.9);
    }

    const marker = L.circleMarker([d.lat, d.lon], {
      radius,
      fillColor:   color,
      fillOpacity,
      weight:      1.5,
      color:       '#1e293b',
    });

    marker.bindTooltip(
      useFiltered && filteredWeight !== null
        ? `${d.name}<br>${Math.round(filteredWeight)} violations (filtered)`
        : `${d.name}<br>${d.total_violations.toLocaleString('en-IN')} total violations`,
      { direction: 'top', sticky: true }
    );
    marker.on('click', () => openJunctionPanel(d.name));
    markerLayerGroup.addLayer(marker);
  });

  if (!mainMap.hasLayer(markerLayerGroup)) {
    markerLayerGroup.addTo(mainMap);
  }
}

async function loadJunctions() {
  const data = await fetch(`${BASE}/api/junctions`).then(r => r.json());
  junctionData = data;  // store for rank computation
  renderJunctionMarkers();
}

// ── Layer Controller Setup ────────────────────────────────
function setupLayerController() {
  const toggleHeatmap = document.getElementById('toggle-heatmap');
  const toggleClusters = document.getElementById('toggle-clusters');
  const toggleAllClusters = document.getElementById('toggle-all-clusters');

  toggleHeatmap?.addEventListener('change', (e) => {
    if (e.target.checked) {
      if (!mainMap.hasLayer(mainHeatLayer)) mainMap.addLayer(mainHeatLayer);
    } else {
      if (mainMap.hasLayer(mainHeatLayer)) mainMap.removeLayer(mainHeatLayer);
    }
  });

  toggleClusters?.addEventListener('change', renderJunctionMarkers);
  toggleAllClusters?.addEventListener('change', renderJunctionMarkers);

  const hmVolBtn = document.getElementById('hm-mode-vol');
  const hmConBtn = document.getElementById('hm-mode-con');

  hmVolBtn?.addEventListener('click', () => {
    state.heatmapWeightMode = 'volume';
    hmVolBtn.classList.add('active');
    hmVolBtn.style.background = '#1e293b';
    hmVolBtn.style.color = '#f1f5f9';
    hmConBtn.classList.remove('active');
    hmConBtn.style.background = 'none';
    hmConBtn.style.color = '#64748b';
    updateHeatmap();
  });

  hmConBtn?.addEventListener('click', () => {
    state.heatmapWeightMode = 'congestion';
    hmConBtn.classList.add('active');
    hmConBtn.style.background = '#1e293b';
    hmConBtn.style.color = '#f1f5f9';
    hmVolBtn.classList.remove('active');
    hmVolBtn.style.background = 'none';
    hmVolBtn.style.color = '#64748b';
    updateHeatmap();
  });
}

// ── Junction panel ────────────────────────────────────────
async function openJunctionPanel(junctionName) {
  const d = await fetch(
    `${BASE}/api/junction?name=${encodeURIComponent(junctionName)}`
  ).then(r => r.json());

  // Sort all junctions desc by total_violations to find rank
  const sorted = [...junctionData].sort((a, b) => b.total_violations - a.total_violations);
  const rank   = sorted.findIndex(j => j.name === junctionName) + 1;

  // Name & badges
  document.getElementById('jp-name').textContent = d.name;
  document.getElementById('jp-rank-badge').textContent = `#${rank} of ${junctionData.length} clusters`;

  const itypeBadge = document.getElementById('jp-itype-badge');
  itypeBadge.textContent = d.intervention_type;
  itypeBadge.className   = 'badge';
  if (d.intervention_type === 'RESTRUCTURE') itypeBadge.classList.add('badge-orange');
  else if (d.intervention_type === 'ENFORCE') itypeBadge.classList.add('badge-blue');
  else if (d.intervention_type === 'PROCESS FIX') itypeBadge.classList.add('badge-red');

  // Stats row
  document.getElementById('jp-total').textContent    = fmt(d.total_violations);
  document.getElementById('jp-peak-hour').textContent = d.peak_hour + ':00';
  document.getElementById('jp-peak-day').textContent  = d.peak_dow;
  document.getElementById('jp-vehicle').textContent   = d.dominant_vehicle;

  // Road impact — lane animation
  const el = d.effective_lanes;
  const l1 = document.getElementById('lane1');
  const l2 = document.getElementById('lane2');
  const l3 = document.getElementById('lane3');

  l1.className = l2.className = l3.className = 'lane';

  if (el < 1) {
    l1.classList.add('blocked'); l2.classList.add('blocked'); l3.classList.add('blocked');
  } else if (el < 2) {
    l1.classList.add('blocked'); l2.classList.add('reduced'); l3.classList.add('free');
  } else if (el < 2.5) {
    l1.classList.add('blocked'); l2.classList.add('free');    l3.classList.add('free');
  } else if (el < 3) {
    l1.classList.add('reduced'); l2.classList.add('free');    l3.classList.add('free');
  } else {
    l1.classList.add('free');    l2.classList.add('free');    l3.classList.add('free');
  }

  document.getElementById('road-effective-label').textContent =
    `Effective: ${Number(el).toFixed(1)} / 3.0 lanes`;

  // LOS badge
  const losBadge = document.getElementById('jp-los');
  losBadge.textContent = d.los_grade;
  losBadge.className   = `los-badge los-${d.los_grade}`;

  document.getElementById('jp-lanes').textContent = el + ' / 3';
  animateCount(document.getElementById('jp-throughput'), d.throughput_loss, 1000, ' veh/hr');
  animateCount(document.getElementById('jp-co2'),        d.co2_kg_per_hour, 1000, ' kg/hr');

  // Capacity bar animation
  const fill = document.getElementById('capacity-bar-fill');
  const pct  = document.getElementById('capacity-bar-pct');
  fill.style.width = '0%';
  pct.textContent  = '0%';
  requestAnimationFrame(() => {
    setTimeout(() => {
      fill.style.width = d.capacity_lost_pct + '%';
      animateCount(pct, d.capacity_lost_pct, 800, '%');
    }, 50);
  });

  // Violation breakdown
  const vtypeChart = document.getElementById('jp-vtype-chart');
  vtypeChart.innerHTML = '';
  const vtypes = Object.entries(d.vtype_counts || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxCount = vtypes.length ? vtypes[0][1] : 1;
  vtypes.forEach(([name, count]) => {
    const row = document.createElement('div');
    row.className = 'vtype-row';
    const pctW = ((count / maxCount) * 100).toFixed(1) + '%';
    row.innerHTML = `
      <span class="vtype-name" title="${name}">${name}</span>
      <div class="vtype-bar-bg">
        <div class="vtype-bar-fill" style="width:${pctW};background:#3b82f6"></div>
      </div>
      <span class="vtype-count">${fmt(count)}</span>`;
    vtypeChart.appendChild(row);
  });

  // Monthly trend SVG
  renderTrendSVG(document.getElementById('jp-trend-chart'), d.monthly_trend || [], 300, 60);

  // Chronic badge
  const chronic = document.getElementById('jp-chronic-badge');
  if (d.is_chronic === true) {
    chronic.classList.remove('hidden');
  } else {
    chronic.classList.add('hidden');
  }

  // Enforcement gap
  document.getElementById('jp-null-pct').textContent = d.null_rate + '%';

  // Deterrence decay
  const decayText = document.getElementById('jp-decay-text');
  if (d.decay_minutes) {
    decayText.textContent =
      `Violations re-emerge ~${d.decay_minutes} minutes after patrol visit. ` +
      `Revisit scheduling calibrated to this window.`;
  } else {
    decayText.textContent = 'Insufficient repeat-visit data for this junction.';
  }

  // Recommendation
  document.getElementById('jp-rec-text').textContent  = d.recommendation;
  document.getElementById('jp-precedent').textContent = 'Precedent: ' + d.precedent;
  document.getElementById('jp-impact').textContent    = 'Estimated impact: ' + d.estimated_impact;

  const recEl = document.getElementById('jp-recommendation');
  recEl.className = 'jp-recommendation';
  if (d.intervention_type === 'RESTRUCTURE')  recEl.classList.add('restructure');
  else if (d.intervention_type === 'PROCESS FIX') recEl.classList.add('process');

  // Show panel + fly map to junction
  document.getElementById('junction-panel').classList.remove('hidden');
  mainMap.flyTo([d.lat, d.lon], 15, { animate: true, duration: 0.8 });
  // dismiss welcome banner on first junction click
  document.getElementById('map-welcome-banner')?.classList.add('dismissed');
}

// ── Trend SVG helper ──────────────────────────────────────
function renderTrendSVG(container, trend, svgW, svgH) {
  container.innerHTML = '';
  if (!trend || trend.length === 0) return;

  const padL = 4, padR = 4, padT = 8, padB = 18;
  const w = svgW - padL - padR;
  const h = svgH - padT - padB;
  const n = trend.length;

  const vals  = trend.map(t => t.count);
  const minV  = Math.min(...vals);
  const maxV  = Math.max(...vals);
  const range = maxV - minV || 1;

  const xOf = i => padL + (i / Math.max(n - 1, 1)) * w;
  const yOf = v => padT + h - ((v - minV) / range) * h;

  let pathD = trend.map((t, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(t.count).toFixed(1)}`).join(' ');

  let dots  = trend.map((t, i) =>
    `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(t.count).toFixed(1)}" r="3" fill="#3b82f6"/>`
  ).join('');

  let labels = trend.map((t, i) =>
    `<text x="${xOf(i).toFixed(1)}" y="${svgH - 2}" fill="#475569" font-size="8" text-anchor="middle">${t.month}</text>`
  ).join('');

  container.innerHTML =
    `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${svgH}px">` +
    `<path d="${pathD}" stroke="#3b82f6" fill="none" stroke-width="2"/>` +
    dots + labels +
    `</svg>`;
}

// ── Mini sparkline (40px tall) for intervention cards ─────
function renderMiniSparkline(container, trend) {
  container.innerHTML = '';
  if (!trend || trend.length === 0) return;

  const svgW = 120, svgH = 30;
  const padT = 4, padB = 4, padL = 2, padR = 2;
  const w = svgW - padL - padR;
  const h = svgH - padT - padB;
  const n = trend.length;

  const vals  = trend.map(t => t.count);
  const minV  = Math.min(...vals);
  const maxV  = Math.max(...vals);
  const range = maxV - minV || 1;

  const xOf = i => padL + (i / Math.max(n - 1, 1)) * w;
  const yOf = v => padT + h - ((v - minV) / range) * h;

  const pathD = trend.map((t, i) =>
    `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(t.count).toFixed(1)}`
  ).join(' ');

  container.innerHTML =
    `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${svgH}px">` +
    `<path d="${pathD}" stroke="#3b82f6" fill="none" stroke-width="1.5"/>` +
    `</svg>`;
}

// ── Predict tab ───────────────────────────────────────────
let predictMarkers = [];

async function loadPredictions() {
  const data = await fetch(
    `${BASE}/api/predict?hour=${state.predHour}&dow=${state.predDow}`
  ).then(r => r.json());

  // load model metrics once
  const metricsEl = document.getElementById('predict-model-metrics');
  if (metricsEl && metricsEl.textContent === '') {
    fetch(`${BASE}/api/model-info`).then(r => r.json()).then(m => {
      if (m.available && m.r2 !== undefined) {
        metricsEl.innerHTML =
          `R² Score: <strong>${m.r2}</strong> | MAE: <strong>${m.mae}</strong> violations/hr<br>` +
          `<span style="color:#64748b;font-size:9px;">Folds: ${m.n_folds} | Junctions: ${m.n_junctions} | Pre-cached: ${m.cache_entries}</span>`;
      }
    });
  }

  // list
  const list = document.getElementById('predict-list');
  list.innerHTML = '';
  data.slice(0, 5).forEach(p => {
    const card = document.createElement('div');
    card.className = 'predict-item';

    const decayTag = p.decay_minutes
      ? `<span class="predict-tag">⏱ re-emerge ~${p.decay_minutes} min</span>`
      : '';
    const itypeClass = p.intervention_type === 'RESTRUCTURE' ? 'badge-orange'
      : p.intervention_type === 'ENFORCE' ? 'badge-blue' : 'badge-red';

    card.innerHTML = `
      <div class="predict-item-header">
        <span class="predict-jname">${p.name}</span>
        <span class="predict-count">${Math.round(p.predicted_count)}</span>
      </div>
      <div class="predict-meta">
        <span class="badge ${itypeClass}" style="font-size:9px">${p.intervention_type}</span>
        <span class="predict-tag">LOS ${p.los_grade}</span>
        ${decayTag}
      </div>`;
    list.appendChild(card);
  });

  // map markers
  predictMarkers.forEach(m => predictMap.removeLayer(m));
  predictMarkers = [];
  if (predictHeatLayer) predictHeatLayer.setLatLngs([]);

  const heatPts = [];
  data.forEach(p => {
    const radius = Math.max(15, Math.min(50, Math.sqrt(p.predicted_count / 2) * 3));
    const m = L.circleMarker([p.lat, p.lon], {
      radius,
      fillColor:   '#3b82f6',
      fillOpacity: 0.85,
      weight:      2,
      color:       '#93c5fd',
    })
    .bindTooltip(`<b>${p.name}</b><br>🔮 ${Math.round(p.predicted_count)} predicted violations`, { sticky: true })
    .on('click', () => openPredDetail(p))
    .addTo(predictMap);
    predictMarkers.push(m);
    heatPts.push([p.lat, p.lon, p.predicted_count]);
  });
  if (predictHeatLayer) predictHeatLayer.setLatLngs(heatPts);
}


// ── Prediction detail panel ──────────────────────────────
async function openPredDetail(p) {
  const panel = document.getElementById('pred-detail-panel');

  // Intervention badge
  const itypeBadge = document.getElementById('pred-detail-itype');
  itypeBadge.textContent = p.intervention_type || '—';
  itypeBadge.className   = 'badge';
  if      (p.intervention_type === 'RESTRUCTURE') itypeBadge.classList.add('badge-orange');
  else if (p.intervention_type === 'ENFORCE')     itypeBadge.classList.add('badge-blue');
  else if (p.intervention_type === 'PROCESS FIX') itypeBadge.classList.add('badge-red');

  // Name & location
  document.getElementById('pred-detail-name').textContent = p.name || '—';
  document.getElementById('pred-detail-loc').textContent  =
    p.lat && p.lon ? `📍 ${p.lat.toFixed(4)}°N, ${p.lon.toFixed(4)}°E` : '';

  // ML predicted count
  document.getElementById('pred-detail-count').textContent = Math.round(p.predicted_count);

  // Fetch full junction data to get recommendation & estimated impact
  try {
    const jd = await fetch(`${BASE}/api/junction?name=${encodeURIComponent(p.name)}`).then(r => r.json());
    document.getElementById('pred-detail-rec').textContent    = jd.recommendation || '—';
    document.getElementById('pred-detail-impact').textContent = jd.estimated_impact ? '⭐ ' + jd.estimated_impact : '';
  } catch (err) {
    document.getElementById('pred-detail-rec').textContent    = '—';
    document.getElementById('pred-detail-impact').textContent = '';
  }

  panel.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('pred-detail-close');
  if (closeBtn) closeBtn.addEventListener('click', () =>
    document.getElementById('pred-detail-panel').classList.add('hidden')
  );
});

// ── Patrol tab ────────────────────────────────────────────
const UNIT_COLORS = [
  '#ef4444', '#3b82f6', '#22c55e', '#a855f7',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16'
];

let patrolLayers = [];
let patrolDataGlobal = null; // Store route data globally to filter without re-fetching
let patrolMarkers = [];      // Track live tracking markers (cars) on the map

async function generateRoutes() {
  const body = {
    num_units:            state.patrolUnits,
    shift_start_hour:     state.shiftStart,
    shift_duration_hours: state.shiftDuration,
    starting_station:     state.patrolStation,
    coverage_threshold:   state.coverageThreshold,
  };

  const data = await fetch(`${BASE}/api/patrol/optimize`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).then(r => r.json());

  patrolDataGlobal = data;

  // Show and populate patrol unit spotlight chips
  const filterGroup = document.getElementById('patrol-unit-filter-group');
  const unitChips = document.getElementById('patrol-unit-chips');
  const unitSelect = document.getElementById('patrol-unit-select');

  if (filterGroup && unitChips && unitSelect) {
    filterGroup.style.display = 'block';
    unitChips.innerHTML = '';
    unitSelect.innerHTML = '<option value="all">Show All Units</option>';

    // Add "All" chip
    const allChip = document.createElement('div');
    allChip.className = 'unit-chip active';
    allChip.style.borderColor = '#cbd5e1';
    allChip.style.color = '#cbd5e1';
    allChip.textContent = 'All Units';
    allChip.dataset.unit = 'all';
    unitChips.appendChild(allChip);

    data.units.forEach(u => {
      // populate hidden select
      const opt = document.createElement('option');
      opt.value = u.unit_id;
      opt.textContent = `Unit ${u.unit_id}`;
      unitSelect.appendChild(opt);

      // create chip
      const chip = document.createElement('div');
      chip.className = 'unit-chip';
      const color = UNIT_COLORS[(u.unit_id - 1) % UNIT_COLORS.length];
      chip.style.borderColor = color;
      chip.style.color = color;
      chip.textContent = `U${u.unit_id}`;
      chip.dataset.unit = u.unit_id;
      unitChips.appendChild(chip);
    });

    // Chip click handler
    unitChips.querySelectorAll('.unit-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        unitChips.querySelectorAll('.unit-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        unitSelect.value = chip.dataset.unit;
        drawPatrolRoutes();
      });
    });
  }

  // coverage bars
  document.getElementById('coverage-section').classList.remove('hidden');
  document.getElementById('itinerary-section').classList.remove('hidden');

  const baseBar  = document.getElementById('cov-baseline-bar');
  const optBar   = document.getElementById('cov-optimized-bar');
  const basePct  = document.getElementById('cov-baseline-pct');
  const optPct   = document.getElementById('cov-optimized-pct');

  baseBar.style.width  = '0%';
  optBar.style.width   = '0%';

  requestAnimationFrame(() => {
    setTimeout(() => {
      baseBar.style.width  = data.baseline_fixed_shift_pct + '%';
      basePct.textContent  = data.baseline_fixed_shift_pct + '%';
      optBar.style.width   = data.total_coverage_pct + '%';
      optPct.textContent   = data.total_coverage_pct + '%';
    }, 50);
  });

  const delta = (data.total_coverage_pct - data.baseline_fixed_shift_pct).toFixed(1);
  document.getElementById('coverage-tagline').innerHTML =
    `Same officers. Same shift. <strong>+${delta}pp</strong> more violations addressed.<br>
     <span style="font-size:9px;color:#64748b">
       ${data.n_hotspots} hotspots selected · GA-optimized routes
       · <em>Kim et al., Heliyon 2023</em>
     </span>`;

  drawPatrolRoutes();
}

function drawPatrolRoutes() {
  if (!patrolDataGlobal) return;

  // clear patrol map route lines/dots
  patrolLayers.forEach(l => patrolMap.removeLayer(l));
  patrolLayers = [];

  // Show sim bar and reset to shift start
  const simBar = document.getElementById('patrol-sim-bar');
  if (simBar) simBar.classList.remove('hidden');
  patrolSimStop();
  document.getElementById('patrol-sim-time').textContent =
    String(state.shiftStart).padStart(2,'0') + ':00';

  const selectedUnitVal = document.getElementById('patrol-unit-select')?.value || 'all';

  // draw routes
  patrolDataGlobal.units.forEach(unit => {
    if (selectedUnitVal !== 'all' && String(unit.unit_id) !== selectedUnitVal) return;

    const color    = UNIT_COLORS[(unit.unit_id - 1) % UNIT_COLORS.length];
    const coords   = unit.route.map(stop => {
      const jd = junctionData.find(j => j.name === stop.junction);
      return jd ? [jd.lat, jd.lon] : null;
    }).filter(Boolean);

    if (coords.length >= 2) {
      const poly = L.polyline(coords, { color, weight: 3, opacity: 0.8 }).addTo(patrolMap);
      patrolLayers.push(poly);
    }

    // numbered markers
    coords.forEach((coord, idx) => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          background:${color};color:#fff;font-size:10px;font-weight:700;
          width:22px;height:22px;border-radius:50%;display:flex;
          align-items:center;justify-content:center;
          border:2px solid #1e293b;box-shadow:0 1px 4px rgba(0,0,0,.4)">
          ${idx + 1}
        </div>`,
        iconSize:   [22, 22],
        iconAnchor: [11, 11],
      });
      const m = L.marker(coord, { icon }).addTo(patrolMap);
      patrolLayers.push(m);
    });
  });

  // itinerary table
  const tbody = document.getElementById('itinerary-body');
  tbody.innerHTML = '';
  patrolDataGlobal.units.forEach(unit => {
    if (selectedUnitVal !== 'all' && String(unit.unit_id) !== selectedUnitVal) return;

    const color = UNIT_COLORS[(unit.unit_id - 1) % UNIT_COLORS.length];
    unit.route.forEach(stop => {
      const truncName = stop.junction.length > 25
        ? stop.junction.slice(0, 25) + '…'
        : stop.junction;

      const losClass = `los-${stop.los_grade}`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="color:${color};font-weight:700">U${unit.unit_id}</span></td>
        <td title="${stop.junction}">${truncName}</td>
        <td>${stop.arrive}</td>
        <td>${stop.depart}</td>
        <td>${stop.revisit_at}</td>
        <td>${stop.predicted_violations}</td>
        <td><span class="los-badge ${losClass}" style="font-size:11px;width:28px;height:28px;line-height:28px">${stop.los_grade}</span></td>`;
      tbody.appendChild(tr);
    });
  });

  // Update animated car icons (pass minutes from midnight = shift start * 60)
  updatePatrolTrackingMarkers((state.shiftStart) * 60);
}

// Helper: convert "HH:MM" string → total minutes from midnight
function hhmmToMin(s) {
  if (!s || s === '—') return Infinity;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
// Helper: total minutes → "HH:MM" display string
function minToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
}

function updatePatrolTrackingMarkers(currentMin) {
  // Clear existing car markers
  patrolMarkers.forEach(m => {
    try { patrolMap.removeLayer(m); } catch(e) {}
    try { if (mainMap) mainMap.removeLayer(m); } catch(e) {}
  });
  patrolMarkers = [];

  if (!patrolDataGlobal) return;

  const selectedUnitVal = document.getElementById('patrol-unit-select')?.value || 'all';
  const shiftStartMin   = state.shiftStart * 60;
  const shiftEndMin     = (state.shiftStart + state.shiftDuration) * 60;

  // Inject pulse-glow animation once
  if (!document.getElementById('pulse-glow-style')) {
    const style = document.createElement('style');
    style.id = 'pulse-glow-style';
    style.innerHTML = `
      @keyframes pulse-glow {
        0%   { box-shadow: 0 0 0 0px rgba(255,255,255,0.7); }
        70%  { box-shadow: 0 0 0 8px rgba(255,255,255,0); }
        100% { box-shadow: 0 0 0 0px rgba(255,255,255,0); }
      }
    `;
    document.head.appendChild(style);
  }

  patrolDataGlobal.units.forEach(unit => {
    if (selectedUnitVal !== 'all' && String(unit.unit_id) !== selectedUnitVal) return;
    if (currentMin < shiftStartMin || currentMin >= shiftEndMin) return;

    const color = UNIT_COLORS[(unit.unit_id - 1) % UNIT_COLORS.length];
    let lat, lon, label, returning = false;

    // Resolve base station coordinates for return journey
    const stationName = unit.starting_station || state.patrolStation || 'Upparpet';
    const stationJ = junctionData.find(j =>
      j.name === stationName ||
      j.name.toLowerCase().includes(stationName.toLowerCase()) ||
      stationName.toLowerCase().includes(j.name.toLowerCase())
    );

    for (let i = 0; i < unit.route.length; i++) {
      const stop    = unit.route[i];
      const arrMin  = hhmmToMin(stop.arrive);
      const depMin  = hhmmToMin(stop.depart);

      // Unit is physically present at this junction
      if (currentMin >= arrMin && currentMin < depMin) {
        const j = junctionData.find(j => j.name === stop.junction);
        if (j) {
          lat   = j.lat;
          lon   = j.lon;
          label = `<b>Unit ${unit.unit_id}</b><br>📍 ${stop.junction.replace(/^BTP\d+\s*-\s*/,'')}`;
        }
        break;
      }

      // Unit is in transit to next stop — linear interpolation
      if (i < unit.route.length - 1) {
        const next       = unit.route[i + 1];
        const nextArrMin = hhmmToMin(next.arrive);
        if (currentMin >= depMin && currentMin < nextArrMin) {
          const j1 = junctionData.find(j => j.name === stop.junction);
          const j2 = junctionData.find(j => j.name === next.junction);
          if (j1 && j2) {
            const t = (currentMin - depMin) / Math.max(nextArrMin - depMin, 1);
            lat   = j1.lat + (j2.lat - j1.lat) * t;
            lon   = j1.lon + (j2.lon - j1.lon) * t;
            label = `<b>Unit ${unit.unit_id}</b><br>🚗 → ${next.junction.replace(/^BTP\d+\s*-\s*/,'')}`;
          }
          break;
        }
      }

      // ── Return journey: after last stop's depart time ────────────────────
      if (i === unit.route.length - 1) {
        const lastDepMin = hhmmToMin(stop.depart);
        if (currentMin >= lastDepMin && stationJ) {
          const j1 = junctionData.find(j => j.name === stop.junction);
          if (j1) {
            const returnDuration = Math.max(shiftEndMin - lastDepMin, 1);
            const t = Math.min((currentMin - lastDepMin) / returnDuration, 1);
            lat   = j1.lat + (stationJ.lat - j1.lat) * t;
            lon   = j1.lon + (stationJ.lon - j1.lon) * t;
            label = `<b>Unit ${unit.unit_id}</b><br>🏠 Returning to base<br><small style="opacity:0.8">${stationName}</small>`;
            returning = true;
          }
        }
      }
    }

    if (lat === undefined) return;

    const carIcon = L.divIcon({
      className: '',
      html: `<div style="
        background:${returning ? '#6b7280' : color};color:#fff;
        width:26px;height:26px;border-radius:7px;display:flex;
        align-items:center;justify-content:center;
        border:2px solid #fff;animation:pulse-glow 1.5s infinite;
        font-size:14px;cursor:pointer;
        ${returning ? 'opacity:0.8;' : ''}">${returning ? '🏠' : '🚔'}</div>`,
      iconSize:   [26, 26],
      iconAnchor: [13, 13],
    });

    const mPatrol = L.marker([lat, lon], { icon: carIcon })
      .bindTooltip(label, { direction: 'top' })
      .addTo(patrolMap);
    patrolMarkers.push(mPatrol);
  });
}

// ── Interventions tab ─────────────────────────────────────
let interventionsData = [];

async function loadInterventions() {
  if (interventionsData.length > 0) return;  // already loaded

  const data = await fetch(`${BASE}/api/interventions`).then(r => r.json());
  const counts  = data.summary_counts;
  const juncs   = data.junctions;
  interventionsData = juncs;

  document.getElementById('int-restructure-count').textContent = counts['RESTRUCTURE'] || 0;
  document.getElementById('int-enforce-count').textContent     = counts['ENFORCE']     || 0;
  document.getElementById('int-process-count').textContent     = counts['PROCESS FIX'] || 0;

  // city impact banner — sum violations for RESTRUCTURE
  const restructureTotal = juncs
    .filter(j => j.intervention_type === 'RESTRUCTURE')
    .reduce((s, j) => s + j.total_violations, 0);
  document.getElementById('city-impact-banner').textContent =
    `Top RESTRUCTURE junctions account for ${fmt(restructureTotal)} violations. ` +
    `Infrastructure intervention requires zero new officers.`;

  renderInterventionGrid(juncs, 'all');
}

function renderInterventionGrid(juncs, filter) {
  const grid = document.getElementById('intervention-grid');
  grid.innerHTML = '';

  juncs.forEach(j => {
    if (filter !== 'all' && j.intervention_type !== filter) return;

    const card = document.createElement('div');
    const cardClass = j.intervention_type.replace(' ', '-');
    card.className = `int-card ${cardClass}`;

    // badge classes
    const itypeClass = j.intervention_type === 'RESTRUCTURE' ? 'ib-restructure'
      : j.intervention_type === 'ENFORCE' ? 'ib-enforce' : 'ib-process';

    // donut for two-wheeler %
    const circumference = 2 * Math.PI * 14;
    const twDash  = ((j.tw_pct / 100) * circumference).toFixed(2);
    const remDash = (circumference - twDash).toFixed(2);

    card.innerHTML = `
      <div class="int-card-header">
        <span class="int-card-name">${j.name}</span>
        <span class="int-card-viol">${fmt(j.total_violations)}</span>
      </div>
      <div class="int-card-badges">
        <span class="int-card-badge ${itypeClass}">${j.intervention_type}</span>
        <span class="int-card-badge ib-los">LOS ${j.los_grade}</span>
      </div>
      <div class="int-mini-trend"></div>
      <div class="int-donut-row">
        <svg class="int-donut" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="14" fill="none" stroke="#334155" stroke-width="4"/>
          <circle cx="16" cy="16" r="14" fill="none" stroke="#f97316" stroke-width="4"
            stroke-dasharray="${twDash} ${remDash}"
            stroke-dashoffset="${(circumference * 0.25).toFixed(2)}"
            transform="rotate(-90 16 16)"/>
        </svg>
        <span class="int-donut-label">${j.tw_pct}% two-wheelers<br><span style="color:#64748b">Dominant: ${j.dominant_vehicle}</span></span>
      </div>
      <div class="int-card-rec">${j.recommendation}</div>
      <div class="int-card-footer">
        <div class="int-card-precedent">Precedent: ${j.precedent}</div>
        <div class="int-card-impact">${j.estimated_impact}</div>
      </div>`;

    // render sparkline into the mini-trend div
    const trendEl = card.querySelector('.int-mini-trend');
    renderMiniSparkline(trendEl, j.monthly_trend || []);

    grid.appendChild(card);
  });
}

// ── Nav tabs ──────────────────────────────────────────────
function setupNavTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.add('hidden');
        el.classList.remove('active');
      });
      const target = document.getElementById(`tab-${tab}`);
      if (target) {
        target.classList.remove('hidden');
        target.classList.add('active');
      }

      // lazy-load per-tab data / maps
      setTimeout(async () => {
        if (tab === 'dashboard')     loadDashboard();
        if (tab === 'map') {
          if (!mainMap) {
            initMainMap();
            mainMap.invalidateSize();
            await loadJunctions();
            await updateHeatmap();
          } else {
            mainMap.invalidateSize();
          }
        }
        if (tab === 'predict')       { initPredictMap(); loadPredictions(); }
        if (tab === 'patrol')        initPatrolMap();
        if (tab === 'interventions') loadInterventions();
      }, 50);
    });
  });
}

// ── Filter event listeners ────────────────────────────────
function setupFilters() {

  // hour slider
  const hourSlider = document.getElementById('hour-slider');
  const hourLabel  = document.getElementById('hour-label');
  hourSlider.addEventListener('input', () => {
    const v = parseInt(hourSlider.value, 10);
    state.hour       = v;
    hourLabel.textContent = v === -1 ? 'All Hours' : v + ':00';
    debouncedHeatmap();
  });

  // dow buttons (map tab only — not .pred-dow)
  document.querySelectorAll('.dow-btn:not(.pred-dow)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dow-btn:not(.pred-dow)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.dow = parseInt(btn.dataset.dow, 10);
      updateHeatmap();
    });
  });

  // month select
  document.getElementById('month-select').addEventListener('change', function () {
    state.month = parseInt(this.value, 10);
    updateHeatmap();
  });

  // vehicle select
  document.getElementById('vehicle-select').addEventListener('change', function () {
    state.vehicleType = this.value;
    updateHeatmap();
  });

  // violation select
  document.getElementById('violation-select').addEventListener('change', function () {
    state.violationType = this.value;
    updateHeatmap();
  });

  // reset filters
  document.getElementById('reset-filters').addEventListener('click', () => {
    state.hour          = -1;
    state.dow           = -1;
    state.month         = -1;
    state.vehicleType   = 'all';
    state.violationType = 'all';

    document.getElementById('hour-slider').value = -1;
    hourLabel.textContent = 'All Hours';

    document.querySelectorAll('.dow-btn:not(.pred-dow)').forEach(b => {
      b.classList.toggle('active', b.dataset.dow === '-1');
    });

    document.getElementById('month-select').value     = '-1';
    document.getElementById('vehicle-select').value   = 'all';
    document.getElementById('violation-select').value = 'all';

    updateHeatmap();
  });

  // junction panel close
  document.getElementById('jp-close').addEventListener('click', () => {
    document.getElementById('junction-panel').classList.add('hidden');
  });

  // predict hour slider
  const predHourSlider = document.getElementById('pred-hour');
  const predHourLabel  = document.getElementById('pred-hour-label');
  predHourSlider.addEventListener('input', () => {
    const v = parseInt(predHourSlider.value, 10);
    state.predHour        = v;
    predHourLabel.textContent = v + ':00';
    loadPredictions();
  });

  // predict dow buttons
  document.querySelectorAll('.pred-dow').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pred-dow').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.predDow = parseInt(btn.dataset.dow, 10);
      loadPredictions();
    });
  });

  // patrol units slider
  const unitsSlider = document.getElementById('units-slider');
  const unitsLabel  = document.getElementById('units-label');
  unitsSlider.addEventListener('input', () => {
    state.patrolUnits    = parseInt(unitsSlider.value, 10);
    unitsLabel.textContent = state.patrolUnits;
  });

  // shift start
  document.getElementById('shift-start').addEventListener('change', function () {
    state.shiftStart = parseInt(this.value, 10);
  });

  // duration buttons
  document.querySelectorAll('.dur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.shiftDuration = parseInt(btn.dataset.dur, 10);
    });
  });

  // station select
  document.getElementById('station-select').addEventListener('change', function () {
    state.patrolStation = this.value;
  });

  // coverage threshold buttons (Kim et al. 2023 parameter p)
  document.querySelectorAll('.cov-thresh-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cov-thresh-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.coverageThreshold = parseFloat(btn.dataset.p);
    });
  });

  // generate routes
  document.getElementById('generate-routes').addEventListener('click', generateRoutes);

  // patrol unit filter dropdown
  document.getElementById('patrol-unit-select').addEventListener('change', () => {
    if (patrolDataGlobal) drawPatrolRoutes();
  });

  // intervention filter buttons
  document.querySelectorAll('.int-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.int-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderInterventionGrid(interventionsData, btn.dataset.filter);
    });
  });
}

// ── Time-lapse Simulation ─────────────────────────────────
const sim = {
  running:   false,
  paused:    false,
  hour:      0,
  dow:       0,
  speed:     1,
  timer:     null,
  INTERVAL:  1200,   // ms per hour at 1× speed
};

const DOW_SHORT = ['MON','TUE','WED','THU','FRI','SAT','SUN'];

function simUpdateClock() {
  const h = String(sim.hour).padStart(2, '0');
  document.getElementById('sim-time').textContent =
    `${DOW_SHORT[sim.dow]} ${h}:00`;
}

function simUpdateStatus(status) {
  const el = document.getElementById('sim-status');
  el.textContent  = status.toUpperCase();
  el.className    = `sim-status-${status}`;
}

function simUpdateHotspot() {
  // find top predicted junction for current sim hour/dow
  let best = null;
  let bestScore = 0;
  for (const [jname] of Object.entries(PREDICTIONS_JS)) {
    const score = PREDICTIONS_JS[jname]?.[String(sim.hour)]?.[String(sim.dow)] || 0;
    if (score > bestScore) { bestScore = score; best = jname; }
  }
  const nameEl  = document.getElementById('sim-hotspot-name');
  const countEl = document.getElementById('sim-hotspot-count');
  if (best) {
    // strip BTP### prefix for cleaner display
    const shortName = best.replace(/^BTP\d+\s*-\s*/, '');
    nameEl.textContent  = shortName;
    countEl.textContent = Math.round(bestScore) + ' predicted violations';
  } else {
    nameEl.textContent  = '—';
    countEl.textContent = '—';
  }
}

async function simTick() {
  // sync filters to sim state
  state.hour = sim.hour;
  state.dow  = sim.dow;

  // update hour slider UI
  const slider = document.getElementById('hour-slider');
  slider.value = sim.hour;
  document.getElementById('hour-label').textContent = sim.hour + ':00';

  // update dow buttons
  document.querySelectorAll('.dow-btn:not(.pred-dow)').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.dow) === sim.dow);
  });

  simUpdateClock();
  simUpdateHotspot();
  await updateHeatmap();

  // Update patrol car positions if routes generated (convert sim hour to minutes)
  if (patrolDataGlobal) {
    updatePatrolTrackingMarkers(sim.hour * 60);
  }

  // advance hour
  sim.hour = (sim.hour + 1) % 24;
}

function simPlay() {
  if (sim.running && !sim.paused) return;

  // read dow from select
  sim.dow  = parseInt(document.getElementById('sim-dow-select').value, 10);
  sim.running = true;
  sim.paused  = false;

  document.getElementById('sim-play').classList.add('hidden');
  document.getElementById('sim-pause').classList.remove('hidden');
  simUpdateStatus('playing');

  const interval = Math.round(sim.INTERVAL / sim.speed);
  sim.timer = setInterval(async () => {
    if (!sim.paused) await simTick();
  }, interval);
}

function simPause() {
  sim.paused = !sim.paused;
  const pauseBtn = document.getElementById('sim-pause');
  if (sim.paused) {
    pauseBtn.textContent = '▶ Resume';
    simUpdateStatus('paused');
  } else {
    pauseBtn.textContent = '⏸ Pause';
    simUpdateStatus('playing');
  }
}

function simStop() {
  clearInterval(sim.timer);
  sim.running = false;
  sim.paused  = false;
  sim.hour    = 0;

  document.getElementById('sim-play').classList.remove('hidden');
  document.getElementById('sim-pause').classList.add('hidden');
  document.getElementById('sim-pause').textContent = '⏸ Pause';
  document.getElementById('sim-time').textContent  = `${DOW_SHORT[sim.dow]} 00:00`;
  document.getElementById('sim-hotspot-name').textContent  = '—';
  document.getElementById('sim-hotspot-count').textContent = '—';
  simUpdateStatus('idle');

  // reset filters to all
  state.hour = -1;
  state.dow  = -1;
  document.getElementById('hour-slider').value = -1;
  document.getElementById('hour-label').textContent = 'All Hours';
  document.querySelectorAll('.dow-btn:not(.pred-dow)').forEach(b => {
    b.classList.toggle('active', b.dataset.dow === '-1');
  });
  updateHeatmap();
}

function setupSimulation() {
  document.getElementById('sim-play').addEventListener('click', simPlay);
  document.getElementById('sim-pause').addEventListener('click', simPause);
  document.getElementById('sim-stop').addEventListener('click', simStop);

  // speed buttons
  document.querySelectorAll('.sim-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sim-speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sim.speed = parseInt(btn.dataset.speed, 10);

      // restart timer with new speed if already running
      if (sim.running && !sim.paused) {
        clearInterval(sim.timer);
        const interval = Math.round(sim.INTERVAL / sim.speed);
        sim.timer = setInterval(async () => {
          if (!sim.paused) await simTick();
        }, interval);
      }
    });
  });
}

// ── Patrol Simulation (self-contained, minute-by-minute) ─────────────
const patrolSim = {
  running:  false,
  paused:   false,
  minute:   540,    // minutes from midnight; default 09:00
  speed:    1,
  timer:    null,
  INTERVAL: 200,    // ms per simulated minute at 1× (8h shift = ~96s real time)
};

function patrolSimTick() {
  const shiftStartMin = state.shiftStart * 60;
  const shiftEndMin   = (state.shiftStart + state.shiftDuration) * 60;

  document.getElementById('patrol-sim-time').textContent = minToHHMM(patrolSim.minute);
  updatePatrolTrackingMarkers(patrolSim.minute);

  patrolSim.minute++;
  if (patrolSim.minute >= shiftEndMin) patrolSim.minute = shiftStartMin; // loop
}

function patrolSimPlay() {
  if (patrolSim.running && !patrolSim.paused) return;
  if (!patrolSim.paused) patrolSim.minute = state.shiftStart * 60;
  patrolSim.running = true;
  patrolSim.paused  = false;

  document.getElementById('patrol-sim-play').classList.add('hidden');
  document.getElementById('patrol-sim-pause').classList.remove('hidden');
  const statusEl = document.getElementById('patrol-sim-status');
  statusEl.textContent = 'PLAYING';
  statusEl.className   = 'sim-status-playing';

  const interval = Math.round(patrolSim.INTERVAL / patrolSim.speed);
  patrolSim.timer = setInterval(() => {
    if (!patrolSim.paused) patrolSimTick();
  }, interval);
}

function patrolSimPause() {
  patrolSim.paused = !patrolSim.paused;
  const btn = document.getElementById('patrol-sim-pause');
  const statusEl = document.getElementById('patrol-sim-status');
  if (patrolSim.paused) {
    btn.textContent      = '▶ Resume';
    statusEl.textContent = 'PAUSED';
    statusEl.className   = 'sim-status-paused';
  } else {
    btn.textContent      = '⏸ Pause';
    statusEl.textContent = 'PLAYING';
    statusEl.className   = 'sim-status-playing';
  }
}

function patrolSimStop() {
  clearInterval(patrolSim.timer);
  patrolSim.running = false;
  patrolSim.paused  = false;
  patrolSim.minute  = state.shiftStart * 60;

  document.getElementById('patrol-sim-play').classList.remove('hidden');
  document.getElementById('patrol-sim-pause').classList.add('hidden');
  document.getElementById('patrol-sim-pause').textContent = '⏸ Pause';
  document.getElementById('patrol-sim-time').textContent  = minToHHMM(state.shiftStart * 60);
  const statusEl = document.getElementById('patrol-sim-status');
  statusEl.textContent = 'IDLE';
  statusEl.className   = 'sim-status-idle';

  updatePatrolTrackingMarkers(state.shiftStart * 60);
}

function setupPatrolSimulation() {
  document.getElementById('patrol-sim-play').addEventListener('click', patrolSimPlay);
  document.getElementById('patrol-sim-pause').addEventListener('click', patrolSimPause);
  document.getElementById('patrol-sim-stop').addEventListener('click', patrolSimStop);

  document.querySelectorAll('.patrol-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.patrol-speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      patrolSim.speed = parseInt(btn.dataset.speed, 10);
      if (patrolSim.running && !patrolSim.paused) {
        clearInterval(patrolSim.timer);
        const interval = Math.round(patrolSim.INTERVAL / patrolSim.speed);
        patrolSim.timer = setInterval(() => {
          if (!patrolSim.paused) patrolSimTick();
        }, interval);
      }
    });
  });
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupNavTabs();
  setupFilters();
  setupSimulation();
  setupPatrolSimulation();
  setupUIInteractions();
  setupLayerController();
  // NOTE: initMainMap() is now lazy — called on first MAP tab click
  //       so the hidden map container doesn't crash Leaflet on startup.

  await Promise.all([
    loadKPIs(),
    loadFilterOptions(),
    fetch(`${BASE}/api/predictions-all`).then(r => r.ok ? r.json() : {}).then(d => { PREDICTIONS_JS = d; }).catch(() => {}),
    loadDashboard(),
  ]);

  // Map is lazy-initialized on first MAP tab click — nothing to do here
  // Auto-dismiss welcome banner after 12 seconds (banner is in map tab)
  setTimeout(() => {
    const banner = document.getElementById('map-welcome-banner');
    if (banner) {
      document.getElementById('banner-dismiss')?.addEventListener('click', () => {
        banner.classList.add('dismissed');
      });
      setTimeout(() => banner.classList.add('dismissed'), 12000);
    }
  }, 500);
});


// ── Guided Tour (Advanced) ─────────────────────────────────────────
// SVG gradient for countdown ring — injected once into DOM
(function injectRingGrad() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('style', 'position:absolute;width:0;height:0');
  svg.innerHTML = `<defs>
    <linearGradient id="tourRingGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>`;
  document.body.appendChild(svg);
})();

// ── Tour Step Definitions ─────────────────────────────────────────
const TOUR_STEPS = [
  {
    tab:   'map',
    icon:  '🗺',
    title: 'Live Violation Heatmap',
    desc:  '248,691 real Bengaluru e-challan records (Nov 2023 – Apr 2024) plotted across the city. ' +
           'Each pulse on the map is an illegal parking event. Drag the time slider to watch hotspots ' +
           'migrate as the day progresses — commercial zones peak at 9am, markets peak at 5pm.',
    metrics: [
      { icon: '📍', label: 'Total Records', val: '2,48,691', cls: 'pill-blue' },
      { icon: '📅', label: 'Period',        val: '6 Months',  cls: 'pill-purple' },
      { icon: '🏙',  label: 'City',          val: 'Bengaluru', cls: 'pill-green' },
    ],
    action: async () => {
      state.hour = 9;
      document.getElementById('hour-slider').value = 9;
      document.getElementById('hour-label').textContent = '9:00';
      document.querySelectorAll('.dow-btn:not(.pred-dow)').forEach(b =>
        b.classList.toggle('active', b.dataset.dow === '-1'));
      await updateHeatmap();
    },
  },
  {
    tab:   'map',
    icon:  '📊',
    title: 'HDBSCAN Cluster Detection',
    desc:  '1,022 data-derived hotspot clusters discovered by HDBSCAN on raw GPS coordinates — ' +
           'not limited to 168 pre-labeled police junctions. This finds violations in parking lots, ' +
           'side streets, and underpasses that have no junction name. Red dots = LOS F critical zones.',
    metrics: [
      { icon: '🔴', label: 'LOS F Clusters', val: '~820',   cls: 'pill-red' },
      { icon: '🟠', label: 'LOS E Zones',    val: '~120',   cls: 'pill-orange' },
      { icon: '🧬', label: 'Algorithm',       val: 'HDBSCAN', cls: 'pill-purple' },
    ],
    action: async () => {
      // zoom out to show all clusters
      mainMap.flyTo(BENGALURU, 12, { animate: true, duration: 0.6 });
    },
  },
  {
    tab:   'map',
    icon:  '🚦',
    title: 'Junction Intelligence — Road Impact',
    desc:  'Click any red dot to open the full impact report. The dashboard shows Level of Service ' +
           '(LOS A–F), effective lanes remaining, vehicles/hour blocked, and CO₂ emissions. ' +
           'All computed using the Karachi 2024 capacity reduction methodology on peer-reviewed data.',
    metrics: [
      { icon: '🛣',  label: 'Peak LOS',           val: 'Grade F',   cls: 'pill-red' },
      { icon: '🚗', label: 'Max Throughput Loss', val: '1,800/hr', cls: 'pill-orange' },
      { icon: '💨', label: 'CO₂ Peak Rate',       val: '~12 kg/hr', cls: 'pill-blue' },
      { icon: '📏', label: 'Methodology',          val: 'Karachi 2024', cls: 'pill-green' },
    ],
    action: async () => {
      const top = [...junctionData].sort((a,b) => b.total_violations - a.total_violations)[0];
      if (top) await openJunctionPanel(top.name);
      // scroll the junction panel to show road impact
      const panel = document.getElementById('junction-panel');
      if (panel) panel.scrollTop = 0;
    },
  },
  {
    tab:   'map',
    icon:  '⚠️',
    title: 'Enforcement Gap & Deterrence Decay',
    desc:  'Every junction shows two critical enforcement metrics: the % of violations with zero ' +
           'follow-through (enforcement gap), and how fast violations rebuild after a patrol visit ' +
           '(deterrence decay window, Montreal MVTOP 2024). These drive the patrol revisit schedule.',
    metrics: [
      { icon: '🔓', label: 'City-wide Gap',  val: '~40%',       cls: 'pill-red' },
      { icon: '⏱',  label: 'Avg Decay',      val: '~45 min',    cls: 'pill-orange' },
      { icon: '📖', label: 'Model Source',    val: 'Montreal 24', cls: 'pill-purple' },
    ],
    action: async () => {
      const top = [...junctionData].sort((a,b) => b.total_violations - a.total_violations)[0];
      if (top) await openJunctionPanel(top.name);
      // scroll panel down to show enforcement gap section
      const panel = document.getElementById('junction-panel');
      const gapEl = document.getElementById('jp-null-rate');
      if (panel && gapEl) {
        setTimeout(() => panel.scrollTo({ top: gapEl.offsetTop - 40, behavior: 'smooth' }), 350);
      }
    },
  },
  {
    tab:   'predict',
    icon:  '🔮',
    title: 'LightGBM AI — Tomorrow\'s Hotspots',
    desc:  'A 5-fold cross-validated LightGBM ensemble predicts which clusters will peak at any ' +
           'given hour/day. Trained on 12 features including temporal patterns, junction identity, ' +
           'and leave-one-out target encoding. Set to Monday 9am — the city\'s highest-risk window.',
    metrics: [
      { icon: '🤖', label: 'Model',      val: 'LightGBM × 5',  cls: 'pill-blue' },
      { icon: '📈', label: 'R² Score',   val: '0.731',          cls: 'pill-green' },
      { icon: '📉', label: 'MAE',        val: '0.986 viol/hr',  cls: 'pill-orange' },
      { icon: '🔑', label: 'Features',   val: '12',             cls: 'pill-purple' },
    ],
    action: async () => {
      state.predHour = 9;
      state.predDow  = 0;
      document.getElementById('pred-hour').value = 9;
      document.getElementById('pred-hour-label').textContent = '9:00';
      document.querySelectorAll('.pred-dow').forEach(b =>
        b.classList.toggle('active', b.dataset.dow === '0'));
      await loadPredictions();
    },
  },
  {
    tab:   'patrol',
    icon:  '🚔',
    title: 'GA Patrol Optimizer — Route Planning',
    desc:  'A Genetic Algorithm (Kim et al., Heliyon 2023) generates optimized patrol routes, ' +
           'scheduling officers to return to each junction exactly before violations rebuild ' +
           '(based on the deterrence decay window). Coverage jumps from ~31% fixed-shift to ~68% optimized.',
    metrics: [
      { icon: '📊', label: 'Baseline Coverage', val: '~31%',      cls: 'pill-red' },
      { icon: '✅', label: 'Optimized Coverage', val: '~68%',      cls: 'pill-green' },
      { icon: '🧬', label: 'Algorithm',          val: 'Genetic (GA)', cls: 'pill-purple' },
      { icon: '📖', label: 'Reference',          val: 'Kim 2023',   cls: 'pill-blue' },
    ],
    action: async () => {
      state.patrolUnits    = 4;
      state.shiftStart     = 9;
      state.shiftDuration  = 8;
      state.patrolStation  = 'Upparpet';
      document.getElementById('units-slider').value = 4;
      document.getElementById('units-label').textContent = '4';
      await generateRoutes();
    },
  },
  {
    tab:   'interventions',
    icon:  '🏗',
    title: 'Intervention Recommender',
    desc:  'Every cluster is automatically classified into one of three actions:\n' +
           '• RESTRUCTURE: Build infrastructure (dedicated parking zones) for two-wheeler-heavy, chronic zones.\n' +
           '• ENFORCE: Deploy patrols at precise intervals for high-LOS hotspots.\n' +
           '• PROCESS FIX: Fix the digital evidence chain where 60%+ violations go unactioned.',
    metrics: [
      { icon: '🔧', label: 'RESTRUCTURE', val: 'Infrastructure', cls: 'pill-orange' },
      { icon: '🚓', label: 'ENFORCE',     val: 'Patrol Deploy',   cls: 'pill-blue' },
      { icon: '🔄', label: 'PROCESS FIX', val: 'Evidence Chain',  cls: 'pill-red' },
    ],
    action: async () => {
      await loadInterventions();
    },
  },
];

let tourIndex    = 0;
let tourTimer    = null;
let tourCountdown = null;
let tourActive   = false;
const TOUR_DURATION = 8; // seconds per step

function switchToTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.add('hidden');
    el.classList.remove('active');
  });
  const btn = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('active');
  const tab = document.getElementById(`tab-${tabName}`);
  if (tab) { tab.classList.remove('hidden'); tab.classList.add('active'); }

  setTimeout(() => {
    if (tabName === 'dashboard' && window.dashMiniMap) {
      window.dashMiniMap.invalidateSize(true);
      window.dispatchEvent(new Event('resize'));
    }
    if (tabName === 'map' && window.mainMap) {
      window.mainMap.invalidateSize(true);
    }
    if (tabName === 'predict')       { initPredictMap(); }
    if (tabName === 'patrol')        initPatrolMap();
    if (tabName === 'interventions') {}
  }, 250);
}


// ── Countdown ring animation ─────────────────────────────────────
function startCountdownRing(onDone) {
  clearInterval(tourCountdown);
  const ringFill = document.getElementById('tour-ring-fill');
  const ringText = document.getElementById('tour-ring-text');
  if (!ringFill || !ringText) return;

  let remaining = TOUR_DURATION;
  const circumference = 100; // matches stroke-dasharray="100 100"

  function updateRing() {
    const frac    = remaining / TOUR_DURATION;
    const dashOff = circumference - (circumference * frac);
    ringFill.style.strokeDashoffset = dashOff.toFixed(2);
    ringText.textContent            = remaining;
  }
  updateRing();

  tourCountdown = setInterval(() => {
    remaining--;
    updateRing();
    if (remaining <= 0) {
      clearInterval(tourCountdown);
      onDone();
    }
  }, 1000);
}

// ── Render step dots ─────────────────────────────────────────────
function renderTourDots() {
  const container = document.getElementById('tour-dots');
  if (!container) return;
  container.innerHTML = '';
  TOUR_STEPS.forEach((_, i) => {
    const dot = document.createElement('div');
    dot.className = 'tour-dot';
    if (i < tourIndex)   dot.classList.add('done');
    if (i === tourIndex) dot.classList.add('active');
    dot.addEventListener('click', () => {
      if (!tourActive) return;
      tourIndex = i;
      runTourStep(i);
    });
    container.appendChild(dot);
  });
}

// ── Run a single tour step ───────────────────────────────────────
async function runTourStep(index) {
  if (index < 0 || index >= TOUR_STEPS.length) { stopTour(); return; }
  clearInterval(tourCountdown);
  clearTimeout(tourTimer);

  const step    = TOUR_STEPS[index];
  const total   = TOUR_STEPS.length;
  const pct     = ((index + 1) / total * 100).toFixed(0) + '%';
  const isLast  = index === total - 1;

  // Update text content
  document.getElementById('tour-step-label').textContent = `STEP ${index + 1} / ${total}`;
  document.getElementById('tour-step-icon').textContent  = step.icon;
  document.getElementById('tour-title').textContent      = step.title;
  document.getElementById('tour-desc').textContent       = step.desc;
  document.getElementById('tour-progress-fill').style.width = pct;

  // Prev / Next button state
  const prevBtn = document.getElementById('tour-prev');
  const nextBtn = document.getElementById('tour-next');
  if (prevBtn) prevBtn.disabled = (index === 0);
  if (nextBtn) {
    nextBtn.textContent = isLast ? '🎉 Finish' : 'Next →';
    nextBtn.className   = isLast ? 'finish' : '';
  }

  // Metric pills
  const metricsEl = document.getElementById('tour-metrics');
  metricsEl.innerHTML = '';
  (step.metrics || []).forEach((m, mi) => {
    const pill = document.createElement('div');
    pill.className = 'tour-metric';
    pill.style.animationDelay = (mi * 0.07) + 's';
    pill.innerHTML =
      `<span class="pill-icon">${m.icon}</span>` +
      `<span><span class="pill-val ${m.cls}">${m.val}</span>` +
      `<span class="pill-label">${m.label}</span></span>`;
    metricsEl.appendChild(pill);
  });

  // Step dots
  renderTourDots();

  // Show overlay
  document.getElementById('tour-overlay').classList.remove('hidden');

  // Switch tab
  switchToTab(step.tab);

  // Run action after tab transition
  await new Promise(r => setTimeout(r, 300));
  if (step.action) await step.action();

  // Start auto-advance countdown
  startCountdownRing(() => {
    if (tourActive) tourNext();
  });
}

// ── Navigation functions ─────────────────────────────────────────
function tourNext() {
  clearInterval(tourCountdown);
  tourIndex++;
  if (tourIndex >= TOUR_STEPS.length) { stopTour(); return; }
  runTourStep(tourIndex);
}

function tourPrev() {
  clearInterval(tourCountdown);
  if (tourIndex <= 0) return;
  tourIndex--;
  runTourStep(tourIndex);
}

function startGuidedTour() {
  if (tourActive) { stopTour(); return; }
  tourActive = true;
  tourIndex  = 0;
  document.getElementById('tour-btn').textContent = '⏹ Stop Tour';
  runTourStep(0);
}

function stopTour() {
  tourActive = false;
  clearInterval(tourCountdown);
  clearTimeout(tourTimer);
  document.getElementById('tour-overlay').classList.add('hidden');
  document.getElementById('tour-btn').textContent = '▶ Guided Tour';
}

/* =========================================================
   BILINGUAL SUPPORT — Full App Translation
   English / ಕನ್ನಡ (Kannada)
   Every visible text element in the UI is translated here.
   ========================================================= */

const I18N = {
  en: {
    // ── Nav ──
    tabMap: '🗺 MAP', tabPredict: '🔮 PREDICT',
    tabPatrol: '🚔 PATROL', tabInterventions: '🏗 INTERVENTIONS',
    langBtn: 'ಕನ್ನಡ', tourBtn: '▶ Guided Tour',
    kpiViolations: 'Violations', kpiActions: 'Actions Taken', kpiEfficiency: 'Efficiency',
    filterSectionBtn: '🔍 FILTERS',
    filterTimeLabel: 'Time of Day:', filterAllHours: 'All Hours',
    filterDayLabel: 'Day of Week',
    filterMonthLabel: 'Month', filterAllMonths: 'All Months',
    filterVehicleLabel: 'Vehicle Type', filterAllVehicles: 'All Vehicles',
    filterViolationLabel: 'Violation Type', filterAllViolations: 'All Violations',
    filterReset: '↺ Reset Filters',
    dowAll: 'All', dowMon: 'Mon', dowTue: 'Tue', dowWed: 'Wed',
    dowThu: 'Thu', dowFri: 'Fri', dowSat: 'Sat', dowSun: 'Sun',
    dowMonFull: 'Monday', dowTueFull: 'Tuesday', dowWedFull: 'Wednesday',
    dowThuFull: 'Thursday', dowFriFull: 'Friday', dowSatFull: 'Saturday', dowSunFull: 'Sunday',
    simSectionBtn: '⚡ SIMULATION',
    simSpeed: 'Speed', simDay: 'Day',
    simPlay: '▶ Play', simPause: '⏸ Pause', simStop: '■ Stop',
    simLiveHotspot: 'LIVE HOTSPOT',
    legendTitle: 'Cluster Severity',
    legendF: 'LOS F (Critical)', legendE: 'LOS E (Heavy)',
    legendCD: 'LOS C/D (Moderate)', legendAB: 'LOS A/B (Free flow)',
    mapLayers: 'MAP LAYERS',
    layerHeatmap: '🌡 Heatmap', layerHotspots: '📍 Hotspots',
    layerShowAll: 'Show all clusters',
    layerCtrlSub: 'Showing critical LOS E/F only',
    mapStyle: 'MAP STYLE', mapStandard: 'STANDARD', mapHybrid: 'HYBRID',
    bannerClick: '👆 Click any dot to see its parking impact',
    bannerPlay: '▶ Press Play in the sidebar to animate a full day',
    bannerDismiss: 'Got it ✕',
    jpStatTotal: 'Total Violations', jpStatPeak: 'Peak Hour',
    jpStatDay: 'Peak Day', jpStatVehicle: 'Top Vehicle',
    jpRoadImpact: 'Road Impact', jpNormal: 'Normal',
    jpLOS: 'Level of Service', jpLanes: 'Effective Lanes',
    jpThroughput: 'Vehicles/hr Blocked', jpCapLost: 'Road Capacity Lost',
    jpViolBreakdown: 'Violation Breakdown', jpMonthlyTrend: 'Monthly Trend',
    jpEnfGap: 'Enforcement Gap', jpNullLabel: 'of violations have no follow-through',
    jpDecayTitle: 'How Fast Violations Return',
    jpLWRTitle: 'Traffic Shockwave',
    jpQueueLbl: 'Queue km', jpShockLbl: 'Shockwave km/h', jpSpeedLbl: 'Bottleneck speed',
    predTitle: 'PREDICT VIOLATIONS', predHourLabel: 'Predict for Hour:',
    predDayLabel: 'Day of Week', predTop5: 'TOP 5 PREDICTED HOTSPOTS',
    predDetailAction: 'RECOMMENDED ACTION',
    patrolTitle: 'PATROL OPTIMIZER', patrolUnitsLabel: 'Patrol Units:',
    patrolAdvSettings: '⚙ Advanced Settings',
    patrolShiftStart: 'Shift Start', patrolShiftDur: 'Shift Duration',
    patrolStation: 'Starting Station',
    generateRoutes: '⚡ Generate Optimal Routes',
    patrolSpotlight: 'SPOTLIGHT UNIT', patrolCoverage: 'Coverage Threshold',
    covTight: 'Tight', covBalanced: 'Balanced', covWide: 'Wide',
    patrolExplain: 'Officers are routed to highest-impact junctions first, then sent back before violations rebuild — not when the shift pattern says so.',
    patrolAlgoNote: 'Route sequences optimized via Genetic Algorithm',
    covTitle: 'Coverage Comparison', covFixed: 'Fixed Shift', covOptimized: 'Optimized',
    patrolItinerary: 'PATROL ITINERARY',
    itinUnit: 'Unit', itinJunction: 'Junction', itinArrive: 'Arrive',
    itinDepart: 'Depart', itinRevisit: 'Revisit', itinPredicted: 'Predicted', itinLOS: 'LOS',
    dispatchTitle: '📧 Email Route to Officer / Station',
    dispatchPlaceholder: 'officer@btp.kar.gov.in', dispatchSend: 'Send Route',
    intRestructure: 'RESTRUCTURE', intRestructureSub: 'Build infrastructure',
    intEnforce: 'ENFORCE', intEnforceSub: 'Increase patrol',
    intProcess: 'PROCESS FIX', intProcessSub: 'Fix the pipeline',
    intFilterAll: 'All', intFilterRestructure: 'RESTRUCTURE',
    intFilterEnforce: 'ENFORCE', intFilterProcess: 'PROCESS FIX',
  },
  kn: {
    tabMap: '🗺 ನಕ್ಷೆ', tabPredict: '🔮 ಮುನ್ಸೂಚನೆ',
    tabPatrol: '🚔 ಗಸ್ತು', tabInterventions: '🏗 ಕ್ರಮಗಳು',
    langBtn: 'English', tourBtn: '▶ ಮಾರ್ಗದರ್ಶಿ',
    kpiViolations: 'ಉಲ್ಲಂಘನೆಗಳು', kpiActions: 'ತೆಗೆದ ಕ್ರಮಗಳು', kpiEfficiency: 'ದಕ್ಷತೆ',
    filterSectionBtn: '🔍 ಫಿಲ್ಟರ್‌ಗಳು',
    filterTimeLabel: 'ದಿನದ ಸಮಯ:', filterAllHours: 'ಎಲ್ಲ ಗಂಟೆ',
    filterDayLabel: 'ವಾರದ ದಿನ',
    filterMonthLabel: 'ತಿಂಗಳು', filterAllMonths: 'ಎಲ್ಲ ತಿಂಗಳು',
    filterVehicleLabel: 'ವಾಹನ ವಿಧ', filterAllVehicles: 'ಎಲ್ಲ ವಾಹನ',
    filterViolationLabel: 'ಉಲ್ಲಂಘನೆ ವಿಧ', filterAllViolations: 'ಎಲ್ಲ ಉಲ್ಲಂಘನೆ',
    filterReset: '↺ ಮರುಹೊಂದಿಸಿ',
    dowAll: 'ಎಲ್ಲ', dowMon: 'ಸೋಮ', dowTue: 'ಮಂಗಳ', dowWed: 'ಬುಧ',
    dowThu: 'ಗುರು', dowFri: 'ಶುಕ್ರ', dowSat: 'ಶನಿ', dowSun: 'ಭಾನು',
    dowMonFull: 'ಸೋಮವಾರ', dowTueFull: 'ಮಂಗಳವಾರ', dowWedFull: 'ಬುಧವಾರ',
    dowThuFull: 'ಗುರುವಾರ', dowFriFull: 'ಶುಕ್ರವಾರ', dowSatFull: 'ಶನಿವಾರ', dowSunFull: 'ಭಾನುವಾರ',
    simSectionBtn: '⚡ ಸಿಮ್ಯುಲೇಶನ್',
    simSpeed: 'ವೇಗ', simDay: 'ದಿನ',
    simPlay: '▶ ಆಟ', simPause: '⏸ ನಿಲ್ಲಿಸಿ', simStop: '■ ನಿಲ್ಲು',
    simLiveHotspot: 'ಲೈವ್ ಹಾಟ್‌ಸ್ಪಾಟ್',
    legendTitle: 'ಕ್ಲಸ್ಟರ್ ತೀವ್ರತೆ',
    legendF: 'LOS F (ಗಂಭೀರ)', legendE: 'LOS E (ಭಾರ)',
    legendCD: 'LOS C/D (ಮಧ್ಯಮ)', legendAB: 'LOS A/B (ಮುಕ್ತ ಹರಿವು)',
    mapLayers: 'ನಕ್ಷೆ ಪದರ',
    layerHeatmap: '🌡 ಶಾಖ ನಕ್ಷೆ', layerHotspots: '📍 ಹಾಟ್‌ಸ್ಪಾಟ್',
    layerShowAll: 'ಎಲ್ಲ ಕ್ಲಸ್ಟರ್ ತೋರಿಸಿ',
    layerCtrlSub: 'LOS E/F ಮಾತ್ರ ತೋರಿಸಲಾಗುತ್ತಿದೆ',
    mapStyle: 'ನಕ್ಷೆ ಶೈಲಿ', mapStandard: 'ಸಾಮಾನ್ಯ', mapHybrid: 'ಹೈಬ್ರಿಡ್',
    bannerClick: '👆 ಪಾರ್ಕಿಂಗ್ ಪ್ರಭಾವ ನೋಡಲು ಯಾವುದೇ ಚುಕ್ಕಿ ಕ್ಲಿಕ್ ಮಾಡಿ',
    bannerPlay: '▶ ಪೂರ್ಣ ದಿನ ನೋಡಲು ಪ್ಲೇ ಒತ್ತಿ',
    bannerDismiss: 'ಸರಿ ✕',
    jpStatTotal: 'ಒಟ್ಟು ಉಲ್ಲಂಘನೆ', jpStatPeak: 'ಉತ್ತುಂಗ ಗಂಟೆ',
    jpStatDay: 'ಉತ್ತುಂಗ ದಿನ', jpStatVehicle: 'ಮೇಲ್ಮಟ್ಟ ವಾಹನ',
    jpRoadImpact: 'ರಸ್ತೆ ಪ್ರಭಾವ', jpNormal: 'ಸಾಮಾನ್ಯ',
    jpLOS: 'ಸೇವಾ ಮಟ್ಟ', jpLanes: 'ಪರಿಣಾಮಕಾರಿ ಪಥ',
    jpThroughput: 'ವಾಹನ/ಗಂಟೆ ತಡೆ', jpCapLost: 'ರಸ್ತೆ ಸಾಮರ್ಥ್ಯ ನಷ್ಟ',
    jpViolBreakdown: 'ಉಲ್ಲಂಘನೆ ವಿವರ', jpMonthlyTrend: 'ಮಾಸಿಕ ಪ್ರವೃತ್ತಿ',
    jpEnfGap: 'ಜಾರಿ ಅಂತರ', jpNullLabel: 'ಉಲ್ಲಂಘನೆಗಳಿಗೆ ಮುಂದಿನ ಕ್ರಮ ಇಲ್ಲ',
    jpDecayTitle: 'ಉಲ್ಲಂಘನೆ ಎಷ್ಟು ಬೇಗ ಮರಳುತ್ತದೆ',
    jpLWRTitle: 'ಸಂಚಾರ ಆಘಾತ ತರಂಗ',
    jpQueueLbl: 'ಸಾಲು ಕಿ.ಮೀ', jpShockLbl: 'ಆಘಾತ ಕಿ.ಮೀ/ಗಂ', jpSpeedLbl: 'ಕುತ್ತಿಗೆ ವೇಗ',
    predTitle: 'ಉಲ್ಲಂಘನೆ ಮುನ್ಸೂಚನೆ', predHourLabel: 'ಗಂಟೆಗಾಗಿ ಮುನ್ಸೂಚನೆ:',
    predDayLabel: 'ವಾರದ ದಿನ', predTop5: 'ಅಗ್ರ 5 ಹಾಟ್‌ಸ್ಪಾಟ್',
    predDetailAction: 'ಶಿಫಾರಸು ಕ್ರಮ',
    patrolTitle: 'ಗಸ್ತು ಮಾರ್ಗ ಆಯ್ಕೆ', patrolUnitsLabel: 'ಗಸ್ತು ತಂಡ:',
    patrolAdvSettings: '⚙ ಸುಧಾರಿತ ಸೆಟ್ಟಿಂಗ್',
    patrolShiftStart: 'ಶಿಫ್ಟ್ ಆರಂಭ', patrolShiftDur: 'ಶಿಫ್ಟ್ ಅವಧಿ',
    patrolStation: 'ಆರಂಭ ಠಾಣೆ',
    generateRoutes: '⚡ ಅತ್ಯುತ್ತಮ ಮಾರ್ಗ ರಚಿಸಿ',
    patrolSpotlight: 'ಸ್ಪಾಟ್‌ಲೈಟ್ ತಂಡ', patrolCoverage: 'ವ್ಯಾಪ್ತಿ ಮಿತಿ',
    covTight: 'ಕಡಿಮೆ', covBalanced: 'ಸಮತೋಲ', covWide: 'ವಿಶಾಲ',
    patrolExplain: 'ಅಧಿಕಾರಿಗಳನ್ನು ಮೊದಲು ಹೆಚ್ಚು ಪ್ರಭಾವದ ಜಂಕ್ಷನ್‌ಗಳಿಗೆ ಕಳುಹಿಸಲಾಗುತ್ತದೆ.',
    patrolAlgoNote: 'ಮಾರ್ಗ ಕ್ರಮ ಜೆನೆಟಿಕ್ ಅಲ್ಗಾರಿದಮ್ ಮೂಲಕ ಆಯ್ಕೆ',
    covTitle: 'ವ್ಯಾಪ್ತಿ ಹೋಲಿಕೆ', covFixed: 'ನಿಗದಿ ಶಿಫ್ಟ್', covOptimized: 'ಅತ್ಯುತ್ತಮ',
    patrolItinerary: 'ಗಸ್ತು ಕಾರ್ಯಕ್ರಮ',
    itinUnit: 'ತಂಡ', itinJunction: 'ಜಂಕ್ಷನ್', itinArrive: 'ಬರುವ',
    itinDepart: 'ಹೋಗುವ', itinRevisit: 'ಮರು ಭೇಟಿ', itinPredicted: 'ಮುನ್ಸೂಚಿತ', itinLOS: 'LOS',
    dispatchTitle: '📧 ಅಧಿಕಾರಿಗೆ ಮಾರ್ಗ ಕಳುಹಿಸಿ',
    dispatchPlaceholder: 'adhikari@btp.kar.gov.in', dispatchSend: 'ಕಳುಹಿಸಿ',
    intRestructure: 'ಮರುರಚನೆ', intRestructureSub: 'ಮೂಲಸೌಕರ್ಯ ನಿರ್ಮಿಸಿ',
    intEnforce: 'ಜಾರಿ', intEnforceSub: 'ಗಸ್ತು ಹೆಚ್ಚಿಸಿ',
    intProcess: 'ಪ್ರಕ್ರಿಯೆ ಸರಿ', intProcessSub: 'ಪೈಪ್‌ಲೈನ್ ಸರಿಪಡಿಸಿ',
    intFilterAll: 'ಎಲ್ಲ', intFilterRestructure: 'ಮರುರಚನೆ',
    intFilterEnforce: 'ಜಾರಿ', intFilterProcess: 'ಪ್ರಕ್ರಿಯೆ ಸರಿ',
  }
};

let currentLang = 'en';

function _t(id, key, lang)  { const e=document.getElementById(id); if(e&&I18N[lang][key]!==undefined) e.textContent=I18N[lang][key]; }
function _ts(sel, key, lang) { const e=document.querySelector(sel); if(e&&I18N[lang][key]!==undefined) e.textContent=I18N[lang][key]; }
function _tt(sel, key, lang) {
  const e=document.querySelector(sel); if(!e||I18N[lang][key]===undefined) return;
  for(const n of e.childNodes){ if(n.nodeType===Node.TEXT_NODE&&n.textContent.trim()){ n.textContent=I18N[lang][key]+' '; return; } }
}

function applyTranslations(lang) {
  const d = I18N[lang]; if (!d) return;
  // Nav (data-i18n)
  document.querySelectorAll('[data-i18n]').forEach(el=>{ const k=el.getAttribute('data-i18n'); if(d[k]!==undefined) el.textContent=d[k]; });
  // Tour / lang
  _t('tour-btn','tourBtn',lang);
  const lb=document.getElementById('lang-toggle-btn');
  if(lb){ lb.textContent=d.langBtn; lb.className=lang==='kn'?'lang-btn active-kn':'lang-btn'; }
  // Brand
  const bEn=document.getElementById('brand-en'), bKn=document.getElementById('brand-kn');
  if(bEn) bEn.style.display=lang==='en'?'':'none';
  if(bKn) bKn.style.display=lang==='kn'?'':'none';
  // KPI
  const kl=document.querySelectorAll('.kpi-label');
  if(kl[0]) kl[0].textContent=d.kpiViolations;
  if(kl[1]) kl[1].textContent=d.kpiActions;
  if(kl[2]) kl[2].textContent=d.kpiEfficiency;
  // Filter accordion header
  _ts('.accordion-header[data-target="acc-filters"] span:first-child','filterSectionBtn',lang);
  // Filter group labels (text node only)
  const fgLbls=document.querySelectorAll('#acc-filters .filter-group label');
  const fgKeys=['filterTimeLabel','filterDayLabel','filterMonthLabel','filterVehicleLabel','filterViolationLabel'];
  fgLbls.forEach((lbl,i)=>{ if(!fgKeys[i]) return; for(const n of lbl.childNodes){ if(n.nodeType===Node.TEXT_NODE){ n.textContent=d[fgKeys[i]]; break; } } });
  // Select first options
  const mSel=document.getElementById('month-select'), vSel=document.getElementById('vehicle-select'), viSel=document.getElementById('violation-select');
  if(mSel?.options[0])  mSel.options[0].text=d.filterAllMonths;
  if(vSel?.options[0])  vSel.options[0].text=d.filterAllVehicles;
  if(viSel?.options[0]) viSel.options[0].text=d.filterAllViolations;
  // DOW buttons
  const mDow=document.querySelectorAll('#acc-filters .dow-btn');
  ['dowAll','dowMon','dowTue','dowWed','dowThu','dowFri','dowSat','dowSun'].forEach((k,i)=>{ if(mDow[i]&&d[k]) mDow[i].textContent=d[k]; });
  _t('reset-filters','filterReset',lang);
  // Simulation
  _ts('.accordion-header[data-target="acc-sim"] span:first-child','simSectionBtn',lang);
  const sl=document.querySelectorAll('.sim-speed-label');
  if(sl[0]) sl[0].textContent=d.simSpeed; if(sl[1]) sl[1].textContent=d.simDay;
  _t('sim-play','simPlay',lang); _t('sim-pause','simPause',lang); _t('sim-stop','simStop',lang);
  _ts('.sim-hotspot-title','simLiveHotspot',lang);
  const simDow=document.getElementById('sim-dow-select');
  const dF=['dowMonFull','dowTueFull','dowWedFull','dowThuFull','dowFriFull','dowSatFull','dowSunFull'];
  if(simDow) Array.from(simDow.options).forEach((o,i)=>{ if(d[dF[i]]) o.text=d[dF[i]]; });
  // Legend
  _tt('.legend-title','legendTitle',lang);
  const legItems=document.querySelectorAll('.legend-item');
  ['legendF','legendE','legendCD','legendAB'].forEach((k,i)=>{
    if(!legItems[i]||!d[k]) return;
    const dot=legItems[i].querySelector('.dot');
    legItems[i].innerHTML=(dot?dot.outerHTML:'')+' '+d[k];
  });
  // Map layers
  _ts('.layer-ctrl-title','mapLayers',lang);
  const ltl=document.querySelectorAll('.layer-toggle-label');
  if(ltl[0]) ltl[0].textContent=d.layerHeatmap;
  if(ltl[1]) ltl[1].textContent=d.layerHotspots;
  if(ltl[2]) ltl[2].textContent=d.layerShowAll;
  _ts('.layer-ctrl-sub','layerCtrlSub',lang);
  const msS=document.getElementById('ms-btn-standard'), msH=document.getElementById('ms-btn-hybrid');
  if(msS) msS.textContent=d.mapStandard; if(msH) msH.textContent=d.mapHybrid;
  const mst=document.querySelector('#mappls-layer-switcher .layer-ctrl-title');
  if(mst) mst.textContent=d.mapStyle;
  // Welcome banner
  const bSpans=document.querySelectorAll('#map-welcome-banner > span');
  if(bSpans[0]) bSpans[0].textContent=d.bannerClick;
  if(bSpans[2]) bSpans[2].textContent=d.bannerPlay;
  _t('banner-dismiss','bannerDismiss',lang);
  // Junction panel stat labels
  const stl=document.querySelectorAll('.stat-lbl');
  ['jpStatTotal','jpStatPeak','jpStatDay','jpStatVehicle'].forEach((k,i)=>{ if(stl[i]&&d[k]) stl[i].textContent=d[k]; });
  // JP section titles (first text node only)
  const jst=document.querySelectorAll('.jp-section-title');
  const jstK=[null,'jpRoadImpact','jpViolBreakdown','jpMonthlyTrend','jpEnfGap','jpDecayTitle','jpLWRTitle'];
  jst.forEach((el,i)=>{
    const k=jstK[i]; if(!k||!d[k]) return;
    for(const n of el.childNodes){ if(n.nodeType===Node.TEXT_NODE&&n.textContent.trim()){ n.textContent=d[k]+' '; return; } }
  });
  _ts('.road-label','jpNormal',lang);
  const il=document.querySelectorAll('.impact-lbl');
  ['jpLOS','jpLanes','jpThroughput'].forEach((k,i)=>{ if(il[i]&&d[k]&&!il[i].querySelector('.cite')) il[i].textContent=d[k]; });
  _ts('.capacity-bar-label','jpCapLost',lang);
  _ts('.big-pct-label','jpNullLabel',lang);
  const lwrL=document.querySelectorAll('.lwr-lbl');
  ['jpQueueLbl','jpShockLbl','jpSpeedLbl'].forEach((k,i)=>{ if(lwrL[i]&&d[k]) lwrL[i].textContent=d[k]; });
  // Predict tab
  const pft=document.querySelectorAll('#predict-controls .filter-title');
  if(pft[0]) pft[0].textContent=d.predTitle; if(pft[1]) pft[1].textContent=d.predTop5;
  const pfl=document.querySelectorAll('#predict-controls .filter-group label');
  if(pfl[0]){ for(const n of pfl[0].childNodes){ if(n.nodeType===Node.TEXT_NODE){ n.textContent=d.predHourLabel; break; } } }
  if(pfl[1]) pfl[1].textContent=d.predDayLabel;
  const pdow=document.querySelectorAll('.pred-dow');
  ['dowMon','dowTue','dowWed','dowThu','dowFri','dowSat','dowSun'].forEach((k,i)=>{ if(pdow[i]&&d[k]) pdow[i].textContent=d[k]; });
  _ts('.pred-detail-section-title','predDetailAction',lang);
  // Patrol tab
  _ts('#patrol-controls .filter-title','patrolTitle',lang);
  _t('generate-routes','generateRoutes',lang);
  _ts('.accordion-header[data-target="acc-patrol-adv"] span:first-child','patrolAdvSettings',lang);
  const afl=document.querySelectorAll('#acc-patrol-adv .filter-group label');
  if(afl[0]) afl[0].textContent=d.patrolShiftStart;
  if(afl[1]) afl[1].textContent=d.patrolShiftDur;
  if(afl[2]) afl[2].textContent=d.patrolStation;
  const cb=document.querySelectorAll('.cov-thresh-btn');
  if(cb[0]) cb[0].textContent=d.covTight; if(cb[1]) cb[1].textContent=d.covBalanced; if(cb[2]) cb[2].textContent=d.covWide;
  const spl=document.querySelector('#patrol-unit-filter-group label');
  if(spl) spl.textContent=d.patrolSpotlight;
  _ts('.patrol-explain','patrolExplain',lang);
  _ts('.patrol-algo-note','patrolAlgoNote',lang);
  _ts('.coverage-title','covTitle',lang);
  const cl=document.querySelectorAll('.cov-label');
  if(cl[0]) cl[0].textContent=d.covFixed; if(cl[1]) cl[1].textContent=d.covOptimized;
  const itT=document.querySelector('#itinerary-section .filter-title');
  if(itT) itT.textContent=d.patrolItinerary;
  const ths=document.querySelectorAll('#itinerary-table th');
  ['itinUnit','itinJunction','itinArrive','itinDepart','itinRevisit','itinPredicted','itinLOS'].forEach((k,i)=>{ if(ths[i]&&d[k]) ths[i].textContent=d[k]; });
  _ts('.dispatch-title','dispatchTitle',lang);
  _t('dispatch-email-btn','dispatchSend',lang);
  const di=document.getElementById('dispatch-email-input');
  if(di&&d.dispatchPlaceholder) di.placeholder=d.dispatchPlaceholder;
  // Interventions
  _ts('#int-restructure-card .int-count-label','intRestructure',lang);
  _ts('#int-restructure-card .int-count-sub','intRestructureSub',lang);
  _ts('#int-enforce-card .int-count-label','intEnforce',lang);
  _ts('#int-enforce-card .int-count-sub','intEnforceSub',lang);
  _ts('#int-process-card .int-count-label','intProcess',lang);
  _ts('#int-process-card .int-count-sub','intProcessSub',lang);
  const ifb=document.querySelectorAll('.int-filter-btn');
  ['intFilterAll','intFilterRestructure','intFilterEnforce','intFilterProcess'].forEach((k,i)=>{ if(ifb[i]&&d[k]) ifb[i].textContent=d[k]; });
}

function toggleLang() {
  currentLang = currentLang === 'en' ? 'kn' : 'en';
  applyTranslations(currentLang);
}

/* =========================================================
   LWR SHOCKWAVE PHYSICS — Fetch & Display
   ========================================================= */
async function loadLWRPhysics(junctionName) {
  try {
    const res  = await fetch(`${BASE}/api/physics?name=${encodeURIComponent(junctionName)}`);
    const data = await res.json();

    if (data.error) return;

    const titleEl = document.getElementById('lwr-section-title');
    const cardEl  = document.getElementById('lwr-card');
    const queueEl = document.getElementById('lwr-queue');
    const shockEl = document.getElementById('lwr-shock');
    const speedEl = document.getElementById('lwr-speed');

    if (!titleEl) return;

    // Only show for LOS D, E, F (meaningful bottlenecks)
    const showPhysics = ['D', 'E', 'F'].includes(data.los_grade);
    titleEl.style.display = showPhysics ? '' : 'none';
    cardEl.style.display  = showPhysics ? '' : 'none';

    if (showPhysics) {
      queueEl.textContent = data.queue_length_km > 0 ? `${data.queue_length_km} km` : '< 0.1 km';
      shockEl.textContent = `${Math.abs(data.shockwave_velocity_kmh).toFixed(1)}`;
      speedEl.textContent = `${data.v_bottleneck_kmh} km/h`;

      // Color the queue value red for severe cases
      queueEl.style.color = data.queue_length_km >= 1 ? '#ef4444'
                          : data.queue_length_km >= 0.5 ? '#f97316'
                          : '#a78bfa';
    }
  } catch (e) {
    // Physics endpoint unavailable — silently skip
  }
}

/* =========================================================
   EMAIL DISPATCH — Send patrol itinerary via backend SMTP
   ========================================================= */
let _lastPatrolResult = null;  // stores latest GA route result for dispatch

// Intercept patrol result storage (called after renderPatrolResult)
const _origRender = window.renderPatrolResult;
function patchPatrolCapture(result) {
  _lastPatrolResult = result;
}

// Hook into generate-routes button click to capture result
document.addEventListener('DOMContentLoaded', () => {
  const origBtn = document.getElementById('generate-routes');
  if (origBtn) {
    origBtn.addEventListener('click', async () => {
      // Wait for the fetch to complete, then capture from DOM
      setTimeout(() => {
        const rows = document.querySelectorAll('#itinerary-body tr');
        if (rows.length) {
          // Email panel shown automatically when itinerary renders
          document.getElementById('email-dispatch-panel').style.display = '';
        }
      }, 3500);
    });
  }
});

async function sendDispatchEmail() {
  const emailInput  = document.getElementById('dispatch-email-input');
  const statusEl    = document.getElementById('dispatch-status');
  const btn         = document.getElementById('dispatch-email-btn');
  const recipient   = (emailInput?.value || '').trim();

  if (!recipient || !recipient.includes('@')) {
    statusEl.className  = 'dispatch-status error';
    statusEl.textContent = '✗ Please enter a valid email address.';
    return;
  }

  // Extract itinerary from table DOM
  const units   = {};
  document.querySelectorAll('#itinerary-body tr').forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 7) return;
    const unitId = cells[0].textContent.replace('Unit ', '').trim();
    if (!units[unitId]) units[unitId] = { unit_id: unitId, route: [] };
    units[unitId].route.push({
      junction:             cells[1].textContent,
      arrive:               cells[2].textContent,
      depart:               cells[3].textContent,
      revisit_at:           cells[4].textContent,
      predicted_violations: parseFloat(cells[5].textContent) || 0,
      los_grade:            cells[6].textContent.replace('LOS ', '').trim()
    });
  });

  const station = document.getElementById('station-select')?.value || 'Bengaluru';

  // Show sending state
  btn.disabled            = true;
  statusEl.className      = 'dispatch-status sending';
  statusEl.textContent    = '⏳ Sending patrol route via email...';

  try {
    const res  = await fetch(`${BASE}/api/dispatch/email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recipient, units: Object.values(units), station })
    });
    const data = await res.json();

    if (data.success) {
      statusEl.className  = 'dispatch-status success';
      statusEl.textContent = `✓ Route dispatched to ${recipient}`;
      emailInput.value    = '';
    } else {
      statusEl.className  = 'dispatch-status error';
      statusEl.textContent = `✗ Failed: ${data.error || 'Unknown error'}`;
    }
  } catch (e) {
    statusEl.className  = 'dispatch-status error';
    statusEl.textContent = '✗ Network error — check that the backend is running.';
  } finally {
    btn.disabled = false;
  }
}

/* =========================================================
   HOOK — Augment junction panel open to also load LWR data
   ========================================================= */
// Patch: whenever a junction panel opens, also load LWR physics
const _origJpName = document.getElementById('jp-name');
if (_origJpName) {
  const jpObserver = new MutationObserver(() => {
    const name = document.getElementById('jp-name')?.textContent;
    if (name && name !== 'Junction Name') {
      loadLWRPhysics(name);
    }
  });
  jpObserver.observe(_origJpName, { childList: true, characterData: true, subtree: true });
}

/* =========================================================
   ANALYTICS DASHBOARD -- City Situation Report
   Premium animated redesign.
   Uses: LOS (Karachi 2024), CO2 (Zaragoza), LWR (1955),
         LightGBM 5-Fold predictions, CUSUM trend signals.
   ========================================================= */

// -- Live Clock ----------------------------------------------------------
function startDashClock() {
  const DAYS = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  function tick() {
    const now  = new Date();
    const day  = DAYS[now.getDay()];
    const hh   = now.getHours();
    const mm   = String(now.getMinutes()).padStart(2, '0');
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12  = ((hh % 12) || 12);
    
    // Original Header clock
    const el = document.getElementById('dash-clock-text');
    if (el) el.textContent = day + ', ' + h12 + ':' + mm + ' ' + ampm;
    
    // Large 3D card clock
    const timeEl = document.getElementById('dash-clock-time');
    const dayEl  = document.getElementById('dash-clock-day');
    if (timeEl) timeEl.textContent = h12 + ':' + mm;
    if (dayEl) dayEl.textContent = day + ' ' + ampm;
  }
  tick();
  setInterval(tick, 15000);
}

// -- 3D Isometric City Grid ----------------------------------------------
let _isoInterval = null;
function init3DCityGrid() {
  const container = document.getElementById('dash-iso-grid');
  if (!container) return;
  container.innerHTML = '';
  if (_isoInterval) clearInterval(_isoInterval);
  
  // Create 6x6 grid of cubes
  const size = 6;
  const cubeW = 16;
  const gap = 6;
  const cubes = [];
  
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const cube = document.createElement('div');
      cube.className = 'iso-cube';
      cube.style.left = (x * (cubeW + gap)) + 'px';
      cube.style.top  = (y * (cubeW + gap)) + 'px';
      container.appendChild(cube);
      cubes.push(cube);
    }
  }
  
  // Randomly animate heights
  function animateGrid() {
    const colors = [
      ['rgba(59,130,246,0.8)', 'rgba(37,99,235,0.9)', 'rgba(29,78,216,0.95)'], // Blue
      ['rgba(20,184,166,0.8)', 'rgba(13,148,136,0.9)', 'rgba(15,118,110,0.95)'], // Teal
      ['rgba(249,115,22,0.8)', 'rgba(234,88,12,0.9)', 'rgba(194,65,12,0.95)'], // Orange
      ['rgba(239,68,68,0.8)', 'rgba(220,38,38,0.9)', 'rgba(185,28,28,0.95)'] // Red (critical)
    ];
    cubes.forEach(c => {
      // 25% chance to be "active" (tall + colored)
      const isActive = Math.random() > 0.75;
      const isCritical = isActive && Math.random() > 0.8;
      
      const h = isActive ? (isCritical ? 60 + Math.random()*20 : 30 + Math.random()*30) : (5 + Math.random()*10);
      const colorSet = isActive ? (isCritical ? colors[3] : colors[Math.floor(Math.random() * 3)]) : colors[0];
      
      c.style.setProperty('--cube-h', h + 'px');
      c.style.setProperty('--top-color', colorSet[0]);
      c.style.setProperty('--front-color', colorSet[1]);
      c.style.setProperty('--side-color', colorSet[2]);
    });
  }
  
  // Initial animation on next frame, then loop
  setTimeout(animateGrid, 100);
  _isoInterval = setInterval(animateGrid, 3000); // animate every 3 seconds
}

// -- Utility: smooth count-up -------------------------------------------
function animateDashValue(el, target, duration, formatFn) {
  if (!el) return;
  const start = performance.now();
  const isFloat = !Number.isInteger(target);
  function tick(now) {
    const p = Math.min((now - start) / duration, 1);
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const v = e * target;
    el.textContent = formatFn ? formatFn(v) : (isFloat ? v.toFixed(1) : Math.round(v).toLocaleString('en-IN'));
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = formatFn ? formatFn(target) : (isFloat ? target.toFixed(1) : Math.round(target).toLocaleString('en-IN'));
  }
  requestAnimationFrame(tick);
}

// -- Dashboard loader ----------------------------------------------------
async function loadDashboard() {
  try {
    startDashClock();
    const data = await fetch(BASE + '/api/dashboard').then(r => r.json());
    renderDashKPIs(data);
    renderLOSDonut(data.los_distribution, data.total_junctions);
    renderEmergingRadar(data.rising_junctions, data.fading_junctions);
    renderShockwaveList(data.shockwave_top);
    renderDashForecast(data.predictions, data.model_info);
    renderEnforcementBars(data.intervention_counts, data.total_junctions);
    renderDashActionStrip(data.intervention_counts);
    initDashMiniMap();
    init3DCityGrid();
  } catch (e) {
    console.warn('Dashboard load failed:', e);
  }
}

// -- KPI Strip -----------------------------------------------------------
function renderDashKPIs(d) {
  const LOS_COLORS = { A:'#22c55e', B:'#86efac', C:'#eab308', D:'#f97316', E:'#ef4444', F:'#dc2626' };
  const color = LOS_COLORS[d.city_los] || '#f1f5f9';

  // Hero LOS badge
  const losEl = document.getElementById('d-city-los');
  if (losEl) {
    losEl.innerHTML =
      '<span class="los-badge-hero' + (['E','F'].includes(d.city_los) ? ' pulsing' : '') + '"' +
      ' style="color:' + color + ';border-color:' + color + '">' +
      d.city_los + '</span>';
  }

  // Animated count-up for numeric KPIs
  const capEl  = document.getElementById('d-capacity-lost');
  const co2El  = document.getElementById('d-co2');
  const critEl = document.getElementById('d-critical');
  const nullEl = document.getElementById('d-null-rate');

  if (capEl  && d.total_throughput_loss != null) animateDashValue(capEl, d.total_throughput_loss, 900);
  if (co2El  && d.total_co2_kg_hr != null)       animateDashValue(co2El, d.total_co2_kg_hr, 1000);
  if (critEl && d.critical_junctions != null) {
    critEl.style.color = d.critical_junctions > 200 ? '#ef4444' : '#f97316';
    animateDashValue(critEl, d.critical_junctions, 800);
  }
  if (nullEl && d.avg_null_rate != null) {
    nullEl.style.color = d.avg_null_rate > 40 ? '#ef4444' : '#eab308';
    animateDashValue(nullEl, d.avg_null_rate, 850, v => Math.round(v) + '%');
  }
}

// -- LOS Donut (animated SVG draw-in) ------------------------------------
function renderLOSDonut(dist, total) {
  const container = document.getElementById('los-donut-container');
  const legend    = document.getElementById('los-legend');
  if (!container || !legend) return;

  const grades = ['F','E','D','C','B','A'];
  const colors = { A:'#22c55e', B:'#86efac', C:'#eab308', D:'#f97316', E:'#ef4444', F:'#dc2626' };
  const labels = {
    A:'LOS A (Free flow)', B:'LOS B (Good)', C:'LOS C (Fair)',
    D:'LOS D (Slow)',      E:'LOS E (Heavy)', F:'LOS F (Critical)'
  };

  const tot  = Object.values(dist).reduce((s,v) => s+v, 0) || 1;
  const R = 50, cx = 60, cy = 60, SW = 16;
  const circ = 2 * Math.PI * R;

  // Build all segments starting zeroed out, animate them in via CSS transition
  let offset = 0;
  let circles = '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="#0a1628" stroke-width="' + (SW+2) + '"/>';

  // First pass: compute real dasharray values
  const segs = grades.map(g => {
    const frac = (dist[g] || 0) / tot;
    return { g, frac, dash: frac * circ };
  });

  // Render zeroed-out circles; transition will animate to final width
  let runOffset = -(circ * 0.25); // start at 12-o-clock
  segs.forEach(s => {
    circles += '<circle class="dash-segment" cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="' + colors[s.g] + '"' +
      ' stroke-width="' + SW + '"' +
      ' stroke-dasharray="0 ' + circ.toFixed(2) + '"' +
      ' stroke-dashoffset="' + runOffset.toFixed(2) + '"' +
      ' data-dash="' + s.dash.toFixed(2) + '"' +
      ' data-gap="' + (circ - s.dash).toFixed(2) + '"' +
      ' transform="rotate(-90 ' + cx + ' ' + cy + ')"' +
      '/>';
    runOffset -= s.dash;
  });

  const crit    = (dist.E||0) + (dist.F||0);
  const critPct = Math.round(crit / tot * 100);
  circles +=
    '<text x="' + cx + '" y="' + (cy-5) + '" text-anchor="middle" fill="#f1f5f9" font-size="15" font-weight="800" font-family="Inter,sans-serif">' + critPct + '%</text>' +
    '<text x="' + cx + '" y="' + (cy+9) + '" text-anchor="middle" fill="#64748b" font-size="8" font-family="Inter,sans-serif">critical</text>';

  container.innerHTML = '<svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">' + circles + '</svg>';

  // Trigger animation: set real dasharray values after one paint frame
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const svgCircles = container.querySelectorAll('circle.dash-segment');
    svgCircles.forEach((c, i) => {
      const d = c.getAttribute('data-dash');
      const gap = c.getAttribute('data-gap');
      c.style.transition = 'stroke-dasharray 0.8s cubic-bezier(0.22,1,0.36,1) ' + (i * 0.07) + 's';
      c.setAttribute('stroke-dasharray', d + ' ' + gap);
    });
  }));

  legend.innerHTML = grades.map(g => {
    const pct = Math.round((dist[g]||0)/tot*100);
    return '<div class="los-legend-item">' +
      '<div class="los-legend-dot" style="background:' + colors[g] + ';color:' + colors[g] + '"></div>' +
      '<span>' + labels[g] + '</span>' +
      '<span class="los-legend-pct">' + pct + '%</span>' +
    '</div>';
  }).join('');
}

// -- Emerging Radar ------------------------------------------------------
function renderEmergingRadar(rising, fading) {
  const rEl = document.getElementById('radar-rising-list');
  const fEl = document.getElementById('radar-fading-list');
  if (!rEl || !fEl) return;

  // Set class on section labels for colored pulse dot
  const labels = document.querySelectorAll('.radar-section-label');
  if (labels[0]) labels[0].classList.add('rising');
  if (labels[1]) labels[1].classList.add('fading');

  const losColors = { F:'#dc2626', E:'#ef4444', D:'#f97316', C:'#eab308', B:'#86efac', A:'#22c55e' };
  const makeItem = (item, dir) => {
    const sign  = dir === 'rising' ? '+' : '';
    const label = sign + item.change_pct.toFixed(0) + '%';
    const c     = losColors[item.los_grade] || '#94a3b8';
    return '<div class="radar-item">' +
      '<span class="radar-item-name" title="' + item.name + '">' + item.name + '</span>' +
      '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' + c + '22;color:' + c + ';font-weight:700">LOS ' + item.los_grade + '</span>' +
      '<span class="radar-badge ' + dir + '">' + (dir==='rising'?'&#9650;':'&#9660;') + ' ' + label + '</span>' +
    '</div>';
  };

  rEl.innerHTML = rising && rising.length
    ? rising.slice(0,4).map(j => makeItem(j,'rising')).join('')
    : '<div style="color:#475569;font-size:11px;padding:4px 0">No rapidly rising junctions detected</div>';

  fEl.innerHTML = fading && fading.length
    ? fading.slice(0,3).map(j => makeItem(j,'fading')).join('')
    : '<div style="color:#475569;font-size:11px;padding:4px 0">No rapidly fading junctions</div>';
}

// -- Shockwave List (animated bars) -------------------------------------
function renderShockwaveList(topList) {
  const el = document.getElementById('shockwave-list');
  if (!el) return;
  if (!topList || !topList.length) {
    el.innerHTML = '<div style="color:#475569;font-size:11px;padding:8px 0">Re-run preprocess.py to populate shockwave data.</div>';
    return;
  }
  const maxQ = topList[0].queue_length_km || 1;
  // Render bars with width:0 first, then animate
  el.innerHTML = topList.slice(0,6).map(item => {
    const pct   = Math.min(100, (item.queue_length_km / maxQ) * 100).toFixed(1);
    const color = item.queue_length_km >= 1 ? '#ef4444' : item.queue_length_km >= 0.5 ? '#f97316' : '#a78bfa';
    const glowClass = item.queue_length_km >= 1 ? 'glow-red' : item.queue_length_km >= 0.5 ? 'glow-orange' : '';
    return '<div class="shock-item">' +
      '<span class="shock-name" title="' + item.name + '">' + item.name + '</span>' +
      '<div class="shock-bar-wrap"><div class="shock-bar-fill ' + glowClass + '" data-pct="' + pct + '" style="background:' + color + ';width:0"></div></div>' +
      '<span class="shock-queue-val" style="color:' + color + '">' + item.queue_length_km + ' km</span>' +
    '</div>';
  }).join('');

  // Animate bars in
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.querySelectorAll('.shock-bar-fill').forEach((bar, i) => {
      setTimeout(() => { bar.style.width = bar.dataset.pct + '%'; }, i * 80);
    });
  }));
}

// -- Forecast with Confidence Bars (animated) ----------------------------
function renderDashForecast(preds, modelInfo) {
  const el    = document.getElementById('forecast-list');
  const badge = document.getElementById('dash-model-badge');
  const sub   = document.getElementById('dash-forecast-sub');
  if (!el) return;

  if (modelInfo && modelInfo.r2 != null && badge) {
    badge.textContent = 'LightGBM 5-Fold  R2=' + modelInfo.r2 + '  MAE=' + modelInfo.mae + ' viol/hr';
  }
  if (sub) {
    const now = new Date();
    sub.textContent = 'Hour ' + now.getHours() + ':00 forecast  +-20% confidence band (proxy until full conformal calibration)';
  }

  if (!preds || !preds.length) {
    el.innerHTML = '<div style="color:#475569;font-size:11px;padding:8px 0">No predictions cached for current hour.</div>';
    return;
  }

  const maxP = preds[0].confidence_high || 1;
  el.innerHTML = preds.slice(0,5).map(p => {
    const midPct  = Math.min(100, (p.predicted_count  / maxP) * 100).toFixed(1);
    const lowPct  = Math.min(100, (p.confidence_low   / maxP) * 100).toFixed(1);
    const highPct = Math.min(100, (p.confidence_high  / maxP) * 100).toFixed(1);
    const rangePx = Math.max(2, parseFloat(highPct) - parseFloat(lowPct));
    return '<div class="forecast-item">' +
      '<div class="forecast-name">' + p.name + '</div>' +
      '<div class="forecast-bar-row">' +
        '<div class="forecast-bar-wrap">' +
          '<div class="forecast-bar-range" style="left:' + lowPct + '%;width:' + rangePx.toFixed(1) + '%"></div>' +
          '<div class="forecast-bar-point" style="left:' + midPct + '%"></div>' +
        '</div>' +
        '<span class="forecast-val">' + p.confidence_low + '-' + p.confidence_high + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// -- Enforcement Breakdown Bars (animated) -------------------------------
function renderEnforcementBars(counts, total) {
  const el = document.getElementById('enforcement-bars');
  if (!el) return;

  const items = [
    { label:'ENFORCE',     count: counts.ENFORCE     || 0, color:'#3b82f6' },
    { label:'RESTRUCTURE', count: counts.RESTRUCTURE || 0, color:'#f97316' },
    { label:'PROCESS FIX', count: counts['PROCESS FIX'] || 0, color:'#ef4444' },
  ];
  const maxCount = Math.max(...items.map(i => i.count), 1);
  const tot = total || 1;

  el.innerHTML = items.map(item => {
    const barPct   = ((item.count / maxCount) * 100).toFixed(1);
    const sharePct = ((item.count / tot) * 100).toFixed(0);
    return '<div class="enf-bar-item">' +
      '<div class="enf-bar-label">' + item.label + '</div>' +
      '<div class="enf-bar-track">' +
        '<div class="enf-bar-fill" data-pct="' + barPct + '" style="background:' + item.color + '40;border-right:2px solid ' + item.color + ';width:0"></div>' +
      '</div>' +
      '<div class="enf-bar-count">' + item.count.toLocaleString('en-IN') + ' <span style="color:#475569;font-weight:400;font-size:10px">(' + sharePct + '%)</span></div>' +
    '</div>';
  }).join('');

  // Animate bars
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.querySelectorAll('.enf-bar-fill').forEach((bar, i) => {
      setTimeout(() => { bar.style.width = bar.dataset.pct + '%'; }, i * 120);
    });
  }));
}

// -- Action Strip --------------------------------------------------------
function renderDashActionStrip(counts) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('dash-enforced-count',    (counts.ENFORCE     || 0).toLocaleString('en-IN') + ' junctions need patrol today');
  set('dash-restructure-count', (counts.RESTRUCTURE || 0).toLocaleString('en-IN') + ' need infrastructure changes');
  set('dash-process-count',     (counts['PROCESS FIX'] || 0).toLocaleString('en-IN') + ' have broken evidence chains');
}

// -- Mini Prediction Map -------------------------------------------------
function initDashMiniMap() {
  const container = document.getElementById('dash-mini-map');
  if (!container) return;

  if (window.dashMiniMap) {
    // Already initialised — just fix size then refresh markers
    setTimeout(() => {
      window.dashMiniMap.invalidateSize();
      renderDashMiniMapPredictions();
    }, 100);
    return;
  }

  window.dashMiniMap = L.map('dash-mini-map', {
    zoomControl: false,
    scrollWheelZoom: false,
    dragging: true,
    doubleClickZoom: false,
  }).setView(BENGALURU, 12);

  // Use the same tile factory as all other maps (Mappls or CartoDB dark)
  smartTileLayer().addTo(window.dashMiniMap);

  // Add heatmap layer (same configuration as predict tab)
  window.dashMiniHeatLayer = L.heatLayer([], { radius: 25, blur: 20, maxZoom: 17, max: 2 }).addTo(window.dashMiniMap);

  // Keep module-level aliases in sync for mappls-init.js patching and local use
  dashMiniMap = window.dashMiniMap;
  dashMiniHeatLayer = window.dashMiniHeatLayer;

  // Robust fix for Leaflet grey tiles when resizing via Flexbox
  setTimeout(() => {
    window.dashMiniMap.invalidateSize(true);
    window.dispatchEvent(new Event('resize'));
    renderDashMiniMapPredictions();
  }, 400);
}

async function renderDashMiniMapPredictions() {
  const map = window.dashMiniMap || dashMiniMap;
  if (!map) return;

  // Current local hour & day-of-week (Mon=0 ... Sun=6)
  const now    = new Date();
  const hour   = now.getHours();
  const jsDay  = now.getDay();              // JS: 0=Sun … 6=Sat
  const dow    = jsDay === 0 ? 6 : jsDay - 1; // API: Mon=0 … Sun=6

  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const citeEl = document.getElementById('dash-map-cite');
  if (citeEl) citeEl.textContent = 'Hour ' + hour + ':00  \u00b7  ' + DAYS[dow] + '  \u2014  live LightGBM inference';
  const subEl = document.getElementById('dash-map-sub');
  if (subEl) subEl.textContent = 'Top predicted violation hotspots right now  \u2014  LightGBM 5-Fold';

  try {
    const preds = await fetch(BASE + '/api/predict?hour=' + hour + '&dow=' + dow).then(r => r.json());

    // Clear old markers and heat data
    dashMiniMarkers.forEach(m => { try { map.removeLayer(m); } catch(e) {} });
    dashMiniMarkers = [];
    if (dashMiniHeatLayer) dashMiniHeatLayer.setLatLngs([]);

    if (!preds || !preds.length) {
      console.warn('Mini-map: no predictions for hour=' + hour + ' dow=' + dow);
      return;
    }

    const maxCount = preds[0].predicted_count || 1;
    const LOS_COLOR = { F:'#dc2626', E:'#ef4444', D:'#f97316', C:'#eab308', B:'#22c55e', A:'#86efac' };
    const heatPts = [];

    // Use top 20 for heatmap, top 10 for explicit markers
    preds.slice(0, 20).forEach((p, idx) => {
      if (!p.lat || !p.lon) return;
      
      // Add to heatmap
      heatPts.push([p.lat, p.lon, p.predicted_count]);

      // Add explicit markers for the top 10
      if (idx < 10) {
        const intensity = p.predicted_count / maxCount;
        // Radius: 12-30px proportional to intensity
        const radius = Math.max(12, Math.min(30, intensity * 30));
        const color  = LOS_COLOR[p.los_grade] || '#3b82f6';

        const m = L.circleMarker([p.lat, p.lon], {
          radius,
          fillColor:   color,
          fillOpacity: 0.80,
          weight:      2,
          color:       color,
          opacity:     1,
        })
        .bindTooltip(
          '<b>' + p.name + '</b><br>' +
          Math.round(p.predicted_count) + ' predicted violations<br>' +
          'LOS ' + p.los_grade + ' &bull; ' + (p.intervention_type || ''),
          { sticky: true, className: 'dash-mini-tooltip' }
        )
        .addTo(map);

        dashMiniMarkers.push(m);
      }
    });

    if (dashMiniHeatLayer) dashMiniHeatLayer.setLatLngs(heatPts);

    console.log('Mini-map: rendered ' + dashMiniMarkers.length + ' markers and ' + heatPts.length + ' heat points');
  } catch (e) {

    console.warn('Mini-map prediction fetch failed:', e);
  }
}

