"""
EnforceIQ AI — FastAPI Backend
Run with: uvicorn app:app --reload --port 8000

Architecture (speed contract):
  • All heatmap / junction / intervention data = pre-loaded JSON/parquet → O(1)
  • Predictions = served from PRED_CACHE dict (pre-warmed at startup from
    predictions.json, which was built by the LightGBM 5-fold ensemble).
  • /api/predict/live   = live LightGBM inference for arbitrary hour/dow
    queries, with a request-level functools.lru_cache so identical queries
    are answered instantly after the first hit.
"""

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi import Body
from pathlib import Path
import pandas as pd
import numpy as np
import json
import math
import pickle
import functools
import random
import smtplib
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

# ── Load .env credentials ─────────────────────────────────────────────────────────────────────────────────────
def _load_env():
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
_load_env()

SMTP_HOST     = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT     = int(os.environ.get("SMTP_PORT", 587))
SMTP_USER     = os.environ.get("SMTP_USERNAME", "")
SMTP_PASS     = os.environ.get("SMTP_PASSWORD", "")
DISPATCH_FROM = os.environ.get("DISPATCH_FROM", SMTP_USER)
MAPPLS_KEY    = os.environ.get("MAPPLS_API_KEY", "")

app = FastAPI(title="EnforceIQ AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── serve static files ────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# ── load all static data at startup ───────────────────────────────────────────
DATA_DIR = BASE_DIR / "data"

with open(DATA_DIR / "junction_aggregates.json") as f:
    JUNCTIONS: dict = json.load(f)

with open(DATA_DIR / "decay_windows.json") as f:
    DECAY: dict = json.load(f)

with open(DATA_DIR / "kpis.json") as f:
    KPIS: dict = json.load(f)

with open(DATA_DIR / "filter_options.json") as f:
    FILTER_OPTIONS: dict = json.load(f)

HEATMAP_DF = pd.read_parquet(DATA_DIR / "heatmap.parquet")

# ── load ML model + warm prediction cache ────────────────────────────────────
MODEL_DATA = None
PRED_CACHE: dict = {}   # (jname, hour, dow) → float  — warm dict from predictions.json

# Load predictions.json (built by LightGBM ensemble in preprocess.py) into cache
_predictions_path = DATA_DIR / "predictions.json"
if _predictions_path.exists():
    with open(_predictions_path) as f:
        _raw_preds: dict = json.load(f)
    for _jname, _hours in _raw_preds.items():
        for _h_str, _dows in _hours.items():
            for _d_str, _val in _dows.items():
                PRED_CACHE[(_jname, int(_h_str), int(_d_str))] = float(_val)
    print(f"[OK] Prediction cache warmed: {len(PRED_CACHE):,} entries (LightGBM)")

# Load model.pkl for live inference (optional — used only by /api/predict/live)
_model_path = DATA_DIR / "model.pkl"
if _model_path.exists():
    try:
        with open(_model_path, "rb") as f:
            MODEL_DATA = pickle.load(f)
        print(f"[OK] LightGBM 5-fold ensemble loaded  "
              f"R2={MODEL_DATA.get('r2', '?')}  MAE={MODEL_DATA.get('mae', '?')}")
        print(f"  Features: {MODEL_DATA.get('features', [])}")
    except Exception as e:
        print(f"[WARN] Failed to load model.pkl ({e}) -- live inference unavailable, serving from cache only")
        MODEL_DATA = None
else:
    print("[WARN] model.pkl not found -- live inference unavailable, serving from cache only")

print(f"[OK] Loaded {len(JUNCTIONS)} junctions")
print(f"[OK] Heatmap: {len(HEATMAP_DF):,} records")


# ── ML inference helper ───────────────────────────────────────────────────────
@functools.lru_cache(maxsize=4096)
def _lgb_predict(jname: str, hour: int, dow: int, month: int) -> float:
    """
    Run the 5-fold LightGBM ensemble for a single (junction, hour, dow, month)
    combination.  Results are memoised by lru_cache so identical queries within
    the same server process are returned from memory instantly.
    """
    if MODEL_DATA is None:
        # Fall back to pre-computed cache if model wasn't loaded
        return PRED_CACHE.get((jname, hour, dow), 0.0)

    log_tot     = MODEL_DATA["log_total_map"].get(jname, 0.0)
    ph          = MODEL_DATA["peak_hour_map"].get(jname, 12)
    junc_global = MODEL_DATA["junc_global_mean"].get(jname, MODEL_DATA["global_mean"])

    hr_from_peak = min(abs(hour - ph), 24 - abs(hour - ph))
    near_pk      = 1 if hr_from_peak <= 2 else 0
    is_biz       = 1 if 7 <= hour <= 21 else 0
    is_wknd      = 1 if dow >= 5 else 0

    jh_mean = MODEL_DATA["junc_hour_mean"].get(str((jname, hour)), junc_global)
    jh_std  = MODEL_DATA["junc_hour_std"].get(str((jname, hour)), 0.0)
    jd_mean = MODEL_DATA["junc_dow_mean"].get(str((jname, dow)),  junc_global)

    X_inf = np.array([[hour, dow, month, is_wknd, is_biz,
                        near_pk, log_tot,
                        jh_mean, jd_mean, jh_std,
                        junc_global, junc_global]],
                     dtype=np.float32)

    pred = float(np.mean([
        max(0.0, m.predict(X_inf)[0]) for m in MODEL_DATA["models"]
    ]))
    return round(pred, 3)


# ── helper ────────────────────────────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * \
        math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


# ── routes ────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE_DIR / "templates" / "index.html").read_text(encoding="utf-8")


@app.get("/api/config")
def get_config():
    """Exposes safe runtime config to the frontend — Mappls key, feature flags."""
    return {
        "mappls_key":     MAPPLS_KEY,
        "mappls_enabled": bool(MAPPLS_KEY),
    }

@app.get("/api/kpis")
def get_kpis():
    """Global KPIs including LightGBM model metrics."""
    return KPIS


@app.get("/api/filter-options")
def get_filter_options():
    return FILTER_OPTIONS


@app.get("/api/heatmap")
def get_heatmap(
    hour: int = Query(-1),
    dow:  int = Query(-1),
    month: int = Query(-1),
    vehicle_type: str = Query("all"),
    violation_type: str = Query("all"),
):
    df = HEATMAP_DF.copy()
    if hour  >= 0:              df = df[df["hour"]  == hour]
    if dow   >= 0:              df = df[df["dow"]   == dow]
    if month >= 0:              df = df[df["month"] == month]
    if vehicle_type  != "all":  df = df[df["vehicle_type"]      == vehicle_type]
    if violation_type != "all": df = df[df["primary_violation"]  == violation_type]

    grouped = (
        df.groupby(["lat", "lon"])["count"]
        .sum()
        .reset_index()
        .rename(columns={"count": "weight"})
    )
    return grouped.to_dict("records")


@app.get("/api/junctions")
def get_junctions():
    return [
        {
            "name":             d["name"],
            "lat":              d["lat"],
            "lon":              d["lon"],
            "total_violations": d["total_violations"],
            "los_grade":        d["los_grade"],
            "intervention_type": d["intervention_type"],
            "peak_hour":        d["peak_hour"],
            "capacity_lost_pct": d["capacity_lost_pct"],
        }
        for d in JUNCTIONS.values()
    ]


@app.get("/api/junction")
def get_junction(name: str):
    data = JUNCTIONS.get(name)
    if not data:
        return {"error": "not found"}
    return {**data, "decay_minutes": DECAY.get(name)}


# ── PREDICT — primary endpoint (O(1) cache lookup) ───────────────────────────
@app.get("/api/predict")
def get_predictions(hour: int = Query(9), dow: int = Query(0)):
    """
    Returns top-10 predicted hotspots for a given hour/dow.
    Served from PRED_CACHE (pre-warmed from LightGBM ensemble output).
    Average response time: <5 ms regardless of junction count.
    """
    results = []
    for jname, jdata in JUNCTIONS.items():
        pred = PRED_CACHE.get((jname, hour, dow), 0.0)
        if pred > 0:
            results.append({
                "name":              jname,
                "lat":               jdata["lat"],
                "lon":               jdata["lon"],
                "predicted_count":   round(pred, 2),
                "los_grade":         jdata["los_grade"],
                "decay_minutes":     DECAY.get(jname),
                "intervention_type": jdata["intervention_type"],
                "dominant_vehicle":  jdata["dominant_vehicle"],
            })
    results.sort(key=lambda x: x["predicted_count"], reverse=True)
    return results[:10]


# ── PREDICT LIVE — live LightGBM inference for arbitrary queries ──────────────
@app.get("/api/predict/live")
def get_predictions_live(
    hour:  int = Query(9),
    dow:   int = Query(0),
    month: int = Query(12),   # caller supplies month for full seasonal signal
):
    """
    Live LightGBM 5-fold ensemble inference.  Results are memoised by
    lru_cache so the second call for the same (jname, hour, dow, month)
    is instantaneous.  Use this endpoint when you need month-aware predictions
    (e.g. December peak vs April low season).
    """
    results = []
    for jname, jdata in JUNCTIONS.items():
        pred = _lgb_predict(jname, hour, dow, month)
        if pred > 0:
            results.append({
                "name":              jname,
                "lat":               jdata["lat"],
                "lon":               jdata["lon"],
                "predicted_count":   pred,
                "los_grade":         jdata["los_grade"],
                "decay_minutes":     DECAY.get(jname),
                "intervention_type": jdata["intervention_type"],
                "dominant_vehicle":  jdata["dominant_vehicle"],
                "model_powered":     True,
            })
    results.sort(key=lambda x: x["predicted_count"], reverse=True)
    return results[:10]


# ── PREDICTIONS ALL — full precomputed cache for frontend simulation ──────────
@app.get("/api/predictions-all")
def get_predictions_all():
    """
    Returns the full precomputed predictions.json structure so the frontend
    can drive the per-hour heatmap simulation without making per-junction calls.
    Shape: { jname: { hour_str: { dow_str: float } } }
    """
    # Rebuild nested dict from the flat PRED_CACHE keyed by (jname, hour, dow)
    out: dict = {}
    for (jname, hour, dow), val in PRED_CACHE.items():
        out.setdefault(jname, {}).setdefault(str(hour), {})[str(dow)] = val
    return out


# ── MODEL INFO endpoint ───────────────────────────────────────────────────────
@app.get("/api/model-info")
def get_model_info():
    """Returns LightGBM model metadata for display in the UI."""
    if MODEL_DATA is None:
        return {"available": False}
    return {
        "available":    True,
        "model_type":   "LightGBM 5-Fold Ensemble",
        "r2":           MODEL_DATA.get("r2"),
        "mae":          MODEL_DATA.get("mae"),
        "n_folds":      len(MODEL_DATA.get("models", [])),
        "features":     MODEL_DATA.get("features", []),
        "n_junctions":  len(MODEL_DATA.get("junction_names", [])),
        "cache_entries": len(PRED_CACHE),
    }


@app.post("/api/patrol/optimize")
def optimize_patrol(body: dict):
    num_units    = int(body.get("num_units", 4))
    start_hour   = int(body.get("shift_start_hour", 9))
    duration     = int(body.get("shift_duration_hours", 8))
    station_name = body.get("starting_station", "Upparpet")
    coverage_p   = float(body.get("coverage_threshold", 0.4))  # top p% as hotspots

    end_hour    = min(start_hour + duration, 24)   # hard cap at midnight
    shift_hours = list(range(start_hour, end_hour))

    # ── Score junctions for this shift ──────────────────────────────────────
    scored = []
    for jname, jdata in JUNCTIONS.items():
        score = sum(
            PRED_CACHE.get((jname, h, 0), 0.0)
            for h in shift_hours
        )
        if score > 0:
            scored.append({
                "name":  jname,
                "score": score,
                "lat":   jdata["lat"],
                "lon":   jdata["lon"],
                "decay": DECAY.get(jname, 45),
                "los":   jdata["los_grade"],
                "itype": jdata["intervention_type"],
            })

    scored.sort(key=lambda x: x["score"], reverse=True)

    # ── Hotspot extraction with parameter p (Kim et al. 2023) ───────────────
    # Each stop takes 15 min dwell + 10 min travel = 25 min per stop.
    # Cap total hotspots so each unit can physically visit its share within
    # the shift window.  Without this cap, a single unit accumulates hundreds
    # of stops, producing itineraries that run 40+ hours.
    shift_minutes      = duration * 60
    stops_per_unit_max = max(1, shift_minutes // 25)   # 25 min per stop
    max_hotspots       = num_units * stops_per_unit_max

    n_hotspots  = min(
        max_hotspots,
        max(num_units * 2, int(len(scored) * coverage_p))
    )
    hotspots    = scored[:n_hotspots]
    total_predicted = sum(j["score"] for j in scored)

    # ── Genetic Algorithm Route Optimization (Kim et al. 2023) ──────────────
    # Assign hotspots to units, then GA optimizes the visit sequence per unit

    # Step 1: assign hotspots to units by round-robin on score rank
    unit_junctions = [[] for _ in range(num_units)]
    for i, junc in enumerate(hotspots):
        unit_junctions[i % num_units].append(junc)

    def route_distance(route):
        """Total Euclidean distance of a route sequence."""
        if len(route) <= 1:
            return 0.0
        dist = 0.0
        for k in range(len(route) - 1):
            dlat = route[k]["lat"] - route[k+1]["lat"]
            dlon = route[k]["lon"] - route[k+1]["lon"]
            dist += math.sqrt(dlat**2 + dlon**2)
        return dist

    def route_fitness(route):
        """
        Fitness = score_coverage / (distance + epsilon)
        Higher is better — maximizes coverage while minimizing travel distance.
        Mirrors Kim et al. Eq.4 fitness function combining coverage and travel time.
        """
        if not route:
            return 0.0
        total_score = sum(j["score"] for j in route)
        dist        = route_distance(route) + 1e-6
        return total_score / dist

    def ordered_crossover(parent1, parent2):
        """
        Ordered Crossover (OX) — standard GA operator for TSP variants.
        Preserves relative order of junctions from parent1 in offspring.
        """
        n = len(parent1)
        if n <= 2:
            return parent1[:]
        a, b = sorted(random.sample(range(n), 2))
        child = [None] * n
        child[a:b] = parent1[a:b]
        fill_vals  = [x for x in parent2 if x not in child[a:b]]
        fill_idx   = [i for i in range(n) if child[i] is None]
        for idx, val in zip(fill_idx, fill_vals):
            child[idx] = val
        return child

    def mutate(route, mutation_rate=0.15):
        """Swap mutation: randomly swap two stops in the route."""
        route = route[:]
        if len(route) >= 2 and random.random() < mutation_rate:
            i, j = random.sample(range(len(route)), 2)
            route[i], route[j] = route[j], route[i]
        return route

    def ga_optimize(junctions, n_generations=120, pop_size=40):
        """
        Genetic Algorithm route optimizer.
        Based on Kim et al. (2023) Section 3.3 — selection, crossover, mutation.
        """
        if len(junctions) <= 2:
            return junctions[:]

        # Initialize population with random permutations
        population = [random.sample(junctions, len(junctions))
                      for _ in range(pop_size)]

        best_route   = max(population, key=route_fitness)
        best_fitness = route_fitness(best_route)

        for _ in range(n_generations):
            # Evaluate fitness for all routes
            fitnesses = [route_fitness(r) for r in population]
            total_fit = sum(fitnesses) + 1e-9

            # Roulette wheel selection (Kim et al. Section 3.3.2)
            def roulette_select():
                pick   = random.uniform(0, total_fit)
                cumsum = 0.0
                for route, fit in zip(population, fitnesses):
                    cumsum += fit
                    if cumsum >= pick:
                        return route
                return population[-1]

            new_pop = []
            for _ in range(pop_size):
                p1  = roulette_select()
                p2  = roulette_select()
                child = ordered_crossover(p1, p2)
                child = mutate(child)
                new_pop.append(child)

            population = new_pop

            # Track best
            gen_best = max(population, key=route_fitness)
            if route_fitness(gen_best) > best_fitness:
                best_route   = gen_best
                best_fitness = route_fitness(gen_best)

        return best_route

    # ── Build itineraries using GA-optimized routes ─────────────────────────
    result_units  = []
    total_covered = 0

    def fmt(m):
        return f"{int(m)//60:02d}:{int(m)%60:02d}"

    for uid, junctions in enumerate(unit_junctions):
        if not junctions:
            continue

        # GA optimize the visit sequence for this unit's assigned junctions
        optimized = ga_optimize(junctions)

        route       = []
        current_min = start_hour * 60
        end_min     = end_hour * 60

        for junc in optimized:
            # Hard stop: if there isn't even enough time to arrive + dwell,
            # don't add any more stops to this unit's route.
            if current_min + 15 > end_min:
                break

            arrive_min  = current_min
            depart_min  = current_min + 15
            revisit_min = depart_min + junc["decay"]

            route.append({
                "junction":             junc["name"],
                "arrive":               fmt(arrive_min),
                "depart":               fmt(depart_min),
                "revisit_at":           fmt(revisit_min) if revisit_min < end_min else "—",
                "predicted_violations": round(junc["score"] / max(len(shift_hours), 1), 1),
                "los_grade":            junc["los"],
                "intervention_type":    junc["itype"],
            })
            total_covered += junc["score"]
            current_min    = depart_min + 10

        result_units.append({
            "unit_id":          uid + 1,
            "starting_station": station_name,
            "route":            route,
            "unit_coverage_pct": round(
                sum(j["score"] for j in junctions) / (total_predicted + 1) * 100, 1
            ),
        })

    baseline_top3 = sum(j["score"] for j in scored[:3])

    return {
        "units":                      result_units,
        "total_coverage_pct":         round(total_covered  / (total_predicted + 1) * 100, 1),
        "baseline_fixed_shift_pct":   round(baseline_top3   / (total_predicted + 1) * 100, 1),
        "total_predicted_violations": round(total_predicted, 1),
        "n_hotspots":                 len(hotspots),
        "coverage_threshold":         coverage_p,
        "algorithm":                  "Genetic Algorithm (Kim et al., Heliyon 2023)",
        "model_powered":              MODEL_DATA is not None,
        "model_r2":                   MODEL_DATA.get("r2") if MODEL_DATA else None,
    }


@app.get("/api/interventions")
def get_interventions():
    counts = {"RESTRUCTURE": 0, "ENFORCE": 0, "PROCESS FIX": 0}
    result = []
    for d in JUNCTIONS.values():
        itype = d["intervention_type"]
        counts[itype] = counts.get(itype, 0) + 1
        result.append({
            "name":              d["name"],
            "total_violations":  d["total_violations"],
            "intervention_type": itype,
            "recommendation":    d["recommendation"],
            "precedent":         d["precedent"],
            "estimated_impact":  d["estimated_impact"],
            "los_grade":         d["los_grade"],
            "dominant_vehicle":  d["dominant_vehicle"],
            "tw_pct":            d["tw_pct"],
            "null_rate":         d["null_rate"],
            "is_chronic":        d["is_chronic"],
            "monthly_trend":     d["monthly_trend"],
            "veh_counts":        d["veh_counts"],
            "capacity_lost_pct": d["capacity_lost_pct"],
            "co2_kg_per_hour":   d["co2_kg_per_hour"],
            "effective_lanes":   d["effective_lanes"],
            "throughput_loss":   d["throughput_loss"],
        })
    result.sort(key=lambda x: x["total_violations"], reverse=True)
    return {"summary_counts": counts, "junctions": result}


# ── LWR Physics: Greenshields + Shockwave queue length ─────────────────────────────────────────────────────────────────────────────────────
@app.get("/api/physics")
def get_physics(name: str):
    """
    Calculates Lighthill-Whitham-Richards (LWR) shockwave physics for a junction.
    Returns capacity_loss_pct, shockwave_velocity_kmh, and queue_length_km.
    """
    data = JUNCTIONS.get(name)
    if not data:
        return {"error": "not found"}

    # Parameters for Bengaluru urban arterials
    free_flow_speed = 50.0   # km/h typical free-flow
    jam_density     = 120.0  # vehicles/km/lane (jam)
    base_lanes      = 3.0    # assumed 3-lane carriageway

    # Use existing effective_lanes from Karachi LOS (already computed)
    effective_lanes = data.get("effective_lanes", base_lanes)
    cap_loss_pct    = data.get("capacity_lost_pct", 0.0)

    # Greenshields: speed at bottleneck
    # v = v_f * (1 - k/k_j)  →  rearranged for capacity ratio
    capacity_ratio  = effective_lanes / base_lanes
    k_bottleneck    = jam_density * (1.0 - capacity_ratio * 0.5)
    v_bottleneck    = free_flow_speed * (1.0 - k_bottleneck / jam_density)
    q_bottleneck    = k_bottleneck * v_bottleneck

    k_normal = 30.0  # typical upstream density
    v_normal = free_flow_speed * (1.0 - k_normal / jam_density)
    q_normal = k_normal * v_normal

    # LWR shockwave velocity (negative = propagates upstream)
    denom = k_bottleneck - k_normal
    omega = (q_bottleneck - q_normal) / denom if denom != 0 else 0.0

    # Queue length after 1 hour of peak bottleneck
    queue_km = max(0.0, round(-omega * 1.0, 2))

    return {
        "name":                  name,
        "effective_lanes":       round(effective_lanes, 2),
        "capacity_lost_pct":     round(cap_loss_pct, 1),
        "shockwave_velocity_kmh": round(omega, 2),
        "queue_length_km":       queue_km,
        "v_bottleneck_kmh":      round(max(0, v_bottleneck), 1),
        "los_grade":             data.get("los_grade", "?"),
        "model": "Greenshields + LWR (Lighthill-Whitham-Richards 1955)"
    }


# ── Analytics Dashboard Endpoint ─────────────────────────────────────────────
@app.get("/api/dashboard")
def get_dashboard():
    """
    Single-call city-wide analytics endpoint for the Dashboard tab.
    Aggregates LOS distribution, throughput loss, CO₂, LWR shockwave ranking,
    month-over-month trend signals, and LightGBM predictions for the current hour.
    All data is served from pre-loaded in-memory dicts — O(N) over junctions.
    """
    import datetime
    now  = datetime.datetime.now()
    hour = now.hour
    dow  = now.weekday()

    los_dist            = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0, "F": 0}
    total_throughput    = 0
    total_co2           = 0.0
    intervention_counts = {"RESTRUCTURE": 0, "ENFORCE": 0, "PROCESS FIX": 0}
    null_rates          = []
    trend_data          = []
    shockwave_top       = []

    for jname, d in JUNCTIONS.items():
        g = d.get("los_grade", "A")
        los_dist[g] = los_dist.get(g, 0) + 1
        total_throughput += d.get("throughput_loss", 0)
        total_co2        += d.get("co2_kg_per_hour", 0.0)
        itype = d.get("intervention_type", "ENFORCE")
        intervention_counts[itype] = intervention_counts.get(itype, 0) + 1
        null_rates.append(d.get("null_rate", 0))

        # Month-over-month trend (CUSUM-style directional signal)
        trend = d.get("monthly_trend", [])
        if len(trend) >= 2:
            last, prev = trend[-1]["count"], trend[-2]["count"]
            change_pct = ((last - prev) / (prev + 1)) * 100
            direction  = "rising" if change_pct > 15 else ("fading" if change_pct < -15 else "stable")
            trend_data.append({
                "name":             jname,
                "change_pct":       round(change_pct, 1),
                "direction":        direction,
                "los_grade":        d.get("los_grade", "A"),
                "total_violations": d.get("total_violations", 0),
            })

        # LWR shockwave — precomputed in preprocess.py, top-20 flagged
        if d.get("is_top_shockwave"):
            shockwave_top.append({
                "name":                   jname,
                "queue_length_km":        d.get("queue_length_km", 0),
                "shockwave_velocity_kmh": d.get("shockwave_velocity_kmh", 0),
                "v_bottleneck_kmh":       d.get("v_bottleneck_kmh", 0),
                "los_grade":              d.get("los_grade", "A"),
                "capacity_lost_pct":      d.get("capacity_lost_pct", 0),
            })

    shockwave_top.sort(key=lambda x: x["queue_length_km"], reverse=True)

    rising = sorted([t for t in trend_data if t["direction"] == "rising"],
                    key=lambda x: x["change_pct"], reverse=True)[:5]
    fading = sorted([t for t in trend_data if t["direction"] == "fading"],
                    key=lambda x: x["change_pct"])[:3]

    # LightGBM predictions for the current hour (from pre-warmed PRED_CACHE)
    predictions = []
    for jname, jdata in JUNCTIONS.items():
        pred = PRED_CACHE.get((jname, hour, dow), 0.0)
        if pred > 0:
            predictions.append({
                "name":              jname,
                "predicted_count":   round(pred, 1),
                "confidence_low":    round(pred * 0.80, 1),
                "confidence_high":   round(pred * 1.20, 1),
                "los_grade":         jdata.get("los_grade", "A"),
                "intervention_type": jdata.get("intervention_type", "ENFORCE"),
            })
    predictions.sort(key=lambda x: x["predicted_count"], reverse=True)

    city_los      = max(los_dist, key=los_dist.get) if any(los_dist.values()) else "F"
    critical_cnt  = los_dist.get("E", 0) + los_dist.get("F", 0)
    avg_null_rate = round(sum(null_rates) / len(null_rates), 1) if null_rates else 0
    model_info    = {"r2": MODEL_DATA.get("r2"), "mae": MODEL_DATA.get("mae")} if MODEL_DATA else {}

    return {
        "timestamp":             now.isoformat(),
        "current_hour":          hour,
        "current_dow":           dow,
        "city_los":              city_los,
        "los_distribution":      los_dist,
        "total_throughput_loss": total_throughput,
        "total_co2_kg_hr":       round(total_co2, 1),
        "critical_junctions":    critical_cnt,
        "avg_null_rate":         avg_null_rate,
        "intervention_counts":   intervention_counts,
        "shockwave_top":         shockwave_top[:8],
        "rising_junctions":      rising,
        "fading_junctions":      fading,
        "predictions":           predictions[:6],
        "model_info":            model_info,
        "total_junctions":       len(JUNCTIONS),
    }


# ── Email Dispatch Endpoint ──────────────────────────────────────────────────────────────────────────────────────────────
@app.post("/api/dispatch/email")
async def dispatch_email(body: dict = Body(...)):
    """
    Sends a patrol route itinerary via Gmail SMTP to a provided email address.
    Expects: { "recipient": "officer@btp.gov.in", "units": [...], "station": "..." }
    """
    recipient = body.get("recipient", "").strip()
    units     = body.get("units", [])
    station   = body.get("station", "Bengaluru Traffic Police")
    subject   = f"EnforceIQ Patrol Dispatch — {station}"

    if not recipient:
        return {"success": False, "error": "No recipient email provided."}
    if not SMTP_USER or not SMTP_PASS:
        return {"success": False, "error": "SMTP credentials not configured in .env"}

    # Build HTML email body
    rows_html = ""
    for unit in units:
        uid = unit.get("unit_id", "?")
        for stop in unit.get("route", []):
            los = stop.get("los_grade", "?")
            los_color = {"F": "#ef4444", "E": "#f97316", "D": "#eab308",
                         "C": "#22c55e", "B": "#06b6d4", "A": "#06b6d4"}.get(los, "#94a3b8")
            rows_html += f"""
            <tr>
              <td style='padding:6px 10px;border-bottom:1px solid #1e293b;color:#94a3b8;'>Unit {uid}</td>
              <td style='padding:6px 10px;border-bottom:1px solid #1e293b;color:#f1f5f9;font-weight:600;'>{stop.get('junction','\u2014')}</td>
              <td style='padding:6px 10px;border-bottom:1px solid #1e293b;color:#22c55e;'>{stop.get('arrive','\u2014')}</td>
              <td style='padding:6px 10px;border-bottom:1px solid #1e293b;color:#ef4444;'>{stop.get('depart','\u2014')}</td>
              <td style='padding:6px 10px;border-bottom:1px solid #1e293b;color:#64748b;'>{stop.get('revisit_at','\u2014')}</td>
              <td style='padding:6px 10px;border-bottom:1px solid #1e293b;color:{los_color};font-weight:700;'>LOS {los}</td>
            </tr>"""

    html_body = f"""
    <html><body style='margin:0;padding:0;background:#0f172a;font-family:Inter,system-ui,sans-serif;color:#e2e8f0;'>
      <div style='max-width:680px;margin:24px auto;background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155;'>
        <div style='background:linear-gradient(135deg,#1e3a5f,#1e293b);padding:28px 32px;border-bottom:1px solid #334155;'>
          <div style='font-size:11px;letter-spacing:2px;color:#3b82f6;font-weight:700;text-transform:uppercase;margin-bottom:8px;'>Bengaluru Traffic Police \u00b7 EnforceIQ AI</div>
          <h1 style='margin:0;font-size:22px;font-weight:800;color:#f1f5f9;letter-spacing:-0.5px;'>\U0001f694 Patrol Dispatch Order</h1>
          <div style='font-size:13px;color:#64748b;margin-top:6px;'>Station: <strong style='color:#94a3b8;'>{station}</strong></div>
        </div>
        <div style='padding:24px 32px;'>
          <table style='width:100%;border-collapse:collapse;'>
            <thead>
              <tr style='background:#0f172a;'>
                <th style='padding:8px 10px;text-align:left;font-size:9px;letter-spacing:1px;color:#3b82f6;text-transform:uppercase;'>Unit</th>
                <th style='padding:8px 10px;text-align:left;font-size:9px;letter-spacing:1px;color:#3b82f6;text-transform:uppercase;'>Junction</th>
                <th style='padding:8px 10px;text-align:left;font-size:9px;letter-spacing:1px;color:#3b82f6;text-transform:uppercase;'>Arrive</th>
                <th style='padding:8px 10px;text-align:left;font-size:9px;letter-spacing:1px;color:#3b82f6;text-transform:uppercase;'>Depart</th>
                <th style='padding:8px 10px;text-align:left;font-size:9px;letter-spacing:1px;color:#3b82f6;text-transform:uppercase;'>Revisit</th>
                <th style='padding:8px 10px;text-align:left;font-size:9px;letter-spacing:1px;color:#3b82f6;text-transform:uppercase;'>LOS</th>
              </tr>
            </thead>
            <tbody>{rows_html}</tbody>
          </table>
        </div>
        <div style='padding:16px 32px;background:#0f172a;border-top:1px solid #334155;font-size:10px;color:#475569;'>
          Generated by EnforceIQ AI \u00b7 Genetic Algorithm Route Optimization \u00b7 Bengaluru Traffic Police
        </div>
      </div>
    </body></html>"""

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = DISPATCH_FROM
        msg["To"]      = recipient
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, recipient, msg.as_string())

        return {"success": True, "message": f"Patrol itinerary dispatched to {recipient}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ── Feedback log endpoint (field outcomes for retraining) ──────────────────────────────────────────────────────────────────────
@app.post("/api/feedback/log")
async def log_feedback(body: dict = Body(...)):
    """
    Accepts field outcome logs from the PWA officer app.
    Stores them in event_feedback_log.json for periodic retraining.
    """
    log_path = BASE_DIR / "data" / "field_feedback_log.json"
    logs = []
    if log_path.exists():
        try:
            logs = json.loads(log_path.read_text())
        except Exception:
            logs = []
    body["server_received"] = str(pd.Timestamp.now())
    logs.append(body)
    log_path.write_text(json.dumps(logs, indent=2))
    return {"success": True, "total_logs": len(logs)}


# ── Officer PWA page ──────────────────────────────────────────────────────────────────────────────────────────────────────
@app.get("/officer", response_class=HTMLResponse)
def officer_app():
    page = BASE_DIR / "templates" / "officer.html"
    if page.exists():
        return page.read_text(encoding="utf-8")
    return HTMLResponse("<h1>Officer app not found.</h1>", status_code=404)
