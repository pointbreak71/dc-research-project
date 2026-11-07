"""Plot expected NPV profit vs onsite turbine capacity for each offer (outputs/g_sweep.png)."""

from pathlib import Path
import csv

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"

SERIES = {"K1": ("K1 Firm (late)", "#2a78d6"), "K2": ("K2 Flexible (early)", "#eb6834")}
INK, MUTED, GRID = "#1f1f1e", "#6b6a64", "#e4e3de"

rows = list(csv.DictReader(open(OUT / "g_sweep.csv")))
summary = {r["offer"]: r for r in csv.DictReader(open(OUT / "offer_summary.csv"))}

fig, ax = plt.subplots(figsize=(7.0, 3.9), dpi=200)
for k, (label, color) in SERIES.items():
    pts = sorted((float(r["G_MW"]), float(r["expected_profit"]) / 1e9) for r in rows if r["offer"] == k)
    xs, ys = zip(*pts)
    ax.plot(xs, ys, color=color, lw=2, solid_capstyle="round")
    gs, ps = float(summary[k]["G_MW"]), float(summary[k]["expected_profit"]) / 1e9
    ax.scatter([gs], [ps], s=60, color=color, edgecolor="white", linewidth=2, zorder=3)
    ax.annotate(
        f"{label}\noptimum G = {gs:.0f} MW, ${ps:.2f}bn",
        (gs, ps), xytext=(gs + 8, ps + (0.25 if k == "K2" else -0.75)),
        fontsize=8, color=INK, va="bottom",
    )

ax.set_xlabel("Onsite gas-turbine capacity G (MW)", fontsize=9, color=MUTED)
ax.set_ylabel("Expected NPV profit (USD bn)", fontsize=9, color=MUTED)
ax.set_xlim(0, 250)
ax.set_ylim(6.5, 12.0)
ax.grid(axis="y", color=GRID, lw=0.8)
ax.set_axisbelow(True)
for side in ("top", "right"):
    ax.spines[side].set_visible(False)
for side in ("left", "bottom"):
    ax.spines[side].set_color(GRID)
ax.tick_params(colors=MUTED, labelsize=8, length=0)
fig.tight_layout()
fig.savefig(OUT / "g_sweep.png", facecolor="white")
print("wrote", OUT / "g_sweep.png")
