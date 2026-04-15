# Monte Carlo for Google Sheets

A Monte Carlo simulation tool that runs entirely inside a Google Sheet as an
Apps Script. The sheet's existing formulas are left alone; you mark
distribution inputs and outputs in an extra `MonteCarlo` column, run the
simulation from a menu, and stats + histograms + sensitivity land on three
new tabs.

- Runs 10,000 iterations in ~30 seconds on a typical model.
- No server, no login, no OAuth beyond "access to this spreadsheet".
- In-JS formula evaluator — the sheet doesn't have to recalc thousands of times.
- Reproducible (seedable) PRNG; reports Monte Carlo standard errors on every mean.

---

## Install

1. Open your Google Sheet.
2. Extensions → Apps Script.
3. In the editor, delete the default `Code.gs` contents.
4. Paste the contents of [`dist/MonteCarlo.gs`](dist/MonteCarlo.gs) into the editor.
5. Save (⌘S / Ctrl+S). Give the project any name.
6. Reload your Google Sheet.
7. A new **Monte Carlo** menu appears in the toolbar.

First run will prompt for OAuth consent. The manifest requests only
`spreadsheets.currentonly` and `script.container.ui`, so the consent
screen says "access to this spreadsheet only."

---

## Sheet format

Structure your data as rows. Add a `MonteCarlo` column; the column immediately
to its **left** is the "value column" — the one the tool reads outputs from
and replaces with samples.

| A (label)       | B (value)             | C (MonteCarlo) | D (param1 / p10) | E (param2 / p90) | F | G |
|-----------------|-----------------------|----------------|------------------|------------------|---|---|
| Price per unit  | 100                   | Normal         | 100              | 10               |   |   |
| Units sold      | 1000                  | LogNormal      | 500              | 2000             |   |   |
| Fixed costs     | 50000                 | _(blank)_      |                  |                  |   |   |
| Variable cost   | 0.4                   | Uniform        | 0.3              | 0.5              |   |   |
| Revenue         | =B2\*B3               |                |                  |                  |   |   |
| Variable total  | =B3\*B2\*B5           |                |                  |                  |   |   |
| Profit          | =B6-B7-B4             | Output         |                  |                  |   |   |

The `MonteCarlo` header can be in any of the first 10 rows. Keywords in
the column are case-insensitive.

### MonteCarlo keywords

| Keyword      | What it does                                                    |
|--------------|-----------------------------------------------------------------|
| `Normal`     | Value column becomes N(mean, sd) — or N fitted to two quantiles |
| `LogNormal`  | Value column becomes LogN(mu, sigma) — or fitted to two quantiles |
| `Uniform`    | Value column becomes U(a, b) — or fitted to two quantiles       |
| `Discrete`   | Value column becomes weighted choice over (value, weight) pairs |
| `Output`     | Value column is collected across iterations                     |
| _(blank)_    | Value column is deterministic (plain value or formula)          |

### Parameter vs quantile mode

The tool detects mode **per row**, based on the headers of the first two
parameter columns (to the right of `MonteCarlo`):

- If both headers match `p\d+` (e.g. `p10`, `p25`, `p90`) → **quantile mode**.
  Values are the Nth percentile of the distribution.
- Otherwise → **parameter mode**. Values are the distribution's raw parameters.

| Distribution | Parameter mode       | Quantile mode headers          |
|--------------|----------------------|--------------------------------|
| Normal       | mean, sd             | any two `pN` (e.g. p10, p90)   |
| LogNormal    | mu, sigma            | any two `pN` — values must be positive |
| Uniform      | a, b                 | any two `pN`                   |
| Discrete     | x1, w1, x2, w2, …    | _not supported_                |

`Discrete` reads every non-blank column after `MonteCarlo` in pairs. Headers
are ignored for `Discrete`.

> ⚠ `Uniform` quantile mode extrapolates: `p10=0, p90=10` implies
> `a = -1.25, b = 11.25` (the unique Uniform whose 10/90 percentiles
> hit those values). 20% of samples will land outside `[0, 10]`. If you
> mean a hard range, use parameter mode.

---

## Supported formulas

Arithmetic and ~30 common spreadsheet functions.

**Operators:** `+ - * / ^`, unary `-`/`+`, concatenation `&`, comparison `= <> < > <= >=`.

**Functions:**
- Math: `SUM AVERAGE MIN MAX COUNT COUNTA MEDIAN STDEV VAR PERCENTILE SUMPRODUCT PRODUCT`
- Single-arg math: `ABS SQRT EXP LN LOG LOG10 POWER MOD ROUND CEILING FLOOR INT TRUNC PI`
- Logic: `IF IFS AND OR NOT IFERROR ISERROR ISNUMBER ISBLANK NA TRUE FALSE`

**Not supported (for now):**
- Multi-sheet references (`Sheet1!A1`)
- Named ranges
- Array formulas (`ARRAYFORMULA`)
- `RAND`, `RANDBETWEEN` — randomness comes only from marked distributions
- Text functions beyond `&` concat (`LEFT`, `MID`, `REGEX…`)

Using an unsupported function throws a clear error *before* the
simulation starts, naming the cell and the function.

---

## Evaluator semantics (known deviations from Sheets)

Because the evaluator is hand-written, a few edge cases are documented rather
than "mimicked exactly". These are all consistent and predictable — they just
don't always match Sheets bit-for-bit.

- **Blank cells** coerce to `0` for arithmetic. For aggregations like
  `SUM`/`AVERAGE`/`COUNT`, blanks are skipped. For `IF`, blanks are falsy.
- **Errors are first-class values**, not exceptions. They propagate through
  every operator; only `IFERROR` catches them. `LN(-1)`, `SQRT(-1)`,
  `1/0`, etc. produce `#NUM!` or `#DIV/0!` sentinels that surface as an
  **Errors** column on the results sheet.
- **String coercion:** `"5" + 3 = 8`, `TRUE + 1 = 2`, `"abc" + 1 = #VALUE!`.
- **Comparison:** numeric compare if both sides look numeric, else
  case-insensitive string compare.
- **Per-iteration errors** get recorded as `NaN` in the raw samples and
  counted per output — so a bad path doesn't kill the whole run.

---

## Results

Running the simulation creates (or overwrites) three sheets:

- **MC Results** — per output: mean, **Mean SE** (Monte Carlo standard
  error of the mean — ±1.96·SE ≈ 95% CI), median, stdev, min, max,
  percentiles P1–P99, **Eff N** (count of finite samples), and error count.
  Below: the list of distribution inputs with the resolved parameters,
  and a column-chart histogram per output (log-spaced bins for
  highly-skewed outputs).
- **MC Sensitivity** — Spearman rank correlation of every input against
  every output. Colored conditionally: red for negative, blue for positive.
  Banner at the top warns that ρ ≈ 0 doesn't mean an input doesn't matter
  (see [Known statistics issues](#known-statistics-issues) below).
- **MC Samples** — raw per-iteration values, one row per iteration, one
  column per input and output. Useful for pivoting, filtering, or pasting
  into external tools.

---

## Known statistics issues

A statistician would flag these as problems. Most have non-trivial fixes that
are out of scope for v1; if you're using this for anything load-bearing,
read this section.

### Things you might genuinely be misled by

- **`Mean` is conditional on success when `Errors > 0`.** When some
  iterations error out (e.g. `LN(X)` hits a negative `X` once in 200
  draws), those iterations are dropped from the mean calculation. The
  reported mean is `E[output | output is finite]`, **not** the
  unconditional expectation. If errors correlate with one tail (they
  usually do — they happen *because* the input went somewhere bad), the
  reported mean is biased toward the safe tail. The Results sheet shows
  a warning banner when this happens.
- **No confidence intervals on percentiles.** We report `Mean SE` (which
  gives a 95% CI on the mean as `Mean ± 1.96·SE`), but **not** SEs on
  P5/P95/P99. Tail-percentile estimates have meaningfully more variance
  than central ones — at N=10k, P99 can shift by several percent
  between runs with different seeds. If you're making a decision based
  on a tail percentile, run the sim 5×-10× with different seeds and look
  at the spread.
- **Spearman ≠ "input importance".** The MC Sensitivity sheet shows
  Spearman rank correlation. ρ near 0 does **not** mean an input is
  unimportant. It only means the input has no monotonic relationship
  with the output. Counter-examples that defeat Spearman:
  - `Y = X²` with `X ~ N(0,1)`: ρ = 0, but X explains 100% of Y.
  - `Y = X₁ · X₂` with both `X_i ~ N(0,1)` independent: each ρ ≈ 0,
    but each input explains ~50% of the variance.
  - Threshold/regime models like `Y = X₁ if X₂ > 0 else -X₁`: each ρ ≈ 0.
  Use this as a screening tool, not as a true sensitivity analysis.
  For variance decomposition (Sobol indices) you need a different tool.
- **Inputs are sampled independently.** No correlation/copula support.
  Real models often have correlated inputs (returns and volatility,
  demand and price, costs and revenues). Sampling them independently
  understates joint tail risk and produces optimistic "bad outcome"
  tails. If your inputs should move together, this tool will silently
  ignore that.

### Choices a statistician would push back on

- **Vanilla Monte Carlo, no variance reduction.** Convergence is `1/√N`.
  Quasi-random sequences (Sobol, Halton) converge close to `1/N`. Latin
  Hypercube gives stratified coverage for free. Antithetic variates
  halve the variance for symmetric distributions at zero cost. None
  implemented. To halve your reported `Mean SE`, you currently have to
  4× the iteration count.
- **Percentile interpolation is Hyndman-Fan type 7** (the Excel/Sheets
  default). Statisticians often prefer type 8, which is approximately
  median-unbiased independent of the underlying distribution. The
  difference is in the third decimal at N=10k.
- **`PERCENTILE()` formula function uses type 7** for Sheets parity. The
  summary stats on the MC Results sheet also use type 7 for consistency
  with the in-sheet `PERCENTILE()` function.

### Numerical / minor

- The PRNG is **mulberry32** (32-bit state, 2^32 period). Seed is mixed
  via a Murmur3-style finalizer first, so close auto-seeds (e.g.
  consecutive `Date.now()`) produce well-separated streams. For runs
  with > ~10⁸ total RNG draws (large model × many iterations × many
  re-runs), the period becomes a real concern; consider xoshiro128++.
- Normals are generated via the **Marsaglia polar method** with the
  second variate cached, so N independent normals cost N+1 uniforms.
- Errors during evaluation never throw — they propagate through the
  formula as `#DIV/0!` / `#NUM!` / `#VALUE!` sentinels, get recorded as
  `NaN` in samples, and increment the output's Errors counter.

### What I'd add if you were using this for real stats (and not forecasting or casual use)

If you're going to extend this:

1. **Bootstrap CIs on every percentile** (1000 resamples is enough; pure
   ranking, fast in JS).
2. **Sobol sensitivity indices** with Saltelli sampling — first-order
   AND total-order, so you get interaction effects.
3. **Latin Hypercube + antithetic variates** — free 2–4× variance
   reduction.
4. **Correlated input support** via a Cholesky factor on a user-supplied
   correlation matrix (Iman-Conover preserves marginals).
5. **Re-sample failed iterations** until you hit the requested N, so the
   reported mean is unbiased even when the model has thin-failure
   regions.

---

## Menu items

- **Run Simulation** — default 10,000 iterations. Shows a summary of what
  was detected ("Found 4 inputs, 2 outputs, 35 formula cells. Run?") before
  kicking off.
- **Run Simulation (custom…)** — prompts for iteration count and a
  reproducibility seed.
- **Insert Example Layout** — drops a demo "MC Example" sheet with a
  profit model already set up.
- **Help / Format Reference** — quick in-app reminder of the format.

---

## Performance

On a typical model (50 cells, 20 formula cells):

| Iterations | Approximate time |
|-----------:|:-----------------|
|      1,000 | < 5 s            |
|     10,000 | ~20–30 s         |
|    100,000 | ~2–3 min         |

Google Apps Script has a 6-minute per-invocation execution cap. At ~100
formula cells × 50,000 iterations you start approaching it — the
custom-iteration dialog accepts up to 200,000.

---

## Test-in-Sheets checklist

After pasting `dist/MonteCarlo.gs` into Apps Script, run through these to
confirm nothing's broken in your install:

1. **Example model.** Click *Monte Carlo → Insert Example Layout*, then
   *Monte Carlo → Run Simulation*. You should see three new sheets and a
   histogram on *MC Results*. Mean profit is roughly 45–50k.
2. **Reproducibility.** Run *Run Simulation (custom…)* with iterations=5000
   and seed=42. Note the P50 for profit. Run it again with the same seed.
   The P50 should match exactly.
3. **Cycle detection.** In any sheet with a `MonteCarlo` column, make
   cell B2 `=B3` and cell B3 `=B2`. Run the simulation. You should see
   an alert: *"Circular reference detected among cells: B2, B3."*
4. **Unknown function.** Add a formula `=FOOBAR(1)` in the value column of a
   row marked as `Output`. Running should surface *"Cell X: Unknown function
   FOOBAR"* before the simulation starts.
5. **Quantile mode.** Set up a row: label `X`, value `0`, MonteCarlo
   `Normal`, headers `p10`, `p90` with values `0` and `10`. Output that
   cell. P10 should come back near 0, P90 near 10.

---

## Development

### Directory layout

```
src/
  appsscript.json         Manifest (OAuth scopes)
  Main.gs                 Menu, orchestration, error UI
  ModelReader.gs          Parse sheet annotations into a Model
  Distributions.gs        PRNG (mulberry32 + mixSeed), samplers, quantile solvers
  FormulaLexer.gs         Tokenize formulas
  FormulaParser.gs        Pratt parser → AST
  FormulaFunctions.gs     Registry of ~30 functions w/ error semantics
  FormulaEvaluator.gs     Walk AST against a state map
  DependencyGraph.gs      Topo-sort formula cells
  Simulation.gs           Main loop
  Stats.gs                Summary stats + Spearman correlation + histogram binning
  ResultsWriter.gs        Write the three output sheets

tests/
  harness.js              VM-based shared-context loader + test framework
  *.test.js               Node unit + integration tests
  smoke-test.jxa.js       20 smoke tests runnable via macOS osascript (no install)
  run-tests.js            Runs everything

dist/
  MonteCarlo.gs           Single-file bundle (generated by build.py)

build.py                  Concatenates src/ → dist/MonteCarlo.gs
```

### Bundle build

```
python3 build.py
```

Strips the Node-only `module.exports` trailers and writes `dist/MonteCarlo.gs`.

### Tests

**Without Node** (macOS only — uses the built-in JavaScriptCore):

```
/usr/bin/osascript -l JavaScript tests/smoke-test.jxa.js
```

Runs 20 representative tests covering PRNG (incl. seed mixing and seed=0),
parser, evaluator (incl. error propagation), end-to-end simulation,
quantile-mode sampling, cycle detection, sensitivity analysis, the
ModelReader, log-spaced histograms for skewed data, and Pearson on
zero-variance inputs. No install.

**Full suite** (requires Node):

```
node tests/run-tests.js
```

The harness loads every `.gs` source into a shared `vm` context (mimicking
Apps Script's global scope), then each `*.test.js` file registers tests via
`h.test(name, fn)`.

---

## License

MIT.
