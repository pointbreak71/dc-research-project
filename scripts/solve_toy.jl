"""Solve the base-case toy of the 15.S09 proposal model (offers K1 and K2 only)."""

include(joinpath(@__DIR__, "..", "src", "model.jl"))
using CSV, DataFrames, JuMP, Printf

const OUT = joinpath(ROOT, "outputs")
mkpath(OUT)

musd(v) = @sprintf("%.1f", v / 1e6)
show_df(title, df) = (println("\n=== ", title, " ==="); show(df; allrows = true, allcols = true, summary = false, eltypes = false); println())

# ------------------------------------------------------------------ checks
function sanity_checks(d)
    println("\n--- Operating-model sanity checks (scenario S1, G fixed) ---")
    curt = [t for t in d.T if d.E["K2", t] > 0.5]
    # (a) K2, G = 0: urgent work lost only in curtailment hours, deferrable work shifted.
    m = solve!(build_model(d; fix_offer = "K2", fix_G = 0.0, scenarios = ["S1"]))
    u, x = m[:u], m[:x]
    yr = first(m.ext[:YG])[1]
    dropU_c = sum(value(u["U", "S1", y, t]) for (y, _, _) in m.ext[:YG], t in curt)
    dropU = sum(value(u["U", "S1", y, t]) for (y, _, _) in m.ext[:YG], t in d.T)
    dropD = sum(value(u["D", "S1", y, t]) for (y, _, _) in m.ext[:YG], t in d.T)
    xc = sum(value(x[j, "S1", y, t]) for j in d.J, (y, _, _) in m.ext[:YG], t in curt)
    @assert xc < 1e-3 && abs(dropU - dropU_c) < 1e-3 && dropD < 1e-3
    println("  PASS  K2, G=0: no compute in curtailment hours, urgent lost only then, deferrable all shifted")
    # (b) K2, G = Gmax: nothing lost once turbines exist (year ≥ yG).
    m = solve!(build_model(d; fix_offer = "K2", fix_G = d.Gmax, scenarios = ["S1"]))
    drop = sum(value(m[:u][j, "S1", y, t]) for j in d.J, (y, _, _) in m.ext[:YG] if y >= d.yG for t in d.T)
    gen_c = sum(value(m[:g]["S1", y, t]) for (y, _, _) in m.ext[:YG] if y >= d.yG for t in curt)
    @assert drop < 1e-3 && gen_c > 0
    println("  PASS  K2, G=Gmax: turbines run in curtailment hours, nothing dropped from year $(d.yG)")
    # (c) K1, G = 0: dark in years 1–3, everything served from year 4.
    m = solve!(build_model(d; fix_offer = "K1", fix_G = 0.0, scenarios = ["S1"]))
    for (y, ys, _) in m.ext[:YG]
        served = sum(value(m[:x][j, "S1", y, t]) for j in d.J, t in d.T)
        arrived = sum(d.theta["S1", y] * d.A[j, "S1", t] for j in d.J, t in d.T)
        expect = y >= d.ycon["K1"] ? arrived : 0.0
        @assert abs(served - expect) < 1e-3 * arrived "years $ys: served $served expected $expect"
    end
    println("  PASS  K1, G=0: nothing served before year 4, everything served from year 4")
end

function aggregation_check(d)
    a = objective_value(solve!(build_model(d; fix_offer = "K2", fix_G = 50.0)))
    f = objective_value(solve!(build_model(d; fix_offer = "K2", fix_G = 50.0, aggregate_years = false)))
    @assert abs(a - f) <= 1e-6 * abs(f)
    println("  PASS  year aggregation exact: aggregated ", musd(a), " vs all 15 years ", musd(f), " (USD m)")
end

# ------------------------------------------------------------------ main
function main()
    isfile(joinpath(ROOT, "data", "arrivals.csv")) || include(joinpath(ROOT, "scripts", "generate_toy_data.jl"))
    d = load_case()
    println("Loaded: ", length(d.T), " h/yr, ", length(d.Y), " years, offers ", d.K, ", scenarios ", d.W)
    println("Year groups: ", [(ys, round(Δ; digits = 3)) for (_, ys, Δ) in year_groups(d)])

    sanity_checks(d)
    aggregation_check(d)

    # Per-offer optimum: z fixed, G free -> pure LP.
    println("\n--- Optimal plan for each offer ---")
    best = Dict{String,Any}()
    summary_rows = NamedTuple[]
    for k in d.K
        t0 = time()
        m = solve!(build_model(d; fix_offer = k))
        G = value(m[:G])
        br = npv_breakdown(d, m)
        ops = operations_summary(d, m)
        best[k] = (m = m, G = G, obj = objective_value(m), br = br, ops = ops)
        @printf("  %s: G* = %.2f MW   E[NPV profit] = USD %s m   (%.1f s)\n", k, G, musd(objective_value(m)), time() - t0)
        exp(col) = sum(br.p .* br[!, col])
        push!(summary_rows, (
            offer = k, G_MW = G, expected_profit = objective_value(m),
            profit_S1 = br.profit[1], profit_S2 = br.profit[2], profit_S3 = br.profit[3],
            revenue = exp(:revenue), overdue_penalty = exp(:overdue_penalty),
            drop_penalty = exp(:drop_penalty), fuel = exp(:fuel), grid_energy = exp(:grid_energy),
            turbine_capex_fom = br.turbine_capex_fom[1], fixed_charges = br.fixed_charges[1],
            upfront = br.upfront[1],
        ))
        show_df("$k NPV breakdown by scenario (USD)", br)
        show_df("$k operations by scenario and year group (annual)", ops)
        CSV.write(joinpath(OUT, "npv_$(k).csv"), br)
        CSV.write(joinpath(OUT, "operations_$(k).csv"), ops)
    end
    summary = DataFrame(summary_rows)
    CSV.write(joinpath(OUT, "offer_summary.csv"), summary)
    kbest = argmax(k -> best[k].obj, d.K)

    # MILP over both offers.
    mm = solve!(build_model(d))
    @printf("\nMILP check: offer = %s  G = %.2f MW  E[profit] = USD %s m  (per-offer winner: %s)\n",
        offer_choice(mm), value(mm[:G]), musd(objective_value(mm)), kbest)
    @assert offer_choice(mm) == kbest && abs(objective_value(mm) - best[kbest].obj) <= 1e-5 * abs(best[kbest].obj)

    # G sweep: expected profit as a function of turbine size, per offer.
    println("\n--- Expected profit vs turbine capacity ---")
    sweep = DataFrame(offer = String[], G_MW = Float64[], expected_profit = Float64[])
    for k in d.K, G in 0.0:10.0:d.Gmax
        push!(sweep, (k, G, objective_value(solve!(build_model(d; fix_offer = k, fix_G = G)))))
    end
    for k in d.K
        push!(sweep, (k, best[k].G, best[k].obj))
    end
    sort!(sweep, [:offer, :G_MW])
    CSV.write(joinpath(OUT, "g_sweep.csv"), sweep)
    println("  wrote g_sweep.csv (", nrow(sweep), " solves)")

    # VSS: plan on the expected θ, evaluate on all scenarios.
    θbar = sum(d.p[w] * d.theta[w, 1] for w in d.W)
    mev = solve!(build_model(d; scenarios = ["S1"], theta_override = Dict("S1" => θbar)))
    kev, Gev = offer_choice(mev), value(mev[:G])
    eev = objective_value(solve!(build_model(d; fix_offer = kev, fix_G = Gev)))
    vss = best[kbest].obj - eev
    @printf("\nVSS: EV plan (θ̄ = %.2f): %s, G = %.2f MW;  EEV = USD %s m;  RP = USD %s m;  VSS = USD %s m\n",
        θbar, kev, Gev, musd(eev), musd(best[kbest].obj), musd(vss))

    # Perfect-information plans per scenario (how much G each scenario alone would want).
    ws = NamedTuple[]
    for w in d.W, k in d.K
        mw = solve!(build_model(d; fix_offer = k, scenarios = [w]))
        push!(ws, (scenario = w, offer = k, G_MW = value(mw[:G]), profit = objective_value(mw)))
    end
    ws = DataFrame(ws)
    show_df("Best G if each scenario were known in advance", ws)
    CSV.write(joinpath(OUT, "wait_and_see.csv"), ws)

    CSV.write(joinpath(OUT, "headline.csv"), DataFrame(
        best_offer = [kbest], best_G_MW = [best[kbest].G], best_expected_profit = [best[kbest].obj],
        ev_offer = [kev], ev_G_MW = [Gev], eev = [eev], vss = [vss], theta_bar = [θbar],
    ))
    show_df("Offer summary (USD, NPV)", summary)
    println("\nWrote outputs to ", OUT)
end

main()
