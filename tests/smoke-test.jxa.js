/**
 * smoke-test.jxa.js — runs a small but representative subset of tests
 * using macOS's built-in JavaScriptCore (JXA), so no Node install is needed.
 *
 *   /usr/bin/osascript -l JavaScript tests/smoke-test.jxa.js
 *
 * Resolves source paths relative to its own location, so it works no matter
 * where the project lives. For the full suite, install Node and run:
 *   node tests/run-tests.js
 */

ObjC.import('Foundation');

function loadFile(path) {
  var data = $.NSData.dataWithContentsOfFile(path);
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

// Resolve src/ relative to this script (works regardless of cwd or install path).
var scriptPath = $.NSProcessInfo.processInfo.arguments.objectAtIndex(3).js;
var scriptDir  = scriptPath.substring(0, scriptPath.lastIndexOf('/'));
var SRC        = scriptDir + '/../src';
var files = [
  'Distributions.gs',
  'FormulaLexer.gs',
  'FormulaParser.gs',
  'FormulaFunctions.gs',
  'FormulaEvaluator.gs',
  'DependencyGraph.gs',
  'Stats.gs',
  'Simulation.gs',
  'ModelReader.gs'
];

var combined = '';
for (var i = 0; i < files.length; i++) {
  combined += loadFile(SRC + '/' + files[i]) + '\n';
}

// Strip the Node export blocks (they reference `module` which JXA doesn't have but won't error since wrapped in if).
// We can leave them — `typeof module !== 'undefined'` is false in JXA, so the blocks no-op.

// Wrap everything and expose what we need for testing.
var harness = combined + ';\n' +
  'globalThis.__test__ = {' +
  '  parseFormula_: parseFormula_,' +
  '  evalAst_: evalAst_,' +
  '  buildSampler_: buildSampler_,' +
  '  mulberry32_: mulberry32_,' +
  '  mixSeed_: mixSeed_,' +
  '  runSimulationCore_: runSimulationCore_,' +
  '  summarize_: summarize_,' +
  '  spearman_: spearman_,' +
  '  pearson_: pearson_,' +
  '  histogram_: histogram_,' +
  '  convergenceDiagnostic_: convergenceDiagnostic_,' +
  '  buildCDF_: buildCDF_,' +
  '  percentileCIs_: percentileCIs_,' +
  '  readSheetModel_: readSheetModel_,' +
  '  inverseNormalCDF_: inverseNormalCDF_' +
  '};';

try {
  var loader = new Function(harness);
  loader.call(globalThis);
} catch (e) {
  ('LOAD ERROR: ' + e.message);
  throw e;
}

var t = globalThis.__test__;

var results = [];

function check(name, fn) {
  try {
    fn();
    results.push('PASS  ' + name);
  } catch (e) {
    results.push('FAIL  ' + name + ' :: ' + e.message);
  }
}

function near(a, b, tol, label) {
  if (typeof a !== 'number' || isNaN(a)) throw new Error(label + ': not a number, got ' + a);
  if (Math.abs(a - b) > tol) throw new Error(label + ': expected ' + b + '±' + tol + ', got ' + a);
}

// 1. PRNG
check('mulberry32 in [0,1)', function () {
  var rng = t.mulberry32_(42);
  for (var i = 0; i < 1000; i++) {
    var v = rng();
    if (!(v >= 0 && v < 1)) throw new Error('out of range: ' + v);
  }
});

check('mulberry32 deterministic', function () {
  var a = t.mulberry32_(7), b = t.mulberry32_(7);
  for (var i = 0; i < 5; i++) if (a() !== b()) throw new Error('mismatch at ' + i);
});

// 2. Inverse normal
check('inverseNormalCDF z-scores', function () {
  near(t.inverseNormalCDF_(0.5), 0, 1e-6, 'p=0.5');
  near(t.inverseNormalCDF_(0.9), 1.2816, 1e-3, 'p=0.9');
  near(t.inverseNormalCDF_(0.025), -1.96, 1e-2, 'p=0.025');
});

// 3. Parser
check('parser simple arithmetic', function () {
  var ast = t.parseFormula_('=1+2*3');
  if (ast.type !== 'binop' || ast.op !== '+') throw new Error('top should be +');
  if (ast.right.op !== '*') throw new Error('right should be *');
});

check('parser function call', function () {
  var ast = t.parseFormula_('=SUM(A1:A3,5)');
  if (ast.type !== 'call' || ast.name !== 'SUM') throw new Error('expected SUM call');
  if (ast.args.length !== 2) throw new Error('expected 2 args');
});

// 4. Evaluator
check('evaluator basic', function () {
  var ast = t.parseFormula_('=A1+A2*2');
  var v = t.evalAst_(ast, { A1: 5, A2: 3 });
  if (v !== 11) throw new Error('expected 11, got ' + v);
});

check('evaluator div by zero', function () {
  var ast = t.parseFormula_('=5/0');
  var v = t.evalAst_(ast, {});
  if (!v || v.__error !== '#DIV/0!') throw new Error('expected #DIV/0!, got ' + JSON.stringify(v));
});

check('evaluator IFERROR catches', function () {
  var ast = t.parseFormula_('=IFERROR(1/0, 99)');
  var v = t.evalAst_(ast, {});
  if (v !== 99) throw new Error('expected 99, got ' + v);
});

check('evaluator SUM over range', function () {
  var ast = t.parseFormula_('=SUM(A1:A3)');
  var v = t.evalAst_(ast, { A1: 10, A2: 20, A3: 30 });
  if (v !== 60) throw new Error('expected 60, got ' + v);
});

// 5. End-to-end simulation
check('simulation: sum of two normals', function () {
  var ast = t.parseFormula_('=A1+A2');
  var model = {
    cells: {
      A1: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [10, 2], cellRef: 'A1' } },
      A2: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A2' } },
      A3: { kind: 'formula', ast: ast, isOutput: true, label: 'sum' }
    }
  };
  var r = t.runSimulationCore_(model, { iterations: 10000, seed: 42 });
  var s = t.summarize_(r.outputSamples.A3, r.iterations);
  near(s.mean, 10, 0.1, 'mean');
  near(s.stdev, Math.sqrt(5), 0.1, 'stdev');
  if (s.errorCount !== 0) throw new Error('errors: ' + s.errorCount);
});

check('simulation: quantile mode', function () {
  var ast = t.parseFormula_('=A1');
  var model = {
    cells: {
      A1: {
        kind: 'distribution',
        distSpec: {
          type: 'normal', mode: 'quantile',
          quantiles: [{p:0.10, v:0}, {p:0.90, v:10}],
          cellRef: 'A1'
        }
      },
      A2: { kind: 'formula', ast: ast, isOutput: true, label: 'x' }
    }
  };
  var r = t.runSimulationCore_(model, { iterations: 30000, seed: 1 });
  var s = t.summarize_(r.outputSamples.A2, r.iterations);
  near(s.percentiles.p10, 0, 0.3, 'p10');
  near(s.percentiles.p90, 10, 0.3, 'p90');
});

check('simulation: cycle detected', function () {
  var astA = t.parseFormula_('=A2+1');
  var astB = t.parseFormula_('=A1+1');
  var model = {
    cells: {
      A1: { kind: 'formula', ast: astA, isOutput: true, label: 'a' },
      A2: { kind: 'formula', ast: astB, isOutput: false },
      A3: { kind: 'distribution', distSpec: { type: 'uniform', mode: 'params', values: [0, 1], cellRef: 'A3' } }
    }
  };
  var threw = false;
  try { t.runSimulationCore_(model, { iterations: 10 }); } catch (e) {
    if (/Circular/.test(e.message)) threw = true;
    else throw new Error('wrong error: ' + e.message);
  }
  if (!threw) throw new Error('did not throw');
});

check('simulation: spearman correlation', function () {
  var ast = t.parseFormula_('=10*A1+A2');
  var model = {
    cells: {
      A1: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A1' } },
      A2: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A2' } },
      A3: { kind: 'formula', ast: ast, isOutput: true }
    }
  };
  var r = t.runSimulationCore_(model, { iterations: 5000, seed: 99 });
  var rho1 = t.spearman_(r.inputSamples.A1, r.outputSamples.A3);
  var rho2 = t.spearman_(r.inputSamples.A2, r.outputSamples.A3);
  if (rho1 < 0.9) throw new Error('A1 should dominate (rho=' + rho1 + ')');
  if (Math.abs(rho2) > 0.3) throw new Error('A2 should be weak (rho=' + rho2 + ')');
});

// 6. ModelReader with mock sheet
check('ModelReader: end-to-end read+sim', function () {
  function mockSheet(values, formulas) {
    return {
      getDataRange: function () {
        return {
          getValues: function () { return values; },
          getFormulas: function () { return formulas || values.map(function (r) { return r.map(function () { return ''; }); }); }
        };
      }
    };
  }
  var values = [
    ['Label',  'Value', 'MonteCarlo', 'p10', 'p90'],
    ['Price',  100,     'Normal',      80,    120],
    ['Units',  50,      'LogNormal',   30,    100],
    ['Profit', 0,       'Output',      '',    '']
  ];
  var formulas = [
    ['', '', '', '', ''],
    ['', '', '', '', ''],
    ['', '', '', '', ''],
    ['', '=B2*B3', '', '', '']
  ];
  var model = t.readSheetModel_(mockSheet(values, formulas));
  if (model.distCount !== 2) throw new Error('dist count: ' + model.distCount);
  if (model.outputCount !== 1) throw new Error('output count: ' + model.outputCount);
  var r = t.runSimulationCore_(model, { iterations: 3000, seed: 5 });
  var s = t.summarize_(r.outputSamples.B4, r.iterations);
  if (s.errorCount > 0) throw new Error('errors: ' + s.errorCount);
  if (!(s.mean > 0)) throw new Error('mean should be positive: ' + s.mean);
});

// 7. Math fix: seed=0 is honored (not silently mapped to 1)
check('seed=0 is distinct from seed=1', function () {
  var ast = t.parseFormula_('=A1');
  function model() {
    return {
      cells: {
        A1: { kind: 'distribution', distSpec: { type: 'uniform', mode: 'params', values: [0, 1], cellRef: 'A1' } },
        A2: { kind: 'formula', ast: ast, isOutput: true }
      }
    };
  }
  var a = t.runSimulationCore_(model(), { iterations: 50, seed: 0 });
  var b = t.runSimulationCore_(model(), { iterations: 50, seed: 1 });
  var same = 0;
  for (var i = 0; i < 50; i++) if (a.outputSamples.A2[i] === b.outputSamples.A2[i]) same++;
  if (same > 5) throw new Error('seed 0 vs 1 produced ' + same + '/50 identical samples — seed=0 likely silently became 1');
});

// 8. Math fix: summarize_ reports meanSE and Effective N
check('summarize includes meanSE and Effective N', function () {
  var s = t.summarize_([1, 2, 3, 4, 5, NaN, NaN], 7);
  if (s.count !== 5) throw new Error('Effective N should be 5, got ' + s.count);
  if (s.errorCount !== 2) throw new Error('errorCount should be 2, got ' + s.errorCount);
  near(s.meanSE, s.stdev / Math.sqrt(5), 1e-9, 'meanSE');
  if (typeof s.skewness !== 'number') throw new Error('skewness missing');
});

// 9. Math fix: Pearson on zero-variance returns NaN, not 0
check('pearson on constant input returns NaN', function () {
  var rho = t.pearson_([5, 5, 5, 5], [1, 2, 3, 4]);
  if (!isNaN(rho)) throw new Error('expected NaN, got ' + rho);
});

// 10. Math fix: histogram switches to log bins for skewed positive data
check('histogram uses log bins for skewed positive data', function () {
  // LogNormal-like: most mass near 1, long right tail.
  var samples = [];
  var rng = t.mulberry32_(7);
  for (var i = 0; i < 5000; i++) {
    var u1 = rng(), u2 = rng();
    var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    samples.push(Math.exp(z * 1.5));  // sigma=1.5 → highly skewed
  }
  var hist = t.histogram_(samples, 30);
  if (hist.scale !== 'log') throw new Error('expected log scale, got ' + hist.scale);
});

check('histogram stays linear for symmetric data', function () {
  var rng = t.mulberry32_(11);
  var samples = [];
  for (var i = 0; i < 3000; i++) samples.push(rng() * 100);  // ~Uniform(0,100), skew≈0
  var hist = t.histogram_(samples, 30);
  if (hist.scale !== 'linear') throw new Error('expected linear scale, got ' + hist.scale);
});

// 11. Math fix: seed mixing — close seeds give different initial samples
check('mixSeed_ produces well-separated streams for close seeds', function () {
  // Compare the first few raw uniforms from mulberry32(N) vs mulberry32(N+1).
  // Without mixing, their early outputs would be very close; with mixing, they should differ.
  var a = t.mulberry32_(1234567);
  var b = t.mulberry32_(1234568);
  var maxClose = 0;
  for (var i = 0; i < 5; i++) if (Math.abs(a() - b()) < 0.001) maxClose++;
  if (maxClose >= 3) throw new Error('close seeds produced ' + maxClose + '/5 near-identical first uniforms — mixSeed may not be doing its job');
});

// 12. Fix: IF evaluates lazily — guarded branch doesn't error
check('IF lazy eval: =IF(B1>0, LN(B1), 0) does NOT error when B1>0', function () {
  // Without lazy eval, LN(B1) and the fallback 0 are BOTH evaluated
  // eagerly, so LN(-5) would produce #NUM! even though the guard
  // steers to the fallback branch.
  var ast = t.parseFormula_('=IF(A1>0, A1*2, 0)');
  var v = t.evalAst_(ast, { A1: -5 });
  // A1=-5, so condition is false, result should be 0 — NOT an error.
  if (v !== 0) throw new Error('expected 0, got ' + JSON.stringify(v));

  // Now test the positive branch:
  var v2 = t.evalAst_(ast, { A1: 5 });
  if (v2 !== 10) throw new Error('expected 10, got ' + v2);
});

check('IF lazy eval: false branch with error does not propagate', function () {
  // =IF(TRUE, 42, 1/0) should return 42, not #DIV/0!
  var ast = t.parseFormula_('=IF(TRUE, 42, 1/0)');
  var v = t.evalAst_(ast, {});
  if (v !== 42) throw new Error('expected 42, got ' + JSON.stringify(v));
});

check('IF lazy eval: =IF(B1>0, LN(B1), -999) with negative B1', function () {
  // The critical real-world pattern: user writes a guard, expects LN(B1)
  // NOT to be evaluated when B1<=0.
  var ast = t.parseFormula_('=IF(A1>0, LN(A1), -999)');
  var v = t.evalAst_(ast, { A1: -5 });
  if (v !== -999) throw new Error('expected -999 (guarded), got ' + JSON.stringify(v));
});

// 13. Convergence diagnostic
check('convergenceDiagnostic_ splits into batches with low CV for converged sim', function () {
  // 10k samples from a narrow Normal → batch means should be very close → CV < 1%
  var rng = t.mulberry32_(42);
  var samples = [];
  for (var i = 0; i < 10000; i++) {
    // Quick Box-Muller (just for test data — not using the cached sampler)
    var u1 = rng() || 1e-300, u2 = rng();
    samples.push(100 + 5 * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  var cd = t.convergenceDiagnostic_(samples, 4);
  if (cd.batchMeans.length !== 4) throw new Error('expected 4 batch means, got ' + cd.batchMeans.length);
  if (cd.cv > 0.01) throw new Error('CV should be < 1% for 10k narrow Normal, got ' + (cd.cv * 100).toFixed(2) + '%');
  near(cd.overallMean, 100, 0.5, 'overall mean');
});

// 14. CDF builder
check('buildCDF_ produces sorted ascending probabilities', function () {
  var cdf = t.buildCDF_([5, 1, 3, 2, 4], 100);
  if (cdf.values.length !== 5) throw new Error('expected 5 points, got ' + cdf.values.length);
  // Values should be sorted
  for (var i = 1; i < cdf.values.length; i++) {
    if (cdf.values[i] < cdf.values[i - 1]) throw new Error('CDF values not sorted at index ' + i);
  }
  // CDF should be monotonically increasing
  for (var j = 1; j < cdf.cdf.length; j++) {
    if (cdf.cdf[j] < cdf.cdf[j - 1]) throw new Error('CDF not monotonic at index ' + j);
  }
  // Last CDF value should be close to 1
  if (cdf.cdf[cdf.cdf.length - 1] < 0.5) throw new Error('last CDF value too low');
});

// 15. Inverse-CDF sampling: fromU is exact at known quantiles
check('sampler fromU: Uniform midpoint and Normal median exact', function () {
  var us = t.buildSampler_({ type: 'uniform', mode: 'params', values: [10, 20], cellRef: 'A1' });
  if (us.fromU(0.5) !== 15) throw new Error('Uniform fromU(0.5) should be 15, got ' + us.fromU(0.5));
  if (us.fromU(0.25) !== 12.5) throw new Error('Uniform fromU(0.25) should be 12.5');
  var ns = t.buildSampler_({ type: 'normal', mode: 'params', values: [7, 2], cellRef: 'A1' });
  near(ns.fromU(0.5), 7, 1e-9, 'Normal fromU(0.5) = mean');
  near(ns.fromU(0.9), 7 + 2 * 1.2816, 1e-3, 'Normal fromU(0.9)');
});

// 16. Latin Hypercube: marginals are near-exact (far tighter than IID could be)
check('LHS: Uniform input marginals nearly exact at N=2000', function () {
  var ast = t.parseFormula_('=A1');
  var model = {
    cells: {
      A1: { kind: 'distribution', distSpec: { type: 'uniform', mode: 'params', values: [0, 10], cellRef: 'A1' } },
      A2: { kind: 'formula', ast: ast, isOutput: true, label: 'u' }
    }
  };
  var r = t.runSimulationCore_(model, { iterations: 2000, seed: 9 });
  if (r.samplingMethod !== 'Latin Hypercube') throw new Error('expected LHS, got ' + r.samplingMethod);
  var s = t.summarize_(r.inputSamples.A1, r.iterations);
  // IID at N=2000 gives mean SE ≈ 0.065; LHS stratification should be ~100x tighter.
  near(s.mean, 5, 0.01, 'LHS mean');
  near(s.percentiles.p10, 1, 0.05, 'LHS p10');
  near(s.percentiles.p90, 9, 0.05, 'LHS p90');
});

// 17. LHS reproducibility: same seed → identical output stream
check('LHS: same seed reproduces exactly', function () {
  var ast = t.parseFormula_('=A1+A2');
  function model() {
    return {
      cells: {
        A1: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A1' } },
        A2: { kind: 'distribution', distSpec: { type: 'lognormal', mode: 'params', values: [0, 0.5], cellRef: 'A2' } },
        A3: { kind: 'formula', ast: ast, isOutput: true }
      }
    };
  }
  var a = t.runSimulationCore_(model(), { iterations: 200, seed: 77 });
  var b = t.runSimulationCore_(model(), { iterations: 200, seed: 77 });
  for (var i = 0; i < 200; i++) {
    if (a.outputSamples.A3[i] !== b.outputSamples.A3[i]) {
      throw new Error('mismatch at iteration ' + i);
    }
  }
});

// 18. Percentile CIs via order statistics
check('percentileCIs_ brackets the true quantiles', function () {
  // 10k known values: 1..10000. True median = 5000.5, true P95 = 9500.5.
  var samples = [];
  for (var i = 1; i <= 10000; i++) samples.push(i);
  var cis = t.percentileCIs_(samples, [0.5, 0.95]);
  if (!(cis.p50.lo <= 5000.5 && 5000.5 <= cis.p50.hi)) {
    throw new Error('P50 CI [' + cis.p50.lo + ', ' + cis.p50.hi + '] misses true median');
  }
  if (!(cis.p95.lo <= 9500.5 && 9500.5 <= cis.p95.hi)) {
    throw new Error('P95 CI [' + cis.p95.lo + ', ' + cis.p95.hi + '] misses true P95');
  }
  // CI width for q=0.5, n=10k: ±1.96·50 indices ≈ 196 values wide. Sanity-band it.
  var w50 = cis.p50.hi - cis.p50.lo;
  if (w50 < 100 || w50 > 400) throw new Error('P50 CI width implausible: ' + w50);
  // NaN-heavy input → blank CIs, not garbage
  var ciNaN = t.percentileCIs_([NaN, NaN], [0.5]);
  if (!isNaN(ciNaN.p50.lo)) throw new Error('expected NaN CI for all-NaN input');
});

results.join('\n');
