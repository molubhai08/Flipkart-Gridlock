/* =========================================================
   EnforceIQ AI — main.js
   Vanilla JS + Leaflet + leaflet.heat
   Backend: http://localhost:8000
   ========================================================= */

const BASE = 'http://localhost:8000';

// ── State ─────────────────────────────────────────────────
const state = {
  hour: -1, dow: -1, month: -1,
  vehicleType: 'all', violationType: 'all',
  predHour: 9, predDow: 0,
  patrolUnits: 4, shiftStart: 9, shiftDuration: 8,
  patrolStation: 'Upparpet', coverageThreshold: 0.4,
  heatmapWeightMode: 'volume'
};

// ── Map instances ─────────────────────────────────────────
let mainMap, predictMap, patrolMap;
let mainHeatLayer, predictHeatLayer;
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

// ── Map initialisation ────────────────────────────────────
// Only init mainMap on page load.
// predictMap and patrolMap are init lazily when their tabs open
// (hidden divs have zero size — Leaflet crashes on them).

function initMainMap() {
  mainMap = L.map('map', { zoomControl: true }).setView(BENGALURU, 12);
  L.tileLayer(DARK_TILES, { attribution: TILE_ATTR }).addTo(mainMap);
  mainHeatLayer = L.heatLayer([], { radius: 25, blur: 20, maxZoom: 17, max: 10 }).addTo(mainMap);
}

function initPredictMap() {
  if (predictMap) { predictMap.invalidateSize(); return; }
  predictMap = L.map('predict-map', { zoomControl: true }).setView(BENGALURU, 12);
  L.tileLayer(DARK_TILES, { attribution: TILE_ATTR }).addTo(predictMap);
  predictHeatLayer = L.heatLayer([], { radius: 25, blur: 20, maxZoom: 17, max: 2 }).addTo(predictMap);
}

function initPatrolMap() {
  if (patrolMap) { patrolMap.invalidateSize(); return; }
  patrolMap = L.map('patrol-map', { zoomControl: true }).setView(BENGALURU, 12);
  L.tileLayer(DARK_TILES, { attribution: TILE_ATTR }).addTo(patrolMap);
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
    `${BASE}/api/junction/${encodeURIComponent(junctionName)}`
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
    const jd = await fetch(`${BASE}/api/junction/${encodeURIComponent(p.name)}`).then(r => r.json());
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

      // invalidate map size after tab switch
      setTimeout(() => {
        if (tab === 'map')           mainMap.invalidateSize();
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
  initMainMap();
  setupNavTabs();
  setupFilters();
  setupSimulation();
  setupPatrolSimulation();
  setupUIInteractions();
  setupLayerController();

  await Promise.all([
    loadKPIs(),
    loadFilterOptions(),
    fetch(`${BASE}/api/predictions-all`).then(r => r.json()).then(d => { PREDICTIONS_JS = d; }),
  ]);

  // Small delay to ensure map container is fully painted
  setTimeout(async () => {
    mainMap.invalidateSize();
    await loadJunctions();
    await updateHeatmap();

    // dismiss welcome banner on first junction click or manual dismiss
    const banner = document.getElementById('map-welcome-banner');
    document.getElementById('banner-dismiss').addEventListener('click', () => {
      banner.classList.add('dismissed');
    });
    // auto-dismiss after 12 seconds
    setTimeout(() => banner.classList.add('dismissed'), 12000);
  }, 200);
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
    if (tabName === 'map')           mainMap.invalidateSize();
    if (tabName === 'predict')       { initPredictMap(); }
    if (tabName === 'patrol')        initPatrolMap();
    if (tabName === 'interventions') {}
  }, 80);
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
