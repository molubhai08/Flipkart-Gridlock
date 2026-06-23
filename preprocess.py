"""
EnforceIQ AI — Data Preprocessing Script
Run once before starting the server.

Reads the violations CSV, runs HDBSCAN geospatial clustering on all 298k
GPS points to discover data-derived hotspot zones (instead of relying on
the 168 pre-labeled police junctions), then saves all computed data as JSON.

Key upgrade vs. the previous version:
  • Previous: grouped by junction_name → only 168 police-labeled points.
  • Now:      HDBSCAN on raw lat/lon → 300–600 data-derived clusters that
              include side streets, parking lots, and underpasses with no
              junction name.  The cluster keys in junction_aggregates.json
              replace junction name strings; everything else in app.py
              reads from that file and is unaffected.
"""

import pandas as pd
import numpy as np
import json
import ast
import os
import pickle
import math
from pathlib import Path
from sklearn.model_selection import KFold
from sklearn.metrics import mean_absolute_error, r2_score
import lightgbm as lgb

# ── HDBSCAN import (pip install hdbscan) ──────────────────────────────────
try:
    import hdbscan
    HDBSCAN_AVAILABLE = True
except ImportError:
    print("⚠  hdbscan not installed — falling back to sklearn DBSCAN.")
    print("   Run:  pip install hdbscan")
    from sklearn.cluster import DBSCAN
    HDBSCAN_AVAILABLE = False

# ── paths ──────────────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent
DATA_DIR    = BASE_DIR / "data"
VIOLATIONS_CSV = BASE_DIR / "jan to may police violation_anonymized791b166.csv"

DATA_DIR.mkdir(exist_ok=True)

print("=" * 60)
print("EnforceIQ AI — Preprocessing  (HDBSCAN Clustering Edition)")
print("=" * 60)

# ── STEP 1: load & clean ───────────────────────────────────────────────────
print("\n[1/7] Loading violations CSV...")
df = pd.read_csv(VIOLATIONS_CSV, encoding="utf-8", encoding_errors="replace", low_memory=False)
print(f"      Raw records: {len(df):,}")

# parse datetime
df["created_datetime"] = pd.to_datetime(df["created_datetime"], utc=True, errors="coerce")
df = df.dropna(subset=["created_datetime"])

# time features
df["hour"]  = df["created_datetime"].dt.hour
df["dow"]   = df["created_datetime"].dt.dayofweek   # 0=Mon
df["month"] = df["created_datetime"].dt.month
df["date"]  = df["created_datetime"].dt.date.astype(str)

# drop only rejected — keep NULL (enforcement gap story)
df = df[df["validation_status"] != "rejected"].copy()
df["enforcement_gap"] = df["validation_status"].isna()

# parse violation_type JSON array
def parse_vtype(s):
    try:
        result = ast.literal_eval(str(s))
        return result if isinstance(result, list) else []
    except:
        return []

df["violation_list"] = df["violation_type"].apply(parse_vtype)

# exploded df for violation type counts
df_exploded = df.explode("violation_list").rename(columns={"violation_list": "vtype"})
df_exploded = df_exploded[df_exploded["vtype"].notna() & (df_exploded["vtype"].str.strip() != "")]

# clean coordinates — keep only Bengaluru bounding box
df["latitude"]  = pd.to_numeric(df["latitude"],  errors="coerce")
df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
df = df[df["latitude"].between(12.5, 13.5) & df["longitude"].between(77.0, 78.5)].copy()

print(f"      Clean records: {len(df):,}")

# ── STEP 2: global KPIs ────────────────────────────────────────────────────
print("\n[2/7] Computing global KPIs...")
total      = len(df)
null_count = int(df["enforcement_gap"].sum())
kpis = {
    "total_violations":       total,
    "null_validation_count":  null_count,
    "null_validation_pct":    round(null_count / total * 100, 1),
    "actions_taken":          total - null_count,
    "enforcement_efficiency": round((total - null_count) / total * 100, 1),
}
with open(DATA_DIR / "kpis.json", "w") as f:
    json.dump(kpis, f)
print(f"      Total: {total:,} | NULL rate: {kpis['null_validation_pct']}%")

# ── STEP 3: HDBSCAN geospatial clustering ──────────────────────────────────
print("\n[3/7] Running HDBSCAN on GPS coordinates...")
print("      This discovers data-derived hotspot clusters from raw lat/lon,")
print("      not limited to 168 pre-labeled police junctions.")

# Haversine metric requires coordinates in radians
coords_rad = np.radians(df[["latitude", "longitude"]].values)

# ── Clustering parameters ──────────────────────────────────────────────────
# min_cluster_size=50  → a cluster must have at least 50 violations
# min_samples=5        → core-point density (controls noise rejection)
# cluster_selection_epsilon: haversine metric uses radians.
#   Earth radius = 6,371 km → 1 radian = 6,371 km
#   150 m = 0.150 km / 6371 km = 0.0000235 radians  (≈ 0.000024)
#   Setting to 0.0 disables forced merging; HDBSCAN uses its own
#   condensed-tree logic which gives finer clusters on dense urban data.
# metric='haversine'   → true spherical distance (not Euclidean)
MIN_CLUSTER_SIZE = 50
MIN_SAMPLES      = 5
EPSILON_RAD      = 0.0   # 0.0 = let HDBSCAN's condensed tree decide merges

if HDBSCAN_AVAILABLE:
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=MIN_CLUSTER_SIZE,
        min_samples=MIN_SAMPLES,
        cluster_selection_epsilon=EPSILON_RAD,
        metric="haversine",
        core_dist_n_jobs=-1,
    )
    labels = clusterer.fit_predict(coords_rad)
else:
    # sklearn DBSCAN fallback (slower, no soft clustering)
    clusterer = DBSCAN(
        eps=EPSILON_RAD,
        min_samples=MIN_CLUSTER_SIZE,
        metric="haversine",
        n_jobs=-1,
    )
    labels = clusterer.fit_predict(coords_rad)

df["cluster_id"] = labels

# Drop noise points (label = -1)
n_noise    = int((labels == -1).sum())
n_clusters = int(labels.max()) + 1
print(f"      Clusters found: {n_clusters}")
print(f"      Noise points discarded: {n_noise:,}  ({n_noise/len(df)*100:.1f}%)")

df_clust = df[df["cluster_id"] >= 0].copy()
# Also filter the exploded df to same rows
df_exploded_clust = df_exploded[df_exploded["cluster_id"] >= 0].copy() \
    if "cluster_id" in df_exploded.columns \
    else df_exploded[df_exploded.index.isin(df_clust.index)].copy()

# Re-merge cluster_id into exploded df
df_exploded = df_exploded.merge(
    df[["cluster_id"]],
    left_index=True, right_index=True,
    how="left"
)
df_exploded_clust = df_exploded[df_exploded["cluster_id"] >= 0].copy()

print(f"      Violations in clusters: {len(df_clust):,}")

# ── STEP 3b: Build human-readable cluster names ────────────────────────────
# Strategy: for each cluster centroid, find the nearest named junction
# in the original data within 300m. If none → use "Zone_NNN · lat°N lon°E".
print("      Building human-readable cluster names...")

# Build a lookup: named junction → its median lat/lon
named_junc_df = df[
    df["junction_name"].notna() &
    (df["junction_name"].str.strip() != "") &
    (df["junction_name"].str.strip() != "No Junction")
].copy()

junc_coords = (
    named_junc_df
    .groupby("junction_name")[["latitude", "longitude"]]
    .median()
    .reset_index()
)

def haversine_km(lat1, lon1, lat2, lon2):
    """Return distance in km between two points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

MATCH_RADIUS_KM = 0.30   # 300 m

cluster_names = {}
for cid in range(n_clusters):
    grp      = df_clust[df_clust["cluster_id"] == cid]
    c_lat    = float(grp["latitude"].median())
    c_lon    = float(grp["longitude"].median())

    # Find nearest named junction
    best_name = None
    best_dist = float("inf")
    for _, row in junc_coords.iterrows():
        d = haversine_km(c_lat, c_lon, row["latitude"], row["longitude"])
        if d < best_dist:
            best_dist = d
            best_name = row["junction_name"]

    if best_dist <= MATCH_RADIUS_KM and best_name:
        # Use the junction name but suffix with cluster id to keep keys unique
        label = f"{best_name} [C{cid:03d}]"
    else:
        label = f"Zone_{cid:03d} · {c_lat:.4f}°N {c_lon:.4f}°E"

    cluster_names[cid] = label

# ── STEP 4: cluster aggregates (same schema as old junction_aggregates) ────
print("\n[4/7] Building cluster aggregates (same schema as junction_aggregates.json)...")

SEVERITY = {
    "DOUBLE PARKING":                              3.0,
    "PARKING IN A MAIN ROAD":                      2.5,
    "PARKING NEAR ROAD CROSSING":                  2.0,
    "PARKING NEAR TRAFFIC LIGHT OR ZEBRA CROSS":   2.0,
    "WRONG PARKING":                               1.5,
    "NO PARKING":                                  1.0,
    "PARKING ON FOOTPATH":                         0.8,
    "PARKING NEAR BUSTOP/SCHOOL/HOSPITAL ETC":     0.8,
}

MONTH_NAMES = {11:"Nov 23", 12:"Dec 23", 1:"Jan 24",
               2:"Feb 24",  3:"Mar 24",  4:"Apr 24"}
DOW_NAMES   = {0:"Monday",1:"Tuesday",2:"Wednesday",3:"Thursday",
               4:"Friday",5:"Saturday",6:"Sunday"}
TWO_WHEELERS = {"SCOOTER", "MOTOR CYCLE", "MOPED"}

junctions = {}   # keyed by cluster label — same variable name so later code is untouched

for cid in range(n_clusters):
    jname   = cluster_names[cid]
    grp     = df_clust[df_clust["cluster_id"] == cid]
    total_j = len(grp)

    # hourly / dow / monthly counts
    by_hour  = {str(h): int(c) for h, c in grp.groupby("hour").size().items()}
    by_dow   = {str(d): int(c) for d, c in grp.groupby("dow").size().items()}
    by_month = {str(m): int(c) for m, c in grp.groupby("month").size().items()}

    monthly_trend = [
        {"month": MONTH_NAMES.get(int(m), str(m)), "count": c}
        for m, c in sorted(by_month.items(), key=lambda x: int(x[0]))
    ]

    # violation & vehicle type counts
    vtype_counts = (
        df_exploded_clust[df_exploded_clust["cluster_id"] == cid]["vtype"]
        .value_counts().to_dict()
    )
    vtype_counts = {k: int(v) for k, v in vtype_counts.items()}

    veh_counts = {k: int(v) for k, v in grp["vehicle_type"].value_counts().items()}

    dominant_violation = max(vtype_counts, key=vtype_counts.get, default="UNKNOWN")
    dominant_vehicle   = max(veh_counts,   key=veh_counts.get,   default="UNKNOWN")

    peak_hour = int(max(by_hour, key=lambda x: by_hour[x], default="9"))
    peak_dow  = DOW_NAMES.get(
        int(max(by_dow, key=lambda x: by_dow[x], default="0")), "Monday"
    )

    null_rate = round(float(grp["enforcement_gap"].mean()) * 100, 1)

    # chronic check — low coefficient of variation across months
    monthly_vals = list(by_month.values())
    if len(monthly_vals) >= 3:
        cv = float(np.std(monthly_vals) / (np.mean(monthly_vals) + 1))
        is_chronic = cv < 0.4
    else:
        is_chronic = False

    # cluster centroid coordinates
    lat = float(grp["latitude"].median())
    lon = float(grp["longitude"].median())

    # ── LOS calculation (Karachi methodology) ──
    weighted_score = sum(
        vtype_counts.get(vt, 0) * w for vt, w in SEVERITY.items()
    )
    peak_hour_count = by_hour.get(str(peak_hour), total_j / 24)
    peak_ratio      = peak_hour_count / (total_j + 1)
    peak_weighted   = weighted_score * peak_ratio * 3

    assumed_lanes   = 3
    lane_reduction  = min(peak_weighted / 500, assumed_lanes - 0.5)
    effective_lanes = round(assumed_lanes - lane_reduction, 2)

    if   effective_lanes >= 2.7: los = "A"
    elif effective_lanes >= 2.3: los = "B"
    elif effective_lanes >= 1.8: los = "C"
    elif effective_lanes >= 1.4: los = "D"
    elif effective_lanes >= 1.0: los = "E"
    else:                        los = "F"

    throughput_loss   = int((assumed_lanes - effective_lanes) * 1800)
    capacity_lost_pct = round((assumed_lanes - effective_lanes) / assumed_lanes * 100, 1)

    # ── CO2 (Zaragoza methodology) ──
    co2_kg_per_hour = round(peak_hour_count * 4.5 * 0.066, 2)

    # ── LWR Shockwave Physics (Greenshields + Lighthill-Whitham-Richards 1955) ──
    _ff    = 50.0           # free-flow speed km/h (urban arterial)
    _kj    = 120.0          # jam density veh/km/lane
    _k_bn  = _kj * (1.0 - (effective_lanes / assumed_lanes) * 0.5)
    _v_bn  = _ff * (1.0 - _k_bn / _kj)
    _q_bn  = _k_bn * _v_bn
    _k_nm  = 30.0           # normal upstream density
    _v_nm  = _ff * (1.0 - _k_nm / _kj)
    _q_nm  = _k_nm * _v_nm
    _denom = _k_bn - _k_nm
    _omega = (_q_bn - _q_nm) / _denom if _denom != 0 else 0.0
    queue_length_km        = max(0.0, round(-_omega,  2))
    shockwave_velocity_kmh = round(_omega, 2)
    v_bottleneck_kmh       = round(max(0.0, _v_bn), 1)

    # ── intervention classification ──
    tw_count = sum(veh_counts.get(v, 0) for v in TWO_WHEELERS)
    tw_pct   = tw_count / (total_j + 1) * 100

    if is_chronic and tw_pct > 60:
        itype      = "RESTRUCTURE"
        recommend  = ("Dedicated two-wheeler parking zone required. "
                      "Patrol enforcement cannot resolve a structural "
                      "infrastructure deficit.")
        precedent  = "Washington D.C. parkDC 2019 + Zaragoza curbside study 2024"
        est_impact = "30–40% violation reduction"
    elif null_rate > 60:
        itype      = "PROCESS FIX"
        recommend  = ("Digital evidence chain required. Implement Manila STAG "
                      "protocol: photo capture, instant upload, SMS to violator.")
        precedent  = "Metro Manila STAG NCAP 2025"
        est_impact = "Eliminate 60%+ unactioned violation backlog"
    else:
        itype      = "ENFORCE"
        recommend  = ("Increase patrol frequency with calibrated revisit "
                      "intervals based on deterrence decay window.")
        precedent  = "Montreal MVTOP deterrence decay model 2024"
        est_impact = "Up to 2× violation coverage per shift"

    junctions[jname] = {
        "name":               jname,
        "cluster_id":         cid,          # new field — retained for transparency
        "lat":                lat,
        "lon":                lon,
        "total_violations":   total_j,
        "by_hour":            by_hour,
        "by_dow":             by_dow,
        "by_month":           by_month,
        "monthly_trend":      monthly_trend,
        "vtype_counts":       vtype_counts,
        "veh_counts":         veh_counts,
        "dominant_violation": dominant_violation,
        "dominant_vehicle":   dominant_vehicle,
        "peak_hour":          peak_hour,
        "peak_dow":           peak_dow,
        "null_rate":          null_rate,
        "is_chronic":         is_chronic,
        "effective_lanes":    effective_lanes,
        "los_grade":          los,
        "throughput_loss":    throughput_loss,
        "capacity_lost_pct":  capacity_lost_pct,
        "co2_kg_per_hour":        co2_kg_per_hour,
        "tw_pct":                 round(tw_pct, 1),
        "intervention_type":      itype,
        "recommendation":         recommend,
        "precedent":              precedent,
        "estimated_impact":       est_impact,
        "queue_length_km":        queue_length_km,
        "shockwave_velocity_kmh": shockwave_velocity_kmh,
        "v_bottleneck_kmh":       v_bottleneck_kmh,
        "is_top_shockwave":       False,   # updated after all clusters computed
    }

# ── Mark top-20 junctions by LWR queue length (used by dashboard API) ──
_sw_sorted = sorted(junctions.keys(),
                    key=lambda k: junctions[k].get("queue_length_km", 0),
                    reverse=True)
for _i, _k in enumerate(_sw_sorted):
    junctions[_k]["is_top_shockwave"] = (_i < 20)

with open(DATA_DIR / "junction_aggregates.json", "w") as f:
    json.dump(junctions, f)
print(f"      Clusters saved: {len(junctions)}  (was 168 named junctions)")

# ── STEP 5: deterrence decay windows ──────────────────────────────────────
print("\n[5/7] Computing deterrence decay windows (Montreal MVTOP)...")
decay_windows = {}

for cid in range(n_clusters):
    jname = cluster_names[cid]
    grp   = df_clust[df_clust["cluster_id"] == cid]
    if len(grp) < 50:
        continue
    gaps = []
    for _, day_grp in grp.groupby("date"):
        times = day_grp.sort_values("created_datetime")["created_datetime"].tolist()
        for i in range(1, len(times)):
            gap = (times[i] - times[i-1]).total_seconds() / 60
            if 5 <= gap <= 240:
                gaps.append(gap)
    if len(gaps) >= 10:
        decay_windows[jname] = int(np.median(gaps))

with open(DATA_DIR / "decay_windows.json", "w") as f:
    json.dump(decay_windows, f)
print(f"      Decay windows computed: {len(decay_windows)} clusters")

# ── STEP 6: pre-compute blended predictions (baseline) ────────────────────
print("\n[6/7] Pre-computing baseline blended predictions...")
predictions  = {}
cutoff       = df_clust["created_datetime"].max() - pd.Timedelta(days=30)
df_clust_recent = df_clust[df_clust["created_datetime"] >= cutoff]

for cid in range(n_clusters):
    jname  = cluster_names[cid]
    grp    = df_clust[df_clust["cluster_id"] == cid]
    recent = df_clust_recent[df_clust_recent["cluster_id"] == cid]

    predictions[jname] = {}
    n_days        = max(grp["date"].nunique(), 1)
    n_recent_days = max(recent["date"].nunique(), 1)

    for hour in range(24):
        predictions[jname][str(hour)] = {}
        for dow in range(7):
            full_avg   = len(grp[(grp["hour"]==hour) & (grp["dow"]==dow)]) / n_days
            recent_avg = len(recent[(recent["hour"]==hour) & (recent["dow"]==dow)]) / n_recent_days
            blended    = round(0.3 * full_avg + 0.7 * recent_avg, 3)
            predictions[jname][str(hour)][str(dow)] = blended

with open(DATA_DIR / "predictions.json", "w") as f:
    json.dump(predictions, f)
print(f"      Baseline predictions saved for {len(predictions)} clusters")

# ── STEP 6.5: heatmap data ─────────────────────────────────────────────────
print("\n      Building heatmap data...")

heatmap_cols = ["latitude", "longitude", "hour", "dow", "month", "vehicle_type"]
df_clust["primary_violation"] = df_clust["violation_list"].apply(
    lambda x: x[0] if isinstance(x, list) and len(x) > 0 else "UNKNOWN"
)
hmap = df_clust[heatmap_cols + ["primary_violation"]].copy()
hmap = hmap.rename(columns={"latitude": "lat", "longitude": "lon"})

hmap["lat"] = hmap["lat"].round(3)
hmap["lon"] = hmap["lon"].round(3)

hmap_grouped = (
    hmap.groupby(["lat", "lon", "hour", "dow", "month",
                  "vehicle_type", "primary_violation"])
    .size()
    .reset_index(name="count")
)
hmap_grouped.to_parquet(DATA_DIR / "heatmap.parquet", index=False)
print(f"      Heatmap records: {len(hmap_grouped):,}")

# save filter options
vehicle_types   = sorted(df_clust["vehicle_type"].dropna().unique().tolist())
violation_types = sorted(df_exploded_clust["vtype"].dropna().unique().tolist())
with open(DATA_DIR / "filter_options.json", "w") as f:
    json.dump({"vehicle_types": vehicle_types,
               "violation_types": violation_types}, f)

# ── STEP 7: Train LightGBM prediction model (OOF KFold) ───────────────────
print("\n[7/7] Training LightGBM prediction model (5-Fold ensemble)...")

# Build per-day training rows: (cluster_label, date, hour) → violation count
df_ml = df_clust.copy()
df_ml["date_str"] = df_ml["created_datetime"].dt.date.astype(str)

agg = (
    df_ml.groupby(["cluster_id", "date_str", "hour", "dow", "month"])
    .size()
    .reset_index(name="violation_count")
)
# attach cluster label for lookup maps
agg["junction_name"] = agg["cluster_id"].map(cluster_names)
agg = agg.sort_values(["cluster_id", "date_str", "hour"]).reset_index(drop=True)

# ── Historical lookup tables ────────────────────────────────────────────────
junc_hour_mean = (
    agg.groupby(["junction_name", "hour"])["violation_count"]
    .mean().rename("junc_hour_mean").reset_index()
)
junc_dow_mean = (
    agg.groupby(["junction_name", "dow"])["violation_count"]
    .mean().rename("junc_dow_mean").reset_index()
)
junc_hour_std = (
    agg.groupby(["junction_name", "hour"])["violation_count"]
    .std().fillna(0).rename("junc_hour_std").reset_index()
)
junc_global_mean = (
    agg.groupby("junction_name")["violation_count"]
    .mean().rename("junc_global_mean").reset_index()
)
GLOBAL_MEAN = float(agg["violation_count"].mean())

agg = agg.merge(junc_hour_mean,   on=["junction_name", "hour"], how="left")
agg = agg.merge(junc_dow_mean,    on=["junction_name", "dow"],  how="left")
agg = agg.merge(junc_hour_std,    on=["junction_name", "hour"], how="left")
agg = agg.merge(junc_global_mean, on="junction_name",            how="left")
agg["junc_hour_mean"]   = agg["junc_hour_mean"].fillna(GLOBAL_MEAN)
agg["junc_dow_mean"]    = agg["junc_dow_mean"].fillna(GLOBAL_MEAN)
agg["junc_hour_std"]    = agg["junc_hour_std"].fillna(0)
agg["junc_global_mean"] = agg["junc_global_mean"].fillna(GLOBAL_MEAN)

# ── Cluster-level scale features ────────────────────────────────────────────
total_viol_map = {jname: jdata["total_violations"] for jname, jdata in junctions.items()}
peak_hour_map  = {jname: jdata["peak_hour"]        for jname, jdata in junctions.items()}
peak_month_map = {
    jname: int(max(jdata["by_month"], key=lambda m: jdata["by_month"][m]))
    for jname, jdata in junctions.items()
    if jdata["by_month"]
}

agg["log_junction_total"] = np.log1p(
    agg["junction_name"].map(total_viol_map).fillna(0)
)

agg["hist_peak_hour"]  = agg["junction_name"].map(peak_hour_map).fillna(12).astype(int)
agg["hours_from_peak"] = (agg["hour"] - agg["hist_peak_hour"]).abs()
agg["hours_from_peak"] = agg["hours_from_peak"].apply(lambda x: min(x, 24 - x))
agg["near_peak"]       = (agg["hours_from_peak"] <= 2).astype(int)

agg["is_weekend"]       = (agg["dow"] >= 5).astype(int)
agg["is_business_hour"] = agg["hour"].apply(lambda h: 1 if 7 <= h <= 21 else 0)

# ── OOF LOO cluster mean encoding ─────────────────────────────────────────
junc_sum   = agg.groupby("junction_name")["violation_count"].transform("sum")
junc_count = agg.groupby("junction_name")["violation_count"].transform("count")
agg["junc_mean_loo"] = np.where(
    junc_count > 1,
    (junc_sum - agg["violation_count"]) / (junc_count - 1),
    GLOBAL_MEAN
)

FEATURES = [
    "hour",
    "dow",
    "month",
    "is_weekend",
    "is_business_hour",
    "near_peak",
    "log_junction_total",
    "junc_hour_mean",
    "junc_dow_mean",
    "junc_hour_std",
    "junc_global_mean",
    "junc_mean_loo",
]

X = agg[FEATURES].values.astype(np.float32)
y = agg["violation_count"].values.astype(np.float32)

# ── 5-Fold KFold training ──────────────────────────────────────────────────
N_SPLITS   = 5
kf         = KFold(n_splits=N_SPLITS, shuffle=True, random_state=42)
oof_preds  = np.zeros(len(agg))
fold_scores = []
trained_models = []

LGB_PARAMS = {
    "objective":         "regression_l2",
    "metric":            "mae",
    "verbosity":         -1,
    "n_jobs":            -1,
    "seed":              42,
    "learning_rate":     0.05,
    "num_leaves":        64,
    "max_depth":         7,
    "min_child_samples": 20,
    "feature_fraction":  0.8,
    "bagging_fraction":  0.8,
    "bagging_freq":      5,
    "lambda_l1":         0.1,
    "lambda_l2":         0.1,
}

for fold, (tr_idx, val_idx) in enumerate(kf.split(X)):
    X_tr, X_val = X[tr_idx], X[val_idx]
    y_tr, y_val = y[tr_idx], y[val_idx]

    ds_tr  = lgb.Dataset(X_tr, label=y_tr,  feature_name=FEATURES)
    ds_val = lgb.Dataset(X_val, label=y_val, reference=ds_tr, feature_name=FEATURES)

    cb = [lgb.early_stopping(50, verbose=False), lgb.log_evaluation(-1)]
    fold_model = lgb.train(
        LGB_PARAMS, ds_tr,
        num_boost_round=1000,
        valid_sets=[ds_val],
        callbacks=cb,
    )
    oof_preds[val_idx] = np.clip(fold_model.predict(X_val), 0, None)
    fold_r2  = r2_score(y_val, oof_preds[val_idx])
    fold_mae = mean_absolute_error(y_val, oof_preds[val_idx])
    fold_scores.append((fold_r2, fold_mae))
    trained_models.append(fold_model)
    print(f"      Fold {fold+1}: R²={fold_r2:.3f}  MAE={fold_mae:.3f}")

mae = float(mean_absolute_error(y, oof_preds))
r2  = float(r2_score(y, oof_preds))
print(f"      OOF MAE: {mae:.3f}  |  OOF R²: {r2:.3f}")

# Feature importance
imp_df = pd.Series(
    trained_models[-1].feature_importance(importance_type="gain"),
    index=FEATURES
).sort_values(ascending=False)
print("      Feature importances:")
for feat, imp in imp_df.items():
    bar = "#" * int(imp / imp_df.max() * 30)
    print(f"        {feat:<22} {bar}")

# ── Save model ensemble + lookup maps ─────────────────────────────────────
junc_hour_mean_dict = junc_hour_mean.set_index(["junction_name","hour"])["junc_hour_mean"].to_dict()
junc_dow_mean_dict  = junc_dow_mean.set_index(["junction_name","dow"])["junc_dow_mean"].to_dict()
junc_hour_std_dict  = junc_hour_std.set_index(["junction_name","hour"])["junc_hour_std"].to_dict()
junc_global_dict    = junc_global_mean.set_index("junction_name")["junc_global_mean"].to_dict()

model_data = {
    "models":              trained_models,
    "features":            FEATURES,
    "mae":                 round(mae, 3),
    "r2":                  round(r2, 3),
    "junction_names":      list(junctions.keys()),
    "peak_hour_map":       peak_hour_map,
    "peak_month_map":      peak_month_map,
    "log_total_map":       {k: float(np.log1p(v)) for k, v in total_viol_map.items()},
    "junc_hour_mean":      {str(k): float(v) for k, v in junc_hour_mean_dict.items()},
    "junc_dow_mean":       {str(k): float(v) for k, v in junc_dow_mean_dict.items()},
    "junc_hour_std":       {str(k): float(v) for k, v in junc_hour_std_dict.items()},
    "junc_global_mean":    {k: float(v) for k, v in junc_global_dict.items()},
    "global_mean":         GLOBAL_MEAN,
}
with open(DATA_DIR / "model.pkl", "wb") as f:
    pickle.dump(model_data, f)
print(f"      Model saved (5-fold ensemble)")

# ── Regenerate predictions.json using LightGBM ensemble ───────────────────
print("      Regenerating predictions using LightGBM ensemble...")
predictions_ml = {}

for jname in junctions.keys():
    log_tot     = model_data["log_total_map"].get(jname, 0.0)
    ph          = model_data["peak_hour_map"].get(jname, 12)
    pm          = model_data["peak_month_map"].get(jname, 1)
    junc_global = model_data["junc_global_mean"].get(jname, GLOBAL_MEAN)

    predictions_ml[jname] = {}
    for hour in range(24):
        hr_from_peak = min(abs(hour - ph), 24 - abs(hour - ph))
        near_pk      = 1 if hr_from_peak <= 2 else 0
        is_biz       = 1 if 7 <= hour <= 21 else 0
        jh_mean      = model_data["junc_hour_mean"].get(str((jname, hour)), junc_global)
        jh_std       = model_data["junc_hour_std"].get(str((jname, hour)), 0.0)

        predictions_ml[jname][str(hour)] = {}
        for dow in range(7):
            is_wknd  = 1 if dow >= 5 else 0
            jd_mean  = model_data["junc_dow_mean"].get(str((jname, dow)), junc_global)

            X_inf = np.array([[hour, dow, pm, is_wknd, is_biz,
                                near_pk, log_tot,
                                jh_mean, jd_mean, jh_std,
                                junc_global, junc_global]],
                             dtype=np.float32)

            pred = float(np.mean([
                max(0, m.predict(X_inf)[0]) for m in model_data["models"]
            ]))
            predictions_ml[jname][str(hour)][str(dow)] = round(pred, 3)

with open(DATA_DIR / "predictions.json", "w") as f:
    json.dump(predictions_ml, f)
print(f"      ML predictions saved for {len(predictions_ml)} clusters")

# Save updated KPIs with model metrics
kpis["model_mae"]  = round(mae, 3)
kpis["model_r2"]   = round(r2, 3)
kpis["model_type"] = "LightGBM 5-Fold Ensemble"
kpis["n_clusters"] = n_clusters
kpis["n_noise_pts"] = n_noise
with open(DATA_DIR / "kpis.json", "w") as f:
    json.dump(kpis, f)

# ── done ───────────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("Preprocessing complete. Files saved to enforceiq/data/")
print("=" * 60)
print(f"\n  junction_aggregates.json  — {len(junctions)} HDBSCAN clusters (was 168 named junctions)")
print(f"  decay_windows.json        — {len(decay_windows)} clusters")
print(f"  predictions.json          — {len(predictions_ml)} clusters (LightGBM)")
print(f"  model.pkl                 — LightGBM 5-fold ensemble (MAE:{mae:.3f}, R²:{r2:.3f})")
print(f"  kpis.json                 — global KPIs + model metrics")
print(f"  heatmap.parquet           — heatmap data")
print(f"  filter_options.json       — dropdown options")
print(f"\n  HDBSCAN: {n_clusters} clusters from {len(df):,} records  "
      f"({n_noise:,} noise pts discarded = {n_noise/len(df)*100:.1f}%)")

# ── quick sanity check ─────────────────────────────────────────────────────
print("\nSanity check — top 5 clusters by violations:")
top5 = sorted(junctions.items(), key=lambda x: x[1]["total_violations"], reverse=True)[:5]
for name, data in top5:
    print(f"  {data['total_violations']:>6,}  {data['los_grade']}  {data['intervention_type']:<12}  {name}")
