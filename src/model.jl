"""Two-stage stochastic hyperscaler power model ("15.S09 proposal", sections 1–5).

Stage 1: offer z_k (binary, one of K1/K2) and turbine capacity 0 ≤ G ≤ Gmax.
Stage 2: per scenario ω, year y, hour t: work x/u/o by class, turbine output g,
grid imports q_k, and powered-down idle GPUs s (see note on C6 below).

Implementation notes (all exact reformulations unless flagged):
  * Cumulative served work S_{j,ω,y,t} = Σ_{τ≤t in block} (x + u) is carried as a
    variable so (C1), (C2), (C4) stay sparse.
  * Years with the same (connection state of every offer, turbine availability, θ_ω,y)
    have identical operating problems, so they are solved once and weighted by the sum
    of their discount factors. `aggregate_years = false` builds all 15 years.
  * (C6) MODELLING CHOICE: as written, idle GPUs always draw e0, which makes the model
    infeasible whenever no power source exists (K1 before year 4 with small G; K2 during
    a 100% curtailment with small G). We let the operator power down idle GPUs (s) only
    in hours when the signed offer's grid supply is unavailable — not yet connected, or
    curtailed — i.e. s ≤ C · Σ_k z_k · min(1, E_k,t + 1 − a_k,y). In normal hours idle
    GPUs draw e0 exactly as in the proposal.
  * (C8) ramp limits are omitted: the proposal says they do not bind at hourly resolution.
"""

using CSV, DataFrames, Gurobi, JuMP

const ROOT = dirname(@__DIR__)
const GRB_ENV = Ref{Gurobi.Env}()
grb_env() = (isassigned(GRB_ENV) || (GRB_ENV[] = Gurobi.Env()); GRB_ENV[])

Base.@kwdef mutable struct CaseData
    K::Vector{String}
    J::Vector{String}
    JU::Vector{String}
    W::Vector{String}
    Y::Vector{Int}
    T::Vector{Int}
    block::Dict{Int,Int}
    first_of_block::Dict{Int,Bool}
    last_of_block::Dict{Int,Bool}
    hour_in_block::Dict{Int,Int}
    wt::Dict{Int,Float64}
    alpha::Dict{Int,Float64}
    lambda::Dict{Tuple{String,Int},Float64}
    E::Dict{Tuple{String,Int},Float64}
    A::Dict{Tuple{String,String,Int},Float64}
    cumA::Dict{Tuple{String,String,Int},Float64}   # within-block cumulative arrivals
    p::Dict{String,Float64}
    theta::Dict{Tuple{String,Int},Float64}
    delta::Dict{Int,Float64}
    D::Dict{String,Int}
    r::Dict{String,Float64}
    rho::Dict{String,Float64}
    phi::Dict{String,Float64}
    C::Float64
    e::Float64
    e0::Float64
    PUE::Float64
    IG::Float64
    cG::Float64
    yG::Int
    Gmax::Float64
    ycon::Dict{String,Int}
    P::Dict{String,Float64}
    F::Dict{String,Float64}
    U::Dict{String,Float64}
end

a(d::CaseData, k, y) = y >= d.ycon[k] ? 1.0 : 0.0
gen_ready(d::CaseData, y) = y >= d.yG ? 1.0 : 0.0

function load_case(datadir = joinpath(ROOT, "data"))
    rd(f) = CSV.read(joinpath(datadir, f), DataFrame)
    par = Dict(String(r.name) => Float64(r.value) for r in eachrow(rd("parameters.csv")))
    cls, scen, th, off = rd("classes.csv"), rd("scenarios.csv"), rd("theta_by_year.csv"), rd("offers.csv")
    hrs, cur, arr = rd("hours.csv"), rd("curtailment.csv"), rd("arrivals.csv")

    T = Int.(hrs.t)
    blk = Dict(Int(r.t) => Int(r.block) for r in eachrow(hrs))
    hib = Dict(Int(r.t) => Int(r.hour_in_block) for r in eachrow(hrs))
    nb = Int(par["hours_per_block"])
    J = String.(cls.j)
    W = String.(scen.w)
    Y = collect(1:Int(par["n_years"]))
    A = Dict((String(r.j), String(r.w), Int(r.t)) => Float64(r.A) for r in eachrow(arr))
    cumA = Dict{Tuple{String,String,Int},Float64}()
    for j in J, w in W
        run = 0.0
        for t in T
            hib[t] == 1 && (run = 0.0)
            run += A[j, w, t]
            cumA[j, w, t] = run
        end
    end
    K = String.(off.k)
    lam = Dict((k, Int(r.t)) => Float64(r.lambda) for k in K for r in eachrow(hrs))

    return CaseData(
        K = K, J = J, JU = String.(cls.j[cls.urgent]), W = W, Y = Y, T = T,
        block = blk,
        first_of_block = Dict(t => hib[t] == 1 for t in T),
        last_of_block = Dict(t => hib[t] == nb for t in T),
        hour_in_block = hib,
        wt = Dict(Int(r.t) => Float64(r.w) for r in eachrow(hrs)),
        alpha = Dict(Int(r.t) => Float64(r.alpha) for r in eachrow(hrs)),
        lambda = lam,
        E = Dict((String(r.k), Int(r.t)) => Float64(r.E) for r in eachrow(cur)),
        A = A, cumA = cumA,
        p = Dict(String(r.w) => Float64(r.p) for r in eachrow(scen)),
        theta = Dict((String(r.w), Int(r.y)) => Float64(r.theta) for r in eachrow(th)),
        delta = Dict(y => 1 / (1 + par["WACC"])^y for y in Y),
        D = Dict(String(r.j) => Int(r.deadline_h) for r in eachrow(cls)),
        r = Dict(String(r.j) => Float64(r.r) for r in eachrow(cls)),
        rho = Dict(String(r.j) => Float64(r.rho) for r in eachrow(cls)),
        phi = Dict(String(r.j) => Float64(r.phi) for r in eachrow(cls)),
        C = par["C"], e = par["e"], e0 = par["e0"], PUE = par["PUE"],
        IG = par["IG"], cG = par["cG"], yG = Int(par["yG"]), Gmax = par["Gmax"],
        ycon = Dict(String(r.k) => Int(r.ycon) for r in eachrow(off)),
        P = Dict(String(r.k) => Float64(r.P) for r in eachrow(off)),
        F = Dict(String(r.k) => Float64(r.F) for r in eachrow(off)),
        U = Dict(String(r.k) => Float64(r.U) for r in eachrow(off)),
    )
end

"""Group years with identical operating problems. Returns rep-year => (years, Σδ)."""
function year_groups(d::CaseData; aggregate = true)
    aggregate || return [(y, [y], d.delta[y]) for y in d.Y]
    sig(y) = (Tuple(a(d, k, y) for k in d.K), gen_ready(d, y), Tuple(d.theta[w, y] for w in d.W))
    groups = Dict{Any,Vector{Int}}()
    for y in d.Y
        push!(get!(groups, sig(y), Int[]), y)
    end
    out = [(minimum(ys), ys, sum(d.delta[y] for y in ys)) for ys in values(groups)]
    return sort(out; by = first)
end

"""
Build the extensive form. Keywords:
  fix_offer  — force z[k] = 1 (per-offer solve, a pure LP in G)
  fix_G      — fix turbine capacity (operating-model tests, G sweeps, VSS evaluation)
  scenarios  — subset of Ω (probabilities are renormalised)
  theta_override — Dict(w => θ) to replace θ_ω,y in every year (used for the EV problem)
"""
function build_model(
    d::CaseData;
    fix_offer = nothing,
    fix_G = nothing,
    scenarios = nothing,
    aggregate_years = true,
    theta_override = nothing,
    silent = true,
)
    W = scenarios === nothing ? d.W : scenarios
    pw = Dict(w => d.p[w] / sum(d.p[v] for v in W) for w in W)
    θ(w, y) = theta_override === nothing ? d.theta[w, y] : theta_override[w]
    YG = year_groups(d; aggregate = aggregate_years)
    Yr = [g[1] for g in YG]
    Δ = Dict(g[1] => g[3] for g in YG)
    T, J, K = d.T, d.J, d.K

    m = Model(() -> Gurobi.Optimizer(grb_env()))
    silent && set_silent(m)

    @variable(m, z[K], Bin)
    @variable(m, 0 <= G <= d.Gmax)
    @variable(m, x[J, W, Yr, T] >= 0)
    @variable(m, u[J, W, Yr, T] >= 0)
    @variable(m, o[J, W, Yr, T] >= 0)
    @variable(m, S[J, W, Yr, T] >= 0)
    @variable(m, g[W, Yr, T] >= 0)
    @variable(m, q[K, W, Yr, T] >= 0)
    @variable(m, s[W, Yr, T] >= 0)

    @constraint(m, sum(z[k] for k in K) == 1)                       # stage-1
    if fix_offer !== nothing
        for k in K
            fix(z[k], k == fix_offer ? 1.0 : 0.0; force = true)
        end
    end
    fix_G === nothing || fix(G, fix_G; force = true)

    for w in W, y in Yr, t in T
        for j in J
            prev = d.first_of_block[t] ? 0.0 : S[j, w, y, t-1]
            @constraint(m, S[j, w, y, t] == prev + x[j, w, y, t] + u[j, w, y, t])
            @constraint(m, S[j, w, y, t] <= θ(w, y) * d.cumA[j, w, t])                   # C1
            hd = d.hour_in_block[t] - d.D[j]
            if hd >= 1                                                                   # C2
                @constraint(m, S[j, w, y, t] + o[j, w, y, t] >= θ(w, y) * d.cumA[j, w, t-d.D[j]])
            end
            j in d.JU && fix(o[j, w, y, t], 0.0; force = true)                          # C3
            d.last_of_block[t] && @constraint(m, S[j, w, y, t] == θ(w, y) * d.cumA[j, w, t])  # C4
        end
        busy = sum(x[j, w, y, t] for j in J)
        @constraint(m, busy + s[w, y, t] <= d.C)                                         # C5
        # power-down allowance (only when the signed offer's grid is unavailable)
        @constraint(m, s[w, y, t] <= d.C * sum(min(1.0, d.E[k, t] + 1 - a(d, k, y)) * z[k] for k in K))
        @constraint(m,                                                                   # C6
            d.PUE * (d.e * busy + d.e0 * (d.C - busy - s[w, y, t])) ==
            g[w, y, t] + sum(q[k, w, y, t] for k in K))
        @constraint(m, g[w, y, t] <= d.alpha[t] * gen_ready(d, y) * G)                  # C7
        for k in K                                                                       # C9
            @constraint(m, q[k, w, y, t] <= d.P[k] * (1 - d.E[k, t]) * a(d, k, y) * z[k])
        end
    end

    op(w, y) = sum(
        d.wt[t] * (
            sum(d.r[j] * x[j, w, y, t] - d.rho[j] * o[j, w, y, t] - d.phi[j] * u[j, w, y, t] for j in J) -
            d.cG * g[w, y, t] - sum(d.lambda[k, t] * q[k, w, y, t] for k in K)
        ) for t in T
    )
    sumδ = sum(values(d.delta))
    first_stage = sum(d.U[k] * z[k] for k in K) + sumδ * (d.IG * G + sum(d.F[k] * z[k] for k in K))
    @objective(m, Max, sum(pw[w] * Δ[y] * op(w, y) for w in W, y in Yr) - first_stage)

    m.ext[:W] = W
    m.ext[:pw] = pw
    m.ext[:YG] = YG
    return m
end

function solve!(m)
    optimize!(m)
    termination_status(m) == OPTIMAL || error("Solve failed: $(termination_status(m))")
    return m
end

offer_choice(m) = only([string(k) for k in axes(m[:z], 1) if value(m[:z][k]) > 0.5])

"""NPV components (USD) of a solved model, per scenario and expected."""
function npv_breakdown(d::CaseData, m)
    x, u, o, g, q = m[:x], m[:u], m[:o], m[:g], m[:q]
    k = offer_choice(m)
    Gv = value(m[:G])
    sumδ = sum(values(d.delta))
    rows = NamedTuple[]
    for w in m.ext[:W]
        rev = pen_o = pen_u = fuel = grid = 0.0
        for (y, _, Δ) in m.ext[:YG], t in d.T
            wt = Δ * d.wt[t]
            rev += wt * sum(d.r[j] * value(x[j, w, y, t]) for j in d.J)
            pen_o += wt * sum(d.rho[j] * value(o[j, w, y, t]) for j in d.J)
            pen_u += wt * sum(d.phi[j] * value(u[j, w, y, t]) for j in d.J)
            fuel += wt * d.cG * value(g[w, y, t])
            grid += wt * sum(d.lambda[kk, t] * value(q[kk, w, y, t]) for kk in d.K)
        end
        push!(rows, (
            scenario = w, p = m.ext[:pw][w], revenue = rev, overdue_penalty = pen_o,
            drop_penalty = pen_u, fuel = fuel, grid_energy = grid,
            turbine_capex_fom = sumδ * d.IG * Gv, fixed_charges = sumδ * d.F[k], upfront = d.U[k],
            profit = rev - pen_o - pen_u - fuel - grid - sumδ * (d.IG * Gv + d.F[k]) - d.U[k],
        ))
    end
    return DataFrame(rows)
end

"""Physical outcomes per scenario and year-group (annual quantities)."""
function operations_summary(d::CaseData, m)
    x, u, o, g, q = m[:x], m[:u], m[:o], m[:g], m[:q]
    Gv = value(m[:G])
    rows = NamedTuple[]
    for w in m.ext[:W], (y, ys, _) in m.ext[:YG]
        ann(f) = sum(d.wt[t] * f(t) for t in d.T)
        arrived = Dict(j => ann(t -> d.theta[w, y] * d.A[j, w, t]) for j in d.J)
        genMWh = ann(t -> value(g[w, y, t]))
        push!(rows, (
            scenario = w, years = "$(minimum(ys))–$(maximum(ys))",
            served_U_pct = 100 * ann(t -> value(x["U", w, y, t])) / arrived["U"],
            served_D_pct = 100 * ann(t -> value(x["D", w, y, t])) / arrived["D"],
            dropped_U_GPUh = ann(t -> value(u["U", w, y, t])),
            dropped_D_GPUh = ann(t -> value(u["D", w, y, t])),
            overdue_D_GPUh_h = ann(t -> value(o["D", w, y, t])),
            gen_GWh = genMWh / 1e3,
            grid_GWh = ann(t -> sum(value(q[k, w, y, t]) for k in d.K)) / 1e3,
            turbine_cf_pct = Gv < 1e-6 ? 0.0 : 100 * genMWh / (Gv * 8760),
        ))
    end
    return DataFrame(rows)
end
