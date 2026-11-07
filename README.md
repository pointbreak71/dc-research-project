# 15s09-project

Course project for MIT **15.S09 Optimization of Energy Systems** (Fall 2026): a two-stage
stochastic model of how a profit-maximising hyperscaler should secure power for a 100 MW AI
campus — firm-but-late grid service (K1), flexible-but-early curtailable service (K2), and
onsite gas turbines — under uncertain demand. Julia / JuMP + Gurobi.

## Layout

- `src/model.jl` — data loading, extensive-form model, result summaries
- `scripts/generate_toy_data.jl` — writes the base-case CSVs in `data/` (proposal §7; made-up data where the proposal leaves values open)
- `scripts/solve_toy.jl` — sanity checks, per-offer optimum, MILP cross-check, turbine-size sweep, VSS; writes `outputs/`
- `scripts/plot_g_sweep.py` — profit vs turbine capacity chart (`outputs/g_sweep.png`)
- `scripts/make_report.js` — builds `reports/toy_results.docx` from `outputs/`
- `reports/toy_results.docx` — write-up of the base-case results

## Run

```bash
julia --project=. -e 'using Pkg; Pkg.instantiate()'   # needs a Gurobi licence
julia --project=. scripts/generate_toy_data.jl
julia --project=. scripts/solve_toy.jl                # ~10 min, mostly the G sweep
python3 scripts/plot_g_sweep.py                       # needs matplotlib
npm install docx && node scripts/make_report.js       # optional: rebuild the report
```
