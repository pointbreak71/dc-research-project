"""Re-solve the base case with different grid connection years (what-if runs).

Usage: julia --project=. scripts/solve_variant.jl <tag>:<ycon_K1>:<ycon_K2> [...]
  e.g. scripts/solve_variant.jl swapped:1:4 both_year1:1:1
Everything except the offers' connection years is the base case in data/.
Results go to outputs/variant_<tag>/.
"""

include(joinpath(@__DIR__, "..", "src", "model.jl"))
using CSV, DataFrames, JuMP, Printf

function run_variant(tag, y1, y2)
    d = load_case()
    d.ycon["K1"], d.ycon["K2"] = y1, y2
    out = joinpath(ROOT, "outputs", "variant_$tag")
    mkpath(out)
    println("\n================ $tag: K1 connects year $y1, K2 connects year $y2 ================")
    println("Year groups: ", [ys for (_, ys, _) in year_groups(d)])

    rows = NamedTuple[]
    for k in d.K
        m = solve!(build_model(d; fix_offer = k))
        G, obj = value(m[:G]), objective_value(m)
        br, ops = npv_breakdown(d, m), operations_summary(d, m)
        CSV.write(joinpath(out, "npv_$k.csv"), br)
        CSV.write(joinpath(out, "operations_$k.csv"), ops)
        # Marginal value of the first 10 MW of plant (NPV change per MW).
        obj10 = objective_value(solve!(build_model(d; fix_offer = k, fix_G = G + 10.0)))
        ex(c) = sum(br.p .* br[!, c])
        push!(rows, (
            offer = k, ycon = d.ycon[k], G_MW = G, expected_profit = obj,
            profit_S1 = br.profit[1], profit_S2 = br.profit[2], profit_S3 = br.profit[3],
            revenue = ex(:revenue), drop_penalty = ex(:drop_penalty), overdue_penalty = ex(:overdue_penalty),
            fuel = ex(:fuel), grid_energy = ex(:grid_energy), plant_capex_fom = br.turbine_capex_fom[1],
            fixed_charges = br.fixed_charges[1], upfront = br.upfront[1],
            npv_per_MW_next10 = (obj10 - obj) / 10,
        ))
        @printf("  %s: G* = %.1f MW  E[profit] = USD %.1f m  (next 10 MW: %+.2f m NPV per MW)\n",
            k, G, obj / 1e6, (obj10 - obj) / 10 / 1e6)
        show(select(ops, :scenario, :years, :served_U_pct, :served_D_pct, :dropped_U_GPUh, :gen_GWh, :grid_GWh, :turbine_cf_pct);
            allrows = true, summary = false, eltypes = false)
        println()
    end
    summary = DataFrame(rows)
    CSV.write(joinpath(out, "offer_summary.csv"), summary)

    mm = solve!(build_model(d))
    @printf("  MILP: offer = %s  G = %.1f MW  E[profit] = USD %.1f m\n", offer_choice(mm), value(mm[:G]), objective_value(mm) / 1e6)

    ws = DataFrame([(scenario = w, offer = k, G_MW = value(m[:G]), profit = objective_value(m))
                    for w in d.W for k in d.K for m in (solve!(build_model(d; fix_offer = k, scenarios = [w])),)])
    CSV.write(joinpath(out, "wait_and_see.csv"), ws)
    println("  Best plan per scenario if known in advance:")
    for w in d.W
        sub = ws[ws.scenario .== w, :]
        i = argmax(sub.profit)
        @printf("    %s: %s, G = %.1f MW (K1 %.1f m vs K2 %.1f m)\n", w, sub.offer[i], sub.G_MW[i],
            sub.profit[sub.offer .== "K1"][1] / 1e6, sub.profit[sub.offer .== "K2"][1] / 1e6)
    end
    return summary
end

for arg in ARGS
    tag, a, b = split(arg, ":")
    run_variant(String(tag), parse(Int, a), parse(Int, b))
end
