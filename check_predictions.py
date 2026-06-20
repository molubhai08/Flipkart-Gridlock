"""
EnforceIQ AI — Prediction Inspector
Run this to see what the prediction engine is outputting.
Prints results as JSON so you can verify before showing in demo.

Usage:
    python check_predictions.py
    python check_predictions.py --hour 9 --dow 0
    python check_predictions.py --hour 18 --dow 4 --top 10
"""

import json
import argparse
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

# ── load data ──────────────────────────────────────────────────────────────
with open(DATA_DIR / "predictions.json") as f:
    PREDICTIONS = json.load(f)

with open(DATA_DIR / "junction_aggregates.json") as f:
    JUNCTIONS = json.load(f)

with open(DATA_DIR / "decay_windows.json") as f:
    DECAY = json.load(f)

# ── args ───────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Inspect EnforceIQ predictions")
parser.add_argument("--hour", type=int, default=9,  help="Hour of day 0-23 (default: 9)")
parser.add_argument("--dow",  type=int, default=0,  help="Day of week 0=Mon 6=Sun (default: 0 = Monday)")
parser.add_argument("--top",  type=int, default=10, help="How many top junctions to show (default: 10)")
parser.add_argument("--junction", type=str, default=None, help="Show prediction for a specific junction name")
args = parser.parse_args()

DOW_NAMES = {0:"Monday",1:"Tuesday",2:"Wednesday",3:"Thursday",
             4:"Friday",5:"Saturday",6:"Sunday"}

# ── single junction mode ───────────────────────────────────────────────────
if args.junction:
    jname = args.junction
    jdata = JUNCTIONS.get(jname)
    if not jdata:
        # fuzzy match
        matches = [k for k in JUNCTIONS if args.junction.lower() in k.lower()]
        if matches:
            print(f"\nJunction '{args.junction}' not found exactly. Did you mean:")
            for m in matches[:5]:
                print(f"  {m}")
        else:
            print(f"Junction '{args.junction}' not found.")
        exit()

    print(f"\n{'='*60}")
    print(f"JUNCTION: {jname}")
    print(f"{'='*60}")
    print(f"Total violations (all time): {jdata['total_violations']:,}")
    print(f"LOS grade: {jdata['los_grade']}")
    print(f"Intervention: {jdata['intervention_type']}")
    print(f"Deterrence decay: {DECAY.get(jname, 'N/A')} min")
    print(f"\nPredictions by hour for {DOW_NAMES[args.dow]}:")
    print(f"{'Hour':<8} {'Predicted':>10} {'Historical avg':>15}")
    print("-" * 35)

    results = []
    for hour in range(24):
        pred = PREDICTIONS.get(jname, {}).get(str(hour), {}).get(str(args.dow), 0)
        results.append({"hour": hour, "predicted": round(pred, 3)})
        bar = "█" * int(pred * 5)
        print(f"  {hour:02d}:00  {pred:>10.3f}  {bar}")

    print(f"\nJSON output:")
    print(json.dumps({
        "junction": jname,
        "day": DOW_NAMES[args.dow],
        "predictions_by_hour": results
    }, indent=2))
    exit()

# ── top N junctions for given hour/dow ────────────────────────────────────
print(f"\n{'='*60}")
print(f"TOP {args.top} PREDICTED HOTSPOTS")
print(f"Hour: {args.hour:02d}:00  |  Day: {DOW_NAMES[args.dow]}")
print(f"{'='*60}")

scored = []
for jname, jdata in JUNCTIONS.items():
    pred = PREDICTIONS.get(jname, {}).get(str(args.hour), {}).get(str(args.dow), 0)
    if pred > 0:
        scored.append({
            "rank":              0,
            "junction":          jname,
            "predicted_count":   round(pred, 3),
            "los_grade":         jdata["los_grade"],
            "intervention_type": jdata["intervention_type"],
            "total_violations":  jdata["total_violations"],
            "peak_hour":         jdata["peak_hour"],
            "decay_minutes":     DECAY.get(jname),
            "lat":               jdata["lat"],
            "lon":               jdata["lon"],
        })

scored.sort(key=lambda x: x["predicted_count"], reverse=True)
top = scored[:args.top]

for i, item in enumerate(top):
    item["rank"] = i + 1

# ── print table ────────────────────────────────────────────────────────────
print(f"\n{'Rank':<5} {'Predicted':>10} {'LOS':>5} {'Type':<14} {'Junction'}")
print("-" * 80)
for item in top:
    decay_str = f"{item['decay_minutes']}min" if item['decay_minutes'] else "N/A"
    print(
        f"  #{item['rank']:<3} "
        f"{item['predicted_count']:>10.3f} "
        f"{item['los_grade']:>5} "
        f"{item['intervention_type']:<14} "
        f"{item['junction']}"
    )

# ── also show how predictions compare to historical peak ──────────────────
print(f"\n{'='*60}")
print("HOW PREDICTIONS COMPARE TO HISTORICAL DATA")
print(f"{'='*60}")
for item in top[:5]:
    jdata = JUNCTIONS[item["junction"]]
    total = jdata["total_violations"]
    # average violations per day at this junction
    n_days = 150  # approx 5 months
    daily_avg = total / n_days
    print(f"\n  {item['junction']}")
    print(f"    Predicted at {args.hour:02d}:00 {DOW_NAMES[args.dow]}: {item['predicted_count']:.3f} violations")
    print(f"    Historical daily average:         {daily_avg:.1f} violations/day")
    print(f"    Peak hour in data:                {jdata['peak_hour']}:00")
    print(f"    All-time total:                   {total:,}")

# ── print full JSON ────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print("FULL JSON OUTPUT (use this for display/API)")
print(f"{'='*60}")
output = {
    "query": {
        "hour":     args.hour,
        "hour_str": f"{args.hour:02d}:00",
        "dow":      args.dow,
        "dow_name": DOW_NAMES[args.dow],
    },
    "top_predictions": top
}
print(json.dumps(output, indent=2))
