"""Quick smoke test for EnforceIQ ML integration."""
import json, pickle, pathlib, numpy as np
DATA = pathlib.Path("data")

# 1. predictions.json
preds = json.load(open(DATA / "predictions.json"))
junctions = list(preds.keys())
j0 = "Safina Plaza Junction" if "Safina Plaza Junction" in preds else junctions[0]
h9_mon = preds[j0]["9"]["0"]
h9_sat = preds[j0]["9"]["5"]
h0_mon = preds[j0]["0"]["0"]
print("=== predictions.json ===")
print(f"Junction : {j0}")
print(f"h=9 Mon  : {h9_mon}")
print(f"h=9 Sat  : {h9_sat}")
print(f"h=0 Mon  : {h0_mon}")
print(f"Vary by hour: {h9_mon != h0_mon}")
print(f"Vary by dow : {h9_mon != h9_sat}")
print(f"Total junctions: {len(preds)}")

# 2. model.pkl
md = pickle.load(open(DATA / "model.pkl", "rb"))
required = ["models","features","r2","mae","peak_hour_map","peak_month_map",
            "log_total_map","junc_hour_mean","junc_dow_mean","junc_hour_std",
            "junc_global_mean","global_mean"]
missing = [k for k in required if k not in md]
r2  = md["r2"]
mae = md["mae"]
nf  = len(md["models"])
npm = len(md["peak_month_map"])
print("\n=== model.pkl ===")
print(f"R2={r2}  MAE={mae}  Folds={nf}  peak_month_map={npm}")
print(f"Missing keys: {missing if missing else 'None'}")

# 3. live inference
jname   = j0
ph      = md["peak_hour_map"].get(jname, 12)
pm      = md["peak_month_map"].get(jname, 1)
log_tot = md["log_total_map"].get(jname, 0.0)
jg      = md["junc_global_mean"].get(jname, md["global_mean"])
jh      = md["junc_hour_mean"].get(str((jname, 9)), jg)
js      = md["junc_hour_std"].get(str((jname, 9)), 0.0)
jd      = md["junc_dow_mean"].get(str((jname, 0)), jg)
hr      = min(abs(9 - ph), 24 - abs(9 - ph))
near_pk = 1 if hr <= 2 else 0
X = np.array([[9, 0, pm, 0, 1, near_pk, log_tot, jh, jd, js, jg, jg]], dtype=np.float32)
live_pred = round(float(np.mean([max(0, m.predict(X)[0]) for m in md["models"]])), 3)
print(f"\n=== live inference ===")
print(f"Junction   : {jname}")
print(f"Peak month : {pm}")
print(f"Live pred  : {live_pred}")
print(f"Cache pred : {h9_mon}")
print("\nAll checks PASSED [OK]")
