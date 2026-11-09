"""Write the base-case CSVs for the 15.S09 proposal model (section 7 of "15.S09 proposal").

Sourced values come from the proposal (revised 8 Nov 2026: onsite CCGT, wholesale grid prices). Anything the
proposal leaves open (hourly arrival shape, wholesale prices, which hours are hot,
which hours are curtailed) is made-up but stylised data, built here and labelled.

Time structure (proposal "model settings"):
  15-year horizon, WACC 8%, 4 seasonal representative weeks + 1 peak-stress week,
  hourly resolution -> 5 x 168 = 840 modelled hours per year.
Only offers K1 (firm, late) and K2 (flexible, early) are included; K3 (no grid) is excluded.
"""

using CSV, DataFrames

const ROOT = dirname(@__DIR__)
const DATA = joinpath(ROOT, "data")
mkpath(DATA)

const HPW = 168
const WEEKS = ["winter", "spring", "summer", "fall", "stress"]
const NB = length(WEEKS)
const NT = NB * HPW

# Weights: the stress week stands for 1 real week; the 4 seasonal weeks share the rest.
const W_STRESS = 1.0
const W_SEASON = (8760 - HPW * W_STRESS) / (4 * HPW)   # ≈ 12.786

block_of(t) = (t - 1) ÷ HPW + 1
hour_in_block(t) = (t - 1) % HPW + 1
hod(t) = (hour_in_block(t) - 1) % 24                    # 0–23
dow(t) = (hour_in_block(t) - 1) ÷ 24                    # 0–6, Mon = 0
week(t) = WEEKS[block_of(t)]
weight(t) = week(t) == "stress" ? W_STRESS : W_SEASON

# ---------------------------------------------------------------- campus (7.1)
const C = 58_800.0          # GPUs (100 MW IT ÷ 1.7 kW)
const UTIL = 0.75           # average utilisation when θ = 1
const SHARE_U = 0.60        # urgent share of volume

# ---------------------------------------------------------------- parameters.csv
params = DataFrame(
    name = String[], value = Float64[], unit = String[], source = String[],
)
function addp!(n, v, u, s)
    push!(params, (n, v, u, s))
end
addp!("C", C, "GPUs", "proposal 7.1: 100 MW / 1.7 kW")
addp!("e", 0.0017, "MW per busy GPU", "proposal 7.1: 120 kW / 72 GPUs")
addp!("e0", 0.0005, "MW per idle GPU", "proposal 7.1 assumption (~30% of busy)")
addp!("PUE", 1.15, "-", "proposal 7.1")
addp!("IG", 240_000.0, "USD/MW-yr", "proposal (Nov 8) CCGT: 2,200/kW installed, 16/kW-yr FOM")
addp!("cG", 6.226 * 3.75 + 3.40, "USD/MWh", "proposal CCGT: 6.226 MMBtu/MWh x 3.75 + 3.40 VOM")
addp!("alpha_normal", 0.95, "-", "proposal 7.2")
addp!("alpha_hot", 0.88, "-", "proposal CCGT (hottest hours)")
addp!("yG", 4.0, "year", "proposal CCGT: plant available in year 4")
addp!("Gmax", 250.0, "MW", "proposal 7.2")
addp!("WACC", 0.08, "-", "proposal model settings")
addp!("n_years", 15.0, "years", "proposal model settings")
addp!("hours_per_block", HPW, "h", "1 representative week")
params_path = joinpath(DATA, "parameters.csv")
CSV.write(params_path, params)

# ---------------------------------------------------------------- classes.csv (7.1b)
CSV.write(
    joinpath(DATA, "classes.csv"),
    DataFrame(
        j = ["U", "D"],
        name = ["Urgent inference/agentic", "Deferrable batch/training"],
        share = [SHARE_U, 1 - SHARE_U],
        deadline_h = [0, 12],
        r = [5.00, 3.50],
        rho = [0.10 * 5.00, 0.10 * 3.50],     # 10% of r per hour overdue
        phi = [0.25 * 5.00, 0.25 * 3.50],     # 25% of r on top of lost revenue
        urgent = [true, false],
    ),
)

# ---------------------------------------------------------------- scenarios.csv (7.1b)
# θ is held constant across years in the base case (theta_by_year.csv allows a path).
scen = DataFrame(
    w = ["S1", "S2", "S3"],
    name = ["Demand as expected", "Weaker demand", "Disappointing demand"],
    p = [0.5, 0.3, 0.2],
    theta = [1.0, 0.7, 0.5],
)
CSV.write(joinpath(DATA, "scenarios.csv"), scen)
CSV.write(
    joinpath(DATA, "theta_by_year.csv"),
    DataFrame(
        [(w = r.w, y = y, theta = r.theta) for r in eachrow(scen) for y in 1:15],
    ),
)

# ---------------------------------------------------------------- offers.csv (7.3, K1 & K2)
H_FLEX = 44.0   # ~0.5% of 8,760 h
CSV.write(
    joinpath(DATA, "offers.csv"),
    DataFrame(
        k = ["K1", "K2"],
        name = ["Firm (late)", "Flexible (early)"],
        ycon = [4, 1],
        P = [115.0, 115.0],
        F = [12e6, 6e6],
        U = [50e6, 20e6],
        H = [0.0, H_FLEX],
    ),
)

# ---------------------------------------------------------------- hours.csv
# Made-up wholesale prices: seasonal level + evening-peaking daily shape, weekend dip,
# scarcity pricing on 3 weekday afternoons of the stress week, and a hot-afternoon
# spike on one summer weekday. The revised proposal prices grid power at the hourly
# wholesale price with no delivery adder, so ADDER = 0 (kept as a sensitivity knob).
season_level = Dict("winter" => 40.0, "spring" => 30.0, "summer" => 42.0, "fall" => 32.0, "stress" => 55.0)
const ADDER = 0.0

function wholesale(t)
    h, d, wk = hod(t), dow(t), week(t)
    p = season_level[wk] + 15 * cos(2π * (h - 18) / 24) - (d >= 5 ? 5.0 : 0.0)
    if wk == "stress" && d in 1:3 && h in 14:19
        p += 450.0 + 120.0 * (3 - abs(h - 16.5))          # $450–$800 scarcity adder
    elseif wk == "summer" && d == 2 && h in 16:17
        p += 60.0
    end
    return p
end

hot(t) = week(t) in ("summer", "stress") && hod(t) in 12:19

lam = [wholesale(t) + ADDER for t in 1:NT]
hours = DataFrame(
    t = 1:NT,
    block = block_of.(1:NT),
    week = week.(1:NT),
    hour_in_block = hour_in_block.(1:NT),
    hod = hod.(1:NT),
    dow = dow.(1:NT),
    w = weight.(1:NT),
    lambda = lam,
    alpha = [hot(t) ? 0.88 : 0.95 for t in 1:NT],
)
CSV.write(joinpath(DATA, "hours.csv"), hours)

# ---------------------------------------------------------------- curtailment.csv
# K2 sheds 100% in the highest-stress hours (proxy: highest price) until the
# weighted annual total reaches H_k. K1 has no curtailment.
order = sortperm(lam; rev = true)
Eflex = zeros(NT)
cum = 0.0
for t in order
    global cum
    if cum + weight(t) <= H_FLEX + 1e-9
        Eflex[t] = 1.0
        cum += weight(t)
    end
end
CSV.write(
    joinpath(DATA, "curtailment.csv"),
    DataFrame(
        k = vcat(fill("K1", NT), fill("K2", NT)),
        t = vcat(1:NT, 1:NT),
        E = vcat(zeros(NT), Eflex),
    ),
)

# ---------------------------------------------------------------- arrivals.csv
# Hourly shape with a daily afternoon peak for urgent work; batch is near-flat with a
# slight night tilt. Same shape in every week and scenario (scenarios differ by θ).
# Scaled so average utilisation is 75% of C when θ = 1.
shapeU(t) = (1 + 0.35 * cos(2π * (hod(t) - 16) / 24)) * (dow(t) >= 5 ? 0.9 : 1.0)
shapeD(t) = (1 + 0.10 * cos(2π * (hod(t) - 3) / 24)) * (dow(t) >= 5 ? 1.05 : 1.0)
function scaled(shape, mean_target)
    v = [shape(t) for t in 1:NT]
    return v .* (mean_target / (sum(v) / NT))
end
AU = scaled(shapeU, UTIL * SHARE_U * C)
AD = scaled(shapeD, UTIL * (1 - SHARE_U) * C)
arr = DataFrame(j = String[], w = String[], t = Int[], A = Float64[])
for w in scen.w, t in 1:NT
    push!(arr, ("U", w, t, AU[t]))
    push!(arr, ("D", w, t, AD[t]))
end
CSV.write(joinpath(DATA, "arrivals.csv"), arr)

println("Wrote base-case CSVs to ", DATA)
println("  modelled hours = ", NT, "  Σ w_t = ", round(sum(weight, 1:NT); digits = 2))
println("  K2 curtailment: ", Int(sum(Eflex)), " modelled hours = ", round(cum; digits = 1), " h/yr")
println("  peak arrivals (θ=1): ", round(maximum(AU .+ AD)), " GPU-h/h of C = ", C)
println("  mean all-in grid price: ", round(sum(lam .* weight.(1:NT)) / 8760; digits = 1), " USD/MWh")
