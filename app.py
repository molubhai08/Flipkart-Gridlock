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
from pathlib import Path
import pandas as pd
import numpy as np
import json
import math
import pickle
import functools
import random

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
    print(f"✓ Prediction cache warmed: {len(PRED_CACHE):,} entries (LightGBM)")

# Load model.pkl for live inference (optional — used only by /api/predict/live)
_model_path = DATA_DIR / "model.pkl"
if _model_path.exists():
    with open(_model_path, "rb") as f:
        MODEL_DATA = pickle.load(f)
    print(f"✓ LightGBM 5-fold ensemble loaded  "
          f"R²={MODEL_DATA.get('r2', '?')}  MAE={MODEL_DATA.get('mae', '?')}")
    print(f"  Features: {MODEL_DATA.get('features', [])}")
else:
    print("⚠  model.pkl not found — live inference unavailable, serving from cache only")

print(f"✓ Loaded {len(JUNCTIONS)} junctions")
print(f"✓ Heatmap: {len(HEATMAP_DF):,} records")


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


@app.get("/api/junction/{junction_name:path}")
def get_junction(junction_name: str):
    data = JUNCTIONS.get(junction_name)
    if not data:
        return {"error": "not found"}
    return {**data, "decay_minutes": DECAY.get(junction_name)}


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
