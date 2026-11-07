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
  ["Contract", "Optimal turbines G*", "Expected NPV profit", "S1 θ=1.0 (p=0.5)", "S2 θ=0.7 (p=0.3)", "S3 θ=0.5 (p=0.2)"],
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
  ["Turbine fuel and VOM", "fuel", -1],
  ["Grid energy", "grid_energy", -1],
  ["Turbine capex + FOM", "turbine_capex_fom", -1],
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
  for (const yrs of ["1–1", "2–3", "4–15"]) {
    const r = opsRow(k, "S1", yrs);
    t3rows.push([
      `${label}, year${yrs === "1–1" ? " 1" : "s " + yrs}`,
      `${f1(r.served_U_pct)}%`, `${f1(r.served_D_pct)}%`,
      `${(Number(r.dropped_U_GPUh) / 1e6).toFixed(2)}m`,
      Math.round(Number(r.gen_GWh)).toLocaleString(), Math.round(Number(r.grid_GWh)).toLocaleString(),
      `${Math.round(Number(r.turbine_cf_pct))}%`,
    ]);
  }
}
const t3 = table(
  ["Plan / years", "Urgent served", "Deferrable served", "Urgent dropped (GPU-h/yr)", "Turbine GWh/yr", "Grid GWh/yr", "Turbine CF"],
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
    ["Campus", "100 MW IT, C = 58,800 GPUs, e = 1.7 kW, e0 = 0.5 kW, PUE 1.15", "Proposal 7.1"],
    ["Workloads", "60% urgent (D = 0 h, r = $5.00), 40% deferrable (D = 12 h, r = $3.50); ρ = 10% of r per h, φ = 25% of r", "Proposal 7.1b"],
    ["Scenarios", "θ = 1.0 / 0.7 / 0.5 with p = 0.5 / 0.3 / 0.2; θ constant over years", "Proposal 7.1b"],
    ["Turbines", "IG = $235k/MW-yr, cG = $41.1/MWh, α = 0.95 (0.85 hot hours), yG = 2, Gmax = 250 MW", "Proposal 7.2"],
    ["K1 Firm", "Connects year 4, P = 115 MW, F = $12m/yr, U = $50m, no curtailment", "Proposal 7.3"],
    ["K2 Flexible", "Connects year 1, P = 115 MW, F = $6m/yr, U = $20m, 100% shed in 43.6 h/yr", "Proposal 7.3"],
    ["Horizon", "15 years, WACC 8% (Σδ = 8.56); 4 seasonal weeks + 1 stress week, hourly (840 h)", "Proposal settings"],
    ["Arrival shape", "Urgent: daily peak at 16:00 (±35%), weekends −10%; deferrable near-flat. Mean utilisation 75% at θ = 1", "Made up"],
    ["Grid prices λt", "Seasonal level + evening peak + $12/MWh delivery adder; mean $48/MWh; $450–800 scarcity on 3 stress-week afternoons", "Made up"],
    ["Curtailment Ek,t", "Highest-price hours until 44 h/yr: 18 stress-week hours + 2 summer hours (×12.8 weight)", "Made up (rule from 7.3)"],
  ],
  [1700, 6060, 1600],
);

// ---------- document ----------
const chart = fs.readFileSync(path.join(PROJ, "outputs", "g_sweep.png"));

const children = [
  new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Toy optimisation results: securing power for a 100 MW AI campus")] }),
  new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ font: FONT, text: "15.S09 project · base case from the proposal, offers K1 and K2 only · November 2026", color: "555555" })] }),

  H1("Summary"),
  B(`**The flexible, early offer (K2) maximises expected profit**: $${bn(S.K2.expected_profit)}bn NPV, versus $${bn(S.K1.expected_profit)}bn for the best firm (K1) plan, a gap of $${(gap / 1e9).toFixed(2)}bn.`),
  B(`**Under K1, profit is maximised by building ${Math.round(S.K1.G_MW)} MW of gas turbines** as bridging power for years 2–3, before the firm connection arrives in year 4. Without them K1 is worth only $6.99bn.`),
  B("**Under K2, profit is maximised by building no turbines**: accept the 44 curtailment hours a year, shift deferrable work, and lose 0.7% of urgent work. Covering curtailment with turbines costs more than the revenue it saves."),
  B("**K2 also wins in every demand scenario, and uncertainty does not change the plan**: the value of the stochastic solution is $0 in this base case."),

  H1("1. Results by contract"),
  P("Each contract was solved on its own (offer fixed, turbine size free, a linear program), and the full model with a binary offer choice was solved as a cross-check; it picks the same plan and profit. Profit is the NPV over 15 years at 8%, net of grid and turbine costs but not of GPU and building costs, which are the same under every plan."),
  t1,
  Cap("Table 1. Profit-maximising turbine capacity and NPV profit for each contract. Scenario columns show the profit of that same plan if the scenario occurs."),

  H2("K1 Firm (late): build turbines as a bridge"),
  P(`The firm connection arrives in year 4, and turbines cannot run until year 2. Year 1 is therefore lost under K1 whatever is built: the campus sits dark and all arriving work goes unserved. In years 2–3 the turbines are the only power source, and every MW keeps 435–485 GPUs earning $3.50–5.00 an hour, which far outweighs its $235k/MW-yr cost. The optimum, ${f1(S.K1.G_MW)} MW, covers almost all load in the expected-demand scenario (100% of urgent work, 99.2% of deferrable work in years 2–3).`),
  P("Building more stops paying because the turbines are needed for only two years, while their annualised cost is charged for all 15. After year 4 they still run 39–57% of the time, because they generate at $41/MWh, below the average grid price of $48/MWh. That saving does not cover the cost of extra capacity, so profit falls slowly above 94 MW (Figure 1)."),

  H2("K2 Flexible (early): build nothing, accept curtailment"),
  P("K2 connects in year 1 and must shed all imports in about 44 hours a year. With no turbines, the campus runs nothing in those hours. Deferrable work is shifted to the hours that follow (none is dropped or late, because the 12-hour deadline is longer than the 6-hour events). Urgent work arriving during events is lost: about 1.6m GPU-h a year in the expected scenario, 0.7% of urgent volume, costing about $9.9m a year in revenue and penalties."),
  P("A turbine would only pay off if it saved more than its $235k/MW-yr cost. The first MW recovers about $120k a year of lost urgent work plus some fuel savings against grid prices, about $165k/MW-yr in total, so the optimum is G = 0. Turbines would enter the K2 plan if installed costs fell below roughly $1,520/kW (versus $2,200/kW assumed), or if curtailment hours or urgent prices were materially higher."),

  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: [new ImageRun({ type: "png", data: chart, transformation: { width: 600, height: 334 } })] }),
  Cap("Figure 1. Expected NPV profit as a function of onsite turbine capacity for each contract (each point is a separate LP with G fixed). Dots mark the optima."),

  H2("Where the gap between contracts comes from"),
  t2,
  Cap("Table 2. Expected NPV of each profit component (USD m). Negative values are costs."),
  P(`Almost all of the $${(gap / 1e9).toFixed(2)}bn gap is time-to-power. K2 earns $1.22bn more revenue, mostly because it operates in year 1 and K1 does not, and it avoids $306m of dropped-work penalties. K2's lower fixed and upfront charges add $81m. K1's only advantage is cheaper energy: its turbines displace some grid purchases.`),

  H2("Operations under each plan (expected-demand scenario)"),
  t3,
  Cap("Table 3. Annual operating outcomes in scenario S1. CF = turbine capacity factor (output ÷ G × 8,760 h)."),

  H1("2. Does uncertainty about demand change the decision?"),
  P(`Not in this base case. Planning on the average demand level (θ̄ = ${Number(head.theta_bar).toFixed(2)}) gives the same plan, K2 with no turbines, so the value of the stochastic solution is $0. Table 4 shows why: even with perfect foresight, K2 with no turbines is best in every scenario. Uncertainty does move the K1 plan (from 48 MW if demand disappoints to 97 MW if it holds), and the stochastic K1 optimum of 94 MW sits close to the high-demand answer because lost compute revenue is far costlier than idle turbines.`),
  t4,
  Cap("Table 4. Best turbine size and profit if each scenario were known in advance."),
  P("In this toy the scenarios differ only in demand level, not in the hourly shape or workload mix, so a zero VSS is partly by construction. Scenarios that vary the urgent share or the arrival timing are the natural next test."),

  H1("3. What was modelled"),
  P("The model is the two-stage stochastic program in the proposal (sections 1–5). Stage 1 chooses the offer z_k and turbine capacity G. Stage 2 schedules work, dispatches turbines and buys grid power hour by hour in each scenario, subject to constraints C1–C7 and C9. Inputs follow the proposal's base case (section 7); values the proposal leaves open were made up and are marked below."),
  t5,
  Cap("Table 5. Base-case inputs. K3 (no grid) is excluded."),

  H1("4. Modelling choices and caveats"),
  B("**Idle power during outages.** As written, C6 makes idle GPUs always draw e0, so the model is infeasible when no power source exists (K1 before year 4 with too few turbines; K2 during a full curtailment). We let idle GPUs be powered down only in hours when the signed offer's grid supply is unavailable (not yet connected, or curtailed). In normal hours idle GPUs draw e0 as specified."),
  B("**Dark-year work is penalised.** Under K1, year-1 arrivals are counted as dropped and incur the φ penalty ($320m expected). If demand simply did not exist before power, that overstates K1's loss; removing it still leaves K2 ahead by about $1.4bn."),
  B("**Charges in every year.** Following the proposal's objective, Fk and IG·G are charged in all 15 years, including K1's years before connection and the year before turbines run. This costs K1 about $31m of fixed charges it might not owe."),
  B("**No N+1 spare.** Turbine capacity is sized for energy only; an islanded campus in K1's years 2–3 would in practice need a spare unit (proposal 7.2)."),
  B("**Ramp limits omitted** (C8), as the proposal notes they do not bind at hourly resolution. Year aggregation (years with identical operating problems are solved once) was checked against the full 15-year model and gives the same objective."),
  B("**Validation.** Expected-demand revenue is about $16.9m per MW of IT a year, matching the proposal's ~$17m estimate. Operating-model checks passed: with no turbines K2 runs nothing in curtailment hours and loses only urgent work then; with Gmax turbines nothing is lost from year 2; K1 with no turbines serves nothing before year 4 and everything after."),

  H1("5. Next steps"),
  B("Sensitivity runs from the proposal: firm connection delay (1–6 years), curtailment hours (0–500 h/yr), revenue per MW ($5–20m), deadline window (4, 12, 24 h) and urgent share (20–80%). The K2 turbine break-even (~$1,520/kW) and the K1 connection year are the tipping points to map first."),
  B("Scenarios that vary the workload mix and arrival timing, not just the level, so that the value of the stochastic solution can be non-zero."),
  B("Replace made-up prices and curtailment hours with RTO data (e.g. PJM or ERCOT LMPs and top net-load hours)."),
  P("Reproduce: julia --project=. scripts/generate_toy_data.jl; julia --project=. scripts/solve_toy.jl; python3 scripts/plot_g_sweep.py. Results are written to outputs/.", { spacing: { before: 200 } }),
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
