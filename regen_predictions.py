"""
Re-generate predictions.json using the saved 5-fold LightGBM ensemble,
now with correct per-junction peak month (instead of hardcoded month=1).
No model retraining — just re-inference from model.pkl.
"""
import pickle, json, pathlib, numpy as np

DATA = pathlib.Path("data")

with open(DATA / "model.pkl", "rb") as f:
    md = pickle.load(f)
with open(DATA / "junction_aggregates.json") as f:
    junctions = json.load(f)

GLOBAL_MEAN = md["global_mean"]
predictions_ml = {}

for jname in junctions.keys():
    log_tot     = md["log_total_map"].get(jname, 0.0)
    ph          = md["peak_hour_map"].get(jname, 12)
    pm          = md["peak_month_map"].get(jname, 1)   # per-junction peak month
    junc_global = md["junc_global_mean"].get(jname, GLOBAL_MEAN)

    predictions_ml[jname] = {}
    for hour in range(24):
        hr_from_peak = min(abs(hour - ph), 24 - abs(hour - ph))
        near_pk = 1 if hr_from_peak <= 2 else 0
        is_biz  = 1 if 7 <= hour <= 21 else 0
        jh_mean = md["junc_hour_mean"].get(str((jname, hour)), junc_global)
        jh_std  = md["junc_hour_std"].get(str((jname, hour)), 0.0)

        predictions_ml[jname][str(hour)] = {}
        for dow in range(7):
            is_wknd = 1 if dow >= 5 else 0
            jd_mean = md["junc_dow_mean"].get(str((jname, dow)), junc_global)

            X_inf = np.array([[hour, dow, pm, is_wknd, is_biz,
                                near_pk, log_tot,
                                jh_mean, jd_mean, jh_std,
                                junc_global, junc_global]], dtype=np.float32)

            pred = float(np.mean([max(0, m.predict(X_inf)[0]) for m in md["models"]]))
            predictions_ml[jname][str(hour)][str(dow)] = round(pred, 3)

with open(DATA / "predictions.json", "w") as f:
    json.dump(predictions_ml, f)

# Sanity check
j0  = list(junctions.keys())[0]
pm0 = md["peak_month_map"].get(j0, 1)
p9_0 = predictions_ml[j0]["9"]["0"]
p0_0 = predictions_ml[j0]["0"]["0"]
p9_5 = predictions_ml[j0]["9"]["5"]
print(f"Regenerated predictions.json for {len(predictions_ml)} junctions")
print(f"Sample [{j0}] peak_month={pm0}  h=9 dow=Mon: {p9_0}")
print(f"Sample [{j0}] peak_month={pm0}  h=0 dow=Mon: {p0_0}")
print(f"Sample [{j0}] peak_month={pm0}  h=9 dow=Sat: {p9_5}")
print("Done.")
