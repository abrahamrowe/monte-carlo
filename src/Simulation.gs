/**
 * Simulation.gs
 *
 * Runs the Monte Carlo loop.
 *
 * Input: a model (from ModelReader) + options.
 * Output: sample arrays for each input and output, plus metadata.
 *
 * Errors during evaluation are recorded as NaN per iteration and counted
 * via errorCounts, so a single bad path never kills the whole run.
 */

function runSimulationCore_(model, options) {
  options = options || {};
  var iterations = options.iterations > 0 ? Math.floor(options.iterations) : 10000;
  var seed = (options.seed !== undefined && options.seed !== null)
    ? (options.seed >>> 0)
    : (Date.now() & 0xFFFFFFFF);
  var progress = options.progress || null;

  var plan = buildEvalPlan_(model);

  // Pre-build samplers once (this also runs validation).
  var samplers = {};
  for (var d = 0; d < plan.distributionRefs.length; d++) {
    var dref = plan.distributionRefs[d];
    samplers[dref] = buildSampler_(model.cells[dref].distSpec);
  }

  // Seed the state map with static values.
  var state = {};
  for (var s = 0; s < plan.staticRefs.length; s++) {
    var sref = plan.staticRefs[s];
    state[sref] = model.cells[sref].value;
  }

  // Identify outputs.
  var outputs = [];
  for (var ref in model.cells) {
    if (model.cells[ref].isOutput) outputs.push(ref);
  }
  if (outputs.length === 0) {
    throw new Error('No output cells marked. Add "Output" in the MonteCarlo column for at least one row.');
  }
  if (plan.distributionRefs.length === 0) {
    throw new Error('No distribution cells defined. Add a distribution keyword (Normal, LogNormal, Uniform, or Discrete) in the MonteCarlo column for at least one row.');
  }

  // Pre-allocate sample arrays.
  var outputSamples = {};
  for (var o = 0; o < outputs.length; o++) outputSamples[outputs[o]] = new Array(iterations);
  var inputSamples = {};
  for (var d2 = 0; d2 < plan.distributionRefs.length; d2++) {
    inputSamples[plan.distributionRefs[d2]] = new Array(iterations);
  }

  var rng = mulberry32_(seed);
  resetNormalCache_();  // ensure no stale cache from a previous run leaks in

  // Error counts per output.
  var errorCounts = {};
  for (var o2 = 0; o2 < outputs.length; o2++) errorCounts[outputs[o2]] = 0;

  var startTime = Date.now();

  for (var iter = 0; iter < iterations; iter++) {
    // Sample all distributions for this iteration.
    for (var di = 0; di < plan.distributionRefs.length; di++) {
      var dr = plan.distributionRefs[di];
      var v = samplers[dr].sample(rng);
      state[dr] = v;
      inputSamples[dr][iter] = v;
    }

    // Evaluate formula cells in topological order.
    for (var fi = 0; fi < plan.formulaOrder.length; fi++) {
      var fr = plan.formulaOrder[fi];
      state[fr] = evalAst_(model.cells[fr].ast, state);
    }

    // Collect outputs.
    for (var oi = 0; oi < outputs.length; oi++) {
      var oref = outputs[oi];
      var ov = state[oref];
      if (isError_(ov)) {
        outputSamples[oref][iter] = NaN;
        errorCounts[oref]++;
      } else if (typeof ov === 'number') {
        if (isNaN(ov) || !isFinite(ov)) {
          outputSamples[oref][iter] = NaN;
          errorCounts[oref]++;
        } else {
          outputSamples[oref][iter] = ov;
        }
      } else {
        var n = numericOrNull_(ov);
        if (n === null) {
          outputSamples[oref][iter] = NaN;
          errorCounts[oref]++;
        } else {
          outputSamples[oref][iter] = n;
        }
      }
    }

    if (progress && iter > 0 && iter % 1000 === 0) {
      progress(iter, iterations);
    }
  }

  var elapsedMs = Date.now() - startTime;

  // Gather labels for display (fall back to cell ref if no label).
  function labelFor(ref) {
    var c = model.cells[ref];
    return (c && c.label) ? c.label : ref;
  }

  return {
    iterations: iterations,
    seed: seed,
    elapsedMs: elapsedMs,
    outputSamples: outputSamples,
    inputSamples: inputSamples,
    errorCounts: errorCounts,
    outputRefs: outputs,
    inputRefs: plan.distributionRefs,
    labelOf: labelFor,
    describeDist: function (ref) {
      return samplers[ref] ? samplers[ref].describe() : '';
    }
  };
}

// =====================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runSimulationCore_: runSimulationCore_ };
}
