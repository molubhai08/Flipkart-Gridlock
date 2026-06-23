"""
patch_lwr.py  — One-off migration: add LWR shockwave fields to junction_aggregates.json
Run once from the parkwatch directory: python patch_lwr.py
"""
import json
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
path     = DATA_DIR / "junction_aggregates.json"

with open(path) as f:
    junctions = json.load(f)

FF       = 50.0    # free-flow speed km/h
KJ       = 120.0   # jam density veh/km/lane
ASSUMED  = 3       # baseline lane count

for jname, d in junctions.items():
    el     = d.get("effective_lanes", float(ASSUMED))
    k_bn   = KJ * (1.0 - (el / ASSUMED) * 0.5)
    v_bn   = FF * (1.0 - k_bn / KJ)
    q_bn   = k_bn * v_bn
    k_nm   = 30.0
    v_nm   = FF * (1.0 - k_nm / KJ)
    q_nm   = k_nm * v_nm
    denom  = k_bn - k_nm
    omega  = (q_bn - q_nm) / denom if denom != 0 else 0.0
    d["queue_length_km"]        = max(0.0, round(-omega,  2))
    d["shockwave_velocity_kmh"] = round(omega, 2)
    d["v_bottleneck_kmh"]       = round(max(0.0, v_bn), 1)
    d["is_top_shockwave"]       = False   # set below

# Mark top-20 by queue length
sw_sorted = sorted(junctions.keys(),
                   key=lambda k: junctions[k]["queue_length_km"],
                   reverse=True)
for i, k in enumerate(sw_sorted):
    junctions[k]["is_top_shockwave"] = (i < 20)

with open(path, "w") as f:
    json.dump(junctions, f)

print(f"✓ Patched {len(junctions)} junctions. Top-20 shockwave flagged.")
print("Top 5 by queue length:")
for k in sw_sorted[:5]:
    print(f"  {k}: {junctions[k]['queue_length_km']} km")
