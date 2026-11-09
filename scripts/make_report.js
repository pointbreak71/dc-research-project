const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, WidthType, BorderStyle, ShadingType, LevelFormat, HeadingLevel,
} = require("docx");

const PROJ = path.resolve(__dirname, "..");
const OUTDOCX = path.join(PROJ, "reports", "toy_results.docx");
fs.mkdirSync(path.dirname(OUTDOCX), { recursive: true });

// ---------- data from outputs ----------
function readCsv(f) {
  const [h, ...rows] = fs.readFileSync(path.join(PROJ, "outputs", f), "utf8").trim().split("\n");
  const keys = h.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [keys[i], v])));
}
const S = Object.fromEntries(readCsv("offer_summary.csv").map((r) => [r.offer, r]));
const ops = { K1: readCsv("operations_K1.csv"), K2: readCsv("operations_K2.csv") };
const ws = readCsv("wait_and_see.csv");
const head = readCsv("headline.csv")[0];
const m = (v) => (Math.abs(Number(v)) < 5e5 ? 0 : Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });
const bn = (v) => (Number(v) / 1e9).toFixed(2);
const f1 = (v) => Number(v).toFixed(1);
const gap = Number(S.K2.expected_profit) - Number(S.K1.expected_profit);

// ---------- helpers ----------
const FONT = "Arial";
const W = 9360; // content width, US Letter with 1" margins
const border = { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const P = (text, opts = {}) =>
  new Paragraph({ spacing: { after: 120 }, ...opts, children: runs(text) });
function runs(text) {
  // **bold** markup
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((s) =>
    s.startsWith("**") ? new TextRun({ font: FONT, text: s.slice(2, -2), bold: true }) : new TextRun({ font: FONT, text: s }));
}
const B = (text) => new Paragraph({ numbering: { reference: "bul", level: 0 }, spacing: { after: 80 }, children: runs(text) });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const Cap = (t) => new Paragraph({ spacing: { before: 60, after: 200 }, children: [new TextRun({ font: FONT, text: t, italics: true, size: 18, color: "555555" })] });

function table(header, rows, widths, { firstColLeft = true } = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (txt, i, isHead) => new TableCell({
    borders,
    width: { size: widths[i], type: WidthType.DXA },
    shading: isHead ? { fill: "E8EEF6", type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: i === 0 && firstColLeft ? AlignmentType.LEFT : AlignmentType.RIGHT,
      children: [new TextRun({ font: FONT, text: String(txt), bold: isHead, size: 18 })],
    })],
  });
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, i, false)) })),
    ],
  });
}

// ---------- tables ----------
const t1 = table(
  ["Contract", "Optimal gas plant G*", "Expected NPV profit", "S1 θ=1.0 (p=0.5)", "S2 θ=0.7 (p=0.3)", "S3 θ=0.5 (p=0.2)"],
  ["K1", "K2"].map((k) => [
    k === "K1" ? "K1 Firm (late)" : "K2 Flexible (early)",
    `${f1(S[k].G_MW)} MW`, `$${bn(S[k].expected_profit)}bn`,
    `$${bn(S[k].profit_S1)}bn`, `$${bn(S[k].profit_S2)}bn`, `$${bn(S[k].profit_S3)}bn`,
  ]),
  [2060, 1460, 1540, 1440, 1430, 1430],
);

const comp = [
  ["Compute revenue", "revenue", 1],
  ["Dropped-work penalty", "drop_penalty", -1],
  ["Overdue penalty", "overdue_penalty", -1],
  ["Gas plant fuel and VOM", "fuel", -1],
  ["Grid energy", "grid_energy", -1],
  ["Gas plant capex + FOM", "turbine_capex_fom", -1],
  ["Offer fixed charges (Fk)", "fixed_charges", -1],
  ["Offer upfront cost (Uk)", "upfront", -1],
];
const t2 = table(
  ["Component (expected, USD m NPV)", "K1 Firm", "K2 Flexible", "K2 − K1"],
  [
    ...comp.map(([lab, key, sgn]) => {
      const a = sgn * Number(S.K1[key]), b = sgn * Number(S.K2[key]);
      return [lab, m(a), m(b), m(b - a)];
    }),
    ["Expected profit", m(S.K1.expected_profit), m(S.K2.expected_profit), m(gap)],
  ],
  [3960, 1800, 1800, 1800],
);

const opsRow = (k, w, yrs) => ops[k].find((r) => r.scenario === w && r.years === yrs);
const t3rows = [];
for (const [k, label] of [["K1", "K1"], ["K2", "K2"]]) {
  for (const yrs of ops[k].filter((r) => r.scenario === "S1").map((r) => r.years)) {
    const r = opsRow(k, "S1", yrs);
    const [y0, y1] = yrs.split("–");
    t3rows.push([
      `${label}, ${y0 === y1 ? "year " + y0 : "years " + yrs}`,
      `${f1(r.served_U_pct)}%`, `${f1(r.served_D_pct)}%`,
      `${(Number(r.dropped_U_GPUh) / 1e6).toFixed(2)}m`,
      Math.round(Number(r.gen_GWh)).toLocaleString(), Math.round(Number(r.grid_GWh)).toLocaleString(),
      `${Math.round(Number(r.turbine_cf_pct))}%`,
    ]);
  }
}
const t3 = table(
  ["Plan / years", "Urgent served", "Deferrable served", "Urgent dropped (GPU-h/yr)", "Plant GWh/yr", "Grid GWh/yr", "Plant CF"],
  t3rows,
  [1800, 1180, 1300, 1420, 1220, 1220, 1220],
);

const t4 = table(
  ["Scenario known in advance", "K1: best G", "K1: profit", "K2: best G", "K2: profit"],
  ["S1", "S2", "S3"].map((w) => {
    const a = ws.find((r) => r.scenario === w && r.offer === "K1");
    const b = ws.find((r) => r.scenario === w && r.offer === "K2");
    const name = { S1: "S1 Demand as expected (θ=1.0)", S2: "S2 Weaker demand (θ=0.7)", S3: "S3 Disappointing (θ=0.5)" }[w];
    return [name, `${f1(a.G_MW)} MW`, `$${bn(a.profit)}bn`, `${f1(b.G_MW)} MW`, `$${bn(b.profit)}bn`];
  }),
  [3360, 1500, 1500, 1500, 1500],
);

const t5 = table(
  ["Input", "Base-case value", "Source"],
  [
    ["Campus", "100 MW IT, C = 58,800 GPUs, e = 1.7 kW, e0 = 0.5 kW, PUE 1.15", "Proposal (PUE from §7.1)"],
    ["Workloads", "60% urgent (D = 0 h, r = $5.00), 40% deferrable (D = 12 h, r = $3.50); ρ = 10% of r per h, φ = 25% of r", "Proposal"],
    ["Scenarios", "θ = 1.0 / 0.7 / 0.5 with p = 0.5 / 0.3 / 0.2; θ constant over years", "Proposal"],
    ["Onsite gas plant", "Small CCGT: IG = $240k/MW-yr ($2,200/kW, $16/kW-yr FOM), cG = $26.75/MWh (6,226 Btu/kWh × $3.75 + $3.40), α = 0.95 (0.88 hot hours), yG = 4, Gmax = 250 MW", "Proposal"],
    ["K1 Firm", "Connects year 4, P = 115 MW, F = $12m/yr, U = $50m, no curtailment", "Proposal"],
    ["K2 Flexible", "Connects year 1, P = 115 MW, F = $6m/yr, U = $20m, 100% shed in 43.6 h/yr", "Proposal"],
    ["Horizon", "15 years, WACC 8% (Σδ = 8.56); 4 seasonal weeks + 1 stress week, hourly (840 h)", "Proposal §7 settings"],
    ["Arrival shape", "Urgent: daily peak at 16:00 (±35%), weekends −10%; deferrable near-flat. Mean utilisation 75% at θ = 1", "Made up"],
    ["Grid prices λt", "Hourly wholesale price only (no delivery adder): seasonal level + evening peak; mean $36/MWh; $450–800 scarcity on 3 stress-week afternoons", "Made up"],
    ["Curtailment Ek,t", "Highest-price hours until 44 h/yr: 18 stress-week hours + 2 summer hours (×12.8 weight)", "Made up (rule from proposal)"],
  ],
  [1700, 6060, 1600],
);

const t6 = table(
  ["", "Previous run (7 Nov)", "This run", "Main reason"],
  [
    ["K1 plan", "94 MW plant, $9.64bn", `${f1(S.K1.G_MW)} MW plant, $${bn(S.K1.expected_profit)}bn`, "Plant now arrives in year 4, so it can no longer bridge years 2–3"],
    ["K2 plan", "0 MW plant, $11.36bn", `${f1(S.K2.G_MW)} MW plant, $${bn(S.K2.expected_profit)}bn`, "Grid power is cheaper (no $12/MWh delivery adder)"],
    ["Gap K2 − K1", "$1.73bn", `$${(gap / 1e9).toFixed(2)}bn`, "K1 now loses three years of revenue, not one"],
  ],
  [1500, 2000, 2000, 3860],
);


// ---------- connection-date variants (outputs/variant_*/offer_summary.csv) ----------
const V = {
  swapped: Object.fromEntries(readCsv("variant_swapped/offer_summary.csv").map((r) => [r.offer, r])),
  both_year1: Object.fromEntries(readCsv("variant_both_year1/offer_summary.csv").map((r) => [r.offer, r])),
};
const cases = [
  ["Base case: K1 year 4, K2 year 1", S],
  ["Switched: K1 year 1, K2 year 4", V.swapped],
  ["Both connect in year 1", V.both_year1],
];
const tV = table(
  ["Case (connection year)", "Contract", "Optimal gas plant G*", "Expected NPV profit", "S1 θ=1.0 (p=0.5)", "S2 θ=0.7 (p=0.3)", "S3 θ=0.5 (p=0.2)"],
  cases.flatMap(([label, R]) => {
    const win = Number(R.K1.expected_profit) > Number(R.K2.expected_profit) ? "K1" : "K2";
    return ["K1", "K2"].map((k, i) => [
      i === 0 ? label : "",
      `${k === "K1" ? "K1 Firm" : "K2 Flexible"}${k === win ? " (best)" : ""}`,
      `${f1(R[k].G_MW)} MW`, `$${bn(R[k].expected_profit)}bn`,
      `$${bn(R[k].profit_S1)}bn`, `$${bn(R[k].profit_S2)}bn`, `$${bn(R[k].profit_S3)}bn`,
    ]);
  }),
  [2080, 1560, 1100, 1240, 1130, 1120, 1130],
);
const swapGap = Number(V.swapped.K1.expected_profit) - Number(V.swapped.K2.expected_profit);
const tieGap = Number(V.both_year1.K2.expected_profit) - Number(V.both_year1.K1.expected_profit);

// ---------- document ----------
const chart = fs.readFileSync(path.join(PROJ, "outputs", "g_sweep.png"));

const children = [
  new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Toy optimisation results: securing power for a 100 MW AI campus")] }),
  new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ font: FONT, text: "15.S09 project · base case from the revised proposal (onsite CCGT), offers K1 and K2 only · 9 November 2026", color: "555555" })] }),

  H1("Summary"),
  B(`**The flexible, early offer (K2) maximises expected profit**: $${bn(S.K2.expected_profit)}bn NPV, versus $${bn(S.K1.expected_profit)}bn for the firm, late offer (K1), a gap of $${(gap / 1e9).toFixed(2)}bn.`),
  B("**Under both contracts, profit is maximised by building no onsite gas plant.** The CCGT cannot run until year 4, the same year the firm grid connection arrives, so it cannot bridge K1's wait. After that it is worth less than its $240k/MW-yr cost under either contract."),
  B("**Under K1 the campus is dark for years 1–3**, which costs about $3.5bn of revenue and $0.9bn of dropped-work penalties. From year 4 it runs fully on the grid."),
  B("**Under K2 the campus runs from year 1** and accepts about 44 curtailment hours a year: deferrable work is shifted, and 0.7% of urgent work is lost."),
  B("**K2 wins in every demand scenario, and demand uncertainty does not change the plan**: the value of the stochastic solution is $0 in this base case."),

  H1("1. Results by contract"),
  P("Each contract was solved on its own (offer fixed, gas plant size free, a linear program), and the full model with a binary offer choice was solved as a cross-check; it picks the same plan and profit. Profit is the NPV over 15 years at 8%, net of grid and gas plant costs but not of GPU and building costs, which are the same under every plan."),
  t1,
  Cap("Table 1. Profit-maximising gas plant capacity and NPV profit for each contract. Scenario columns show the profit of that same plan if the scenario occurs."),

  H2("K1 Firm (late): wait for the grid, build nothing"),
  P("Neither the grid nor the CCGT is available before year 4, so under K1 the campus earns nothing in years 1–3 whatever is built. All work arriving in those years is lost, and the model charges the dropped-work penalty on it (see caveats). From year 4 the grid supplies the whole campus and all work is served."),
  P("A gas plant under K1 can only save on energy: it generates at $26.75/MWh, below most wholesale prices (mean $36/MWh). That saving is worth about $95k per MW in each year the plant runs (years 4–15), far below its $240k/MW-yr cost, which the proposal's objective charges in all 15 years. So K1's best plan is G = 0, and every MW built lowers profit (Figure 1)."),

  H2("K2 Flexible (early): build nothing, accept curtailment"),
  P("K2 connects in year 1 and must shed all imports in about 44 hours a year. With no gas plant, the campus runs nothing in those hours. Deferrable work is shifted to the hours that follow (none is dropped or late, because the 12-hour deadline is longer than the 6-hour events). Urgent work arriving during events is lost: about 1.6m GPU-h a year in the expected scenario, 0.7% of urgent volume, costing about $9.9m a year in revenue and penalties."),
  P("A gas plant under K2 earns in two ways from year 4: it covers urgent work during curtailment (about $120k per MW a year) and it undercuts grid prices in other hours (about $80k). The first MW is worth about $203k per MW-year of operation, below its $240k cost, so the optimum is G = 0. The plant would enter the K2 plan if installed cost fell below about $1,240/kW with the cost charged over all 15 years as in the proposal, or below about $1,840/kW if it were charged only from year 4 when the plant runs. The proposal's range is $1,400–3,000/kW."),

  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: [new ImageRun({ type: "png", data: chart, transformation: { width: 600, height: 334 } })] }),
  Cap("Figure 1. Expected NPV profit as a function of onsite gas plant capacity for each contract (each point is a separate LP with G fixed). Dots mark the optima."),

  H2("Where the gap between contracts comes from"),
  t2,
  Cap("Table 2. Expected NPV of each profit component (USD m). Negative values are costs."),
  P(`The $${(gap / 1e9).toFixed(2)}bn gap is time-to-power. K2 earns $3.49bn more revenue because it operates in years 1–3 and K1 does not, and it avoids $873m of dropped-work penalties for those years. K2's lower fixed and upfront charges add $81m. K1's only advantage is $55m lower grid energy cost, simply because it buys no power in years 1–3.`),

  H2("Operations under each plan (expected-demand scenario)"),
  t3,
  Cap("Table 3. Annual operating outcomes in scenario S1. CF = gas plant capacity factor (output ÷ G × 8,760 h); 0% because no plant is built."),

  H1("2. Does uncertainty about demand change the decision?"),
  P(`Not in this base case. Planning on the average demand level (θ̄ = ${Number(head.theta_bar).toFixed(2)}) gives the same plan, K2 with no gas plant, so the value of the stochastic solution is $0. Table 4 shows why: even with perfect foresight of the scenario, K2 with no gas plant is best in every scenario.`),
  t4,
  Cap("Table 4. Best gas plant size and profit if each scenario were known in advance."),
  P("In this toy the scenarios differ only in demand level, not in the hourly shape or workload mix, so a zero VSS is partly by construction. Scenarios that vary the urgent share or the arrival timing are the natural next test."),

  H1("3. What if the connection dates are switched?"),
  P("To separate the effect of connection timing from the contract terms, the model was re-solved with only the connection years changed: firm (K1) in year 1 and flexible (K2) in year 4, and then with both offers connecting in year 1. All other inputs are the base case, including the CCGT arriving in year 4."),
  tV,
  Cap("Table 5. Profit-maximising gas plant capacity and NPV profit for each contract under different connection years, in the same layout as Table 1. Scenario columns show the profit of that plan if the scenario occurs."),
  P(`**Switching the dates switches the winner.** With firm power in year 1, K1 wins by $${(swapGap / 1e9).toFixed(2)}bn, almost the mirror image of the base case, and in every demand scenario. K2 is now the contract that sits dark for three years. Whichever offer connects first wins; nothing else matters at that scale.`),
  P(`**With timing equal, the contracts are nearly tied.** If both connect in year 1, K2 wins by only $${(tieGap / 1e6).toFixed(0)}m (0.2% of profit). Firm service saves about $69m NPV of lost urgent revenue and penalties in curtailment hours, but costs $81m more in fixed and upfront charges and $10m more for energy, because K1 keeps buying power in the highest-price hours. Firm would win if its fixed charge fell below about $9.3m a year (from $12m), or if K2's curtailment rose above roughly 60 hours a year.`),
  P("**No gas plant in any of these cases.** Under the proposal, K1 has no curtailment, so once it is connected a plant can only save on energy (about $94k per MW a year against a $240k cost). Even with K2's 44 curtailment hours a plant does not pay; covering curtailment would need roughly 90 or more hours a year before the first MW is worth building."),

  H1("4. What changed from the previous run"),
  P("The revised proposal replaces the aeroderivative turbines with a small CCGT (cheaper to run, $26.75 vs $41/MWh, but available only from year 4 instead of year 2) and prices grid power at the wholesale price without delivery adders."),
  t6,
  Cap("Table 6. Previous (aeroderivative, year-2 turbines) vs current (CCGT, year-4 plant) results."),

  H1("5. What was modelled"),
  P("The model is the two-stage stochastic program in the proposal. Stage 1 chooses the offer z_k and gas plant capacity G. Stage 2 schedules work, dispatches the plant and buys grid power hour by hour in each scenario, subject to constraints C1–C7 and C9. Inputs follow the proposal's base case; values the proposal leaves open were made up and are marked below. PUE, the horizon and the representative weeks are not in the revised parameter tables, so they are taken from the proposal's §7."),
  t5,
  Cap("Table 7. Base-case inputs. K3 (no grid) is excluded."),

  H1("6. Modelling choices and caveats"),
  B("**Idle power during outages.** As written, C6 makes idle GPUs always draw e0, so the model is infeasible when no power source exists (K1 before year 4; K2 during a full curtailment without a plant). We let idle GPUs be powered down only in hours when the signed offer's grid supply is unavailable (not yet connected, or curtailed). In normal hours idle GPUs draw e0 as specified."),
  B("**Dark-year work is penalised.** Under K1, arrivals in years 1–3 are counted as dropped and incur the φ penalty ($887m expected). If demand simply did not exist before power, that overstates K1's loss; removing it still leaves K2 ahead by about $3.5bn."),
  B("**Charges in every year.** Following the proposal's objective, Fk and IG·G are charged in all 15 years, including K1's years before connection (about $31m of fixed charges) and the years before the plant runs. Charging the plant only from year 4 raises its break-even cost but does not change the decision at $2,200/kW."),
  B("**Plant size is continuous.** The proposal describes a ~150 MW CCGT block, but G is modelled as continuous (as in the formulation). Since the optimum is G = 0 this does not affect the result; a lumpy 150 MW block would only make building less attractive."),
  B("**Ramp limits omitted** (C8), as the proposal notes they do not bind once running. Year aggregation (years with identical operating problems are solved once: years 1–3 and 4–15) was checked against the full 15-year model and gives the same objective."),
  B("**Validation.** Expected-demand revenue is about $16.9m per MW of IT a year, matching the proposal's ~$17m estimate. Operating-model checks passed: with no plant K2 runs nothing in curtailment hours and loses only urgent work then; with Gmax of plant nothing is lost from year 4; K1 with no plant serves nothing before year 4 and everything after."),

  H1("7. Next steps"),
  B("Find the thresholds the proposal asks for: sweep the firm connection year (1–6) to locate exactly where K1 overtakes K2, and the curtailment hours (0–500 h/yr), revenue per MW ($5–20m) and the plant's installed cost and lead time."),
  B("Scenarios that vary the workload mix and arrival timing, not just the level, so that the value of the stochastic solution can be non-zero."),
  B("Replace made-up prices and curtailment hours with PJM wholesale prices and highest-load hours, as planned in the proposal's data section."),
  P("Reproduce: julia --project=. scripts/generate_toy_data.jl; julia --project=. scripts/solve_toy.jl; python3 scripts/plot_g_sweep.py; node scripts/make_report.js. Results are written to outputs/.", { spacing: { before: 200 } }),
];

const doc = new Document({
  creator: "Max Glanville",
  title: "Toy optimisation results",
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 36, bold: true }, paragraph: { spacing: { before: 0, after: 80 }, keepNext: true } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 28, bold: true, color: "1F3864" }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 23, bold: true }, paragraph: { spacing: { before: 220, after: 100 }, keepNext: true, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [{ reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUTDOCX, buf); console.log("wrote", OUTDOCX); });
