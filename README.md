# Monte Carlo for Google Sheets

This is a Monte Carlo simulation tool that runs inside a Google Sheet as an Apps Script. You mark distribution inputs and outputs in an extra column called `MonteCarlo`, and the script samples from those distributions, re-evaluates your formulas in JavaScript, and writes summary stats, histograms, and sensitivity results to three new tabs. Your existing formulas are left alone.

A few things to know up front:

- It runs 10,000 iterations in around 30 seconds on a typical model.
- Everything happens inside the sheet. There's no server, no login beyond the OAuth prompt the first time you run it, and no data leaves the spreadsheet.
- The formula evaluator is written in JavaScript, so the sheet doesn't have to recalculate thousands of times. That's what makes it fast enough to actually use.
- The PRNG is seedable, and the results sheet reports the Monte Carlo standard error of each mean alongside the mean itself.

There's a section further down called "Known statistics issues" that I'd recommend reading if you're using this for anything that matters. The tool makes some simplifying assumptions that can mislead you if you're not aware of them.

## Install

1. Open your Google Sheet.
2. Go to Extensions → Apps Script.
3. Delete whatever is in `Code.gs` by default.
4. Paste the contents of [`dist/MonteCarlo.gs`](dist/MonteCarlo.gs) in.
5. Save the file (⌘S or Ctrl+S).
6. Reload the Google Sheet.
7. A new "Monte Carlo" menu should appear in the toolbar.

The first time you run the simulation, Google will ask for OAuth consent. The manifest asks for the narrowest possible scope (`spreadsheets.currentonly` plus `script.container.ui` for the menu and dialogs), so the consent screen will say something like "access to this spreadsheet only."

## Sheet format

You structure your data in rows, and then add a column called `MonteCarlo`. The column immediately to the left of `MonteCarlo` is the "value column" — that's the one the tool reads outputs from and replaces with samples.

Here's what a simple profit model looks like:

| A (label)       | B (value)             | C (MonteCarlo) | D (param1 / p10) | E (param2 / p90) |
|-----------------|-----------------------|----------------|------------------|------------------|
| Price per unit  | 100                   | Normal         | 100              | 10               |
| Units sold      | 1000                  | LogNormal      | 500              | 2000             |
| Fixed costs     | 50000                 | _(blank)_      |                  |                  |
| Variable cost   | 0.4                   | Uniform        | 0.3              | 0.5              |
| Revenue         | =B2\*B3               |                |                  |                  |
| Variable total  | =B3\*B2\*B5           |                |                  |                  |
| Profit          | =B6-B7-B4             | Output         |                  |                  |

The `MonteCarlo` header can be in any of the first 10 rows. Keywords in the column aren't case-sensitive.

### MonteCarlo keywords

| Keyword      | What it does                                                        |
|--------------|---------------------------------------------------------------------|
| `Normal`     | Value column becomes N(mean, sd), or N fitted to two quantiles      |
| `LogNormal`  | Value column becomes LogN(mu, sigma), or fitted to two quantiles    |
| `Uniform`    | Value column becomes U(a, b), or fitted to two quantiles            |
| `Discrete`   | Value column becomes a weighted choice over (value, weight) pairs   |
| `Output`     | Value column is collected across iterations                         |
| _(blank)_    | Value column is deterministic (a plain value or formula)            |

### Parameter mode and quantile mode

The tool detects which mode a row is using based on the headers of the first two columns to the right of `MonteCarlo`:

- If both headers match `p\d+` (e.g., `p10`, `p25`, `p90`), the row is in quantile mode. The values you put there are the Nth percentile of the distribution.
- Otherwise it's in parameter mode, and the values are the distribution's raw parameters.

| Distribution | Parameter mode       | Quantile mode headers          |
|--------------|----------------------|--------------------------------|
| Normal       | mean, sd             | any two `pN` (e.g. p10, p90)   |
| LogNormal    | mu, sigma            | any two `pN` — values must be positive |
| Uniform      | a, b                 | any two `pN`                   |
| Discrete     | x1, w1, x2, w2, …    | _not supported_                |

`Discrete` just reads every non-blank column to the right of `MonteCarlo` in pairs. Headers don't matter for `Discrete`.

One thing to watch out for: `Uniform` in quantile mode extrapolates out to the endpoints. If you say `p10=0, p90=10`, the unique Uniform distribution whose 10th and 90th percentiles hit those values has `a = -1.25, b = 11.25`. So about 20% of your samples will land outside `[0, 10]`. If what you actually mean is a hard range, use parameter mode instead.

## Supported formulas

The evaluator supports arithmetic and about 30 common spreadsheet functions.

The operators are `+ - * / ^`, unary `-` and `+`, concatenation `&`, and comparison operators (`= <> < > <= >=`).

The functions, grouped by type:

- **Math**: `SUM AVERAGE MIN MAX COUNT COUNTA MEDIAN STDEV VAR PERCENTILE SUMPRODUCT PRODUCT`
- **Single-argument math**: `ABS SQRT EXP LN LOG LOG10 POWER MOD ROUND CEILING FLOOR INT TRUNC PI`
- **Logic**: `IF IFS AND OR NOT IFERROR ISERROR ISNUMBER ISBLANK NA TRUE FALSE`

Some things aren't supported:

- Multi-sheet references (`Sheet1!A1`)
- Named ranges
- Array formulas (`ARRAYFORMULA`)
- `RAND` and `RANDBETWEEN` (randomness only comes from marked distributions)
- Text functions beyond `&` concat (so no `LEFT`, `MID`, `REGEX…`, etc.)

If you use a function that isn't supported, the tool throws a clear error before the simulation starts that names the cell and the function.

## Evaluator semantics

Since the evaluator is hand-written, there are some edge cases where the behavior is documented rather than matching Sheets exactly. These are all consistent and predictable, but worth knowing if your formulas hit them:

- Blank cells coerce to `0` in arithmetic. Aggregation functions like `SUM`, `AVERAGE`, and `COUNT` skip blanks. `IF` treats a blank as falsy.
- Errors are first-class values, not thrown exceptions. They propagate through every operator, and only `IFERROR` catches them. Things like `LN(-1)`, `SQRT(-1)`, and `1/0` produce `#NUM!` or `#DIV/0!` sentinels, which get counted in the Errors column on the results sheet.
- String coercion works the way you'd expect: `"5" + 3 = 8`, `TRUE + 1 = 2`, `"abc" + 1 = #VALUE!`.
- Comparisons: numeric compare if both sides look numeric, otherwise case-insensitive string compare.
- If an iteration produces an error, it's recorded as `NaN` in the samples and counted per output. One bad path doesn't kill the whole run.

## Results

Running the simulation creates, or overwrites, three sheets.

**MC Results** has a row per output with the mean, the Monte Carlo standard error of the mean (±1.96·SE ≈ 95% CI), the median, stdev, min, max, percentiles P1–P99, effective N (count of finite samples), and the error count. Below that, it lists the distribution inputs with their resolved parameters. And below that, there's a column-chart histogram per output. The histograms switch to log-spaced bins when the output is highly skewed, because LogNormal-style outputs are essentially unreadable with linear bins.

**MC Sensitivity** shows the Spearman rank correlation between every input and every output, with conditional formatting (red for negative, blue for positive). There's a banner at the top noting that ρ close to 0 doesn't mean an input doesn't matter, which I explain more in the statistics section below.

**MC Samples** has one row per iteration and one column per input and output. It's useful if you want to pivot, filter, or paste into another tool.

## Known statistics issues

A statistician would flag these as problems. Most have non-trivial fixes that are out of scope for this version. If you're using this tool for anything load-bearing, I'd recommend reading this section.

### Things you might genuinely be misled by

**Mean is conditional on success when Errors is greater than zero.** If some iterations error out (say, `LN(X)` hits a negative `X` once in 200 draws), those iterations are dropped from the mean calculation. What gets reported is `E[output | output is finite]`, not the unconditional expectation. If errors correlate with one tail of the distribution — which they usually do, because they happen when an input went somewhere bad — the reported mean is biased toward the safe tail. The Results sheet shows a warning banner when this happens.

**There are no confidence intervals on the percentiles.** The tool reports `Mean SE` alongside the mean, which gives a 95% CI on the mean as `Mean ± 1.96·SE`. But it doesn't do the same for P5, P95, P99, and so on. Tail-percentile estimates have a lot more variance than central ones. At N=10,000, P99 can shift by several percent between runs with different seeds. If you're making a decision based on a tail percentile, I'd recommend running the simulation 5 to 10 times with different seeds to see the spread.

**Spearman isn't "input importance."** The MC Sensitivity sheet shows Spearman rank correlation. ρ near 0 doesn't mean an input is unimportant. It only means the input doesn't have a monotonic relationship with the output. A few examples that defeat Spearman:

- `Y = X²` with `X ~ N(0,1)`: ρ = 0, but X explains 100% of Y.
- `Y = X₁ · X₂` with both `X_i ~ N(0,1)` independent: each ρ ≈ 0, and so is each first-order Sobol index. Neither input explains any variance on its own. But the total-order Sobol indices are both 1, which means each input is essential, with 100% of the variance living in the interaction term. Spearman can't see this, and neither can first-order variance decomposition. You need total-order indices for it.
- Threshold models like `Y = X₁ if X₂ > 0 else -X₁`: each ρ ≈ 0.

I'd treat the sensitivity sheet as a screening tool, not a real variance decomposition. For a real one, you need Sobol indices, which require different sampling and are out of scope here.

**Inputs are sampled independently.** The tool doesn't support correlated inputs. Real models often have them (returns and volatility, demand and price, costs and revenues). Sampling them independently understates joint tail risk and produces optimistic "bad outcome" tails. If your inputs should move together, this tool will silently ignore that.

### Choices a statistician would push back on

**Vanilla Monte Carlo, no variance reduction.** Convergence is `1/√N`. Quasi-random sequences like Sobol or Halton converge closer to `1/N`. Latin Hypercube gives stratified coverage for free. Antithetic variates halve the variance for symmetric distributions at zero cost. None of these are implemented. If you want to halve your reported `Mean SE`, you currently have to 4x the iteration count.

**Percentile interpolation uses Hyndman-Fan type 7**, which is the Excel/Sheets default. Statisticians often prefer type 8, which is approximately median-unbiased independent of the underlying distribution. The difference is in the third decimal at N=10,000. The `PERCENTILE()` formula function also uses type 7 for Sheets parity, and the summary stats on the MC Results sheet use type 7 for consistency with that.

### Numerical and minor

- The PRNG is mulberry32 (32-bit state, period 2^32). Seeds are mixed through a Murmur3-style finalizer first, so close auto-seeds (like consecutive `Date.now()` values) produce well-separated streams. For runs with more than ~10⁸ total RNG draws (big model × many iterations × many re-runs), the period becomes a real concern, and you'd want to swap in something like xoshiro128++.
- Normals are generated with the Marsaglia polar method, with the second variate cached. The polar method rejects about 21.5% of candidate pairs (the ones outside the unit disk), so the amortized cost is around 1.27 uniforms per normal, not 1-to-1.
- Errors during evaluation never throw. They propagate through the formula as `#DIV/0!`, `#NUM!`, or `#VALUE!` sentinels, get recorded as `NaN` in the samples, and increment the output's Errors counter.

### What I'd add if you were using this for real stats (and not forecasting or casual use)

If you're going to extend this, here's where I'd start:

1. **Bootstrap CIs on every percentile.** 1000 resamples is usually enough, and it's fast in JS because it's pure ranking.
2. **Sobol sensitivity indices with Saltelli sampling.** You want both first-order and total-order, so you pick up the interaction effects that Spearman and first-order variance decomposition both miss.
3. **Latin Hypercube plus antithetic variates.** Free 2–4x variance reduction.
4. **Correlated input support** via a Cholesky factor on a user-supplied correlation matrix. Iman-Conover preserves the marginals.
5. **Handle failure regions explicitly**, not by resampling them. Resampling until you hit N just gets you a bigger sample from the success region — the reported mean is still `E[Y | Y is finite]`, not the unconditional `E[Y]`. To actually fix the bias, you need imputation (assign some value to the failure region, like 0 or a modeled extreme) or bounds (report `Mean_lower` assuming failures equal the min observed and `Mean_upper` assuming they equal the max observed), so the user sees the size of the unknown.

For forecasting and casual use, I wouldn't worry about any of this. The tool as-is is fine for that.

## Menu items

- **Run Simulation** runs with the default of 10,000 iterations. Before kicking off, it shows a summary of what it detected ("Found 4 inputs, 2 outputs, 35 formula cells. Run?") so you can catch misconfigurations cheaply.
- **Run Simulation (custom…)** prompts for the iteration count and a reproducibility seed.
- **Insert Example Layout** adds an "MC Example" sheet with a profit model already set up.
- **Help / Format Reference** is an in-app reminder of the format.

## Performance

On a typical model with around 50 cells and 20 formula cells:

| Iterations | Approximate time |
|-----------:|:-----------------|
|      1,000 | < 5 s            |
|     10,000 | ~20–30 s         |
|    100,000 | ~2–3 min         |

Google Apps Script has a 6-minute per-invocation execution cap. At around 100 formula cells and 50,000 iterations you start to approach it. The custom-iteration dialog accepts up to 200,000.

## Test-in-Sheets checklist

After pasting `dist/MonteCarlo.gs` into Apps Script, here are a few things to run through to confirm everything works:

1. **Example model.** Click Monte Carlo → Insert Example Layout, then Monte Carlo → Run Simulation. You should see three new sheets and a histogram on MC Results. Mean profit should be roughly 45,000 to 50,000.
2. **Reproducibility.** Run "Run Simulation (custom…)" with iterations=5000 and seed=42. Note the P50 for profit, then run it again with the same seed. The P50 should match exactly.
3. **Cycle detection.** In a sheet with a `MonteCarlo` column, make cell B2 `=B3` and cell B3 `=B2`. Running the simulation should surface an alert saying "Circular reference detected among cells: B2, B3."
4. **Unknown function.** Add a formula `=FOOBAR(1)` in the value column of a row marked as `Output`. Running should surface "Cell X: Unknown function FOOBAR" before the simulation starts.
5. **Quantile mode.** Set up a row with label `X`, value `0`, MonteCarlo `Normal`, and headers `p10` and `p90` with values `0` and `10`. Mark that cell as an output. P10 should come back near 0 and P90 near 10.

## Development

Project layout:

```
src/
  appsscript.json         Manifest (OAuth scopes)
  Main.gs                 Menu, orchestration, error UI
  ModelReader.gs          Parse sheet annotations into a Model
  Distributions.gs        PRNG (mulberry32 + mixSeed), samplers, quantile solvers
  FormulaLexer.gs         Tokenize formulas
  FormulaParser.gs        Pratt parser → AST
  FormulaFunctions.gs     Registry of ~30 functions with error semantics
  FormulaEvaluator.gs     Walk AST against a state map
  DependencyGraph.gs      Topo-sort formula cells
  Simulation.gs           Main loop
  Stats.gs                Summary stats + Spearman correlation + histogram binning
  ResultsWriter.gs        Write the three output sheets

tests/
  harness.js              VM-based shared-context loader + test framework
  *.test.js               Node unit and integration tests
  smoke-test.jxa.js       20 smoke tests you can run via osascript (no install)
  run-tests.js            Runs everything

dist/
  MonteCarlo.gs           Single-file bundle generated by build.py

build.py                  Concatenates src/ → dist/MonteCarlo.gs
```

### Building the bundle

```
python3 build.py
```

This strips the Node-only `module.exports` trailers from each source file and writes the combined `dist/MonteCarlo.gs`.

### Running the tests

If you don't have Node installed, you can still run a representative subset on macOS using the built-in JavaScriptCore:

```
/usr/bin/osascript -l JavaScript tests/smoke-test.jxa.js
```

That runs 20 tests covering the PRNG (including seed mixing and seed=0), the parser, the evaluator (including error propagation), end-to-end simulation, quantile-mode sampling, cycle detection, sensitivity analysis, the ModelReader, log-spaced histograms for skewed data, and Pearson on zero-variance inputs.

If you do have Node, you can run the full suite:

```
node tests/run-tests.js
```

The harness loads every `.gs` source into a shared `vm` context (mimicking Apps Script's global scope), and each `*.test.js` file registers tests via `h.test(name, fn)`.

## License

MIT.
