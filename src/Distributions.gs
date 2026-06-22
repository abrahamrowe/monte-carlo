/**
 * Distributions.gs
 *
 * Probability distributions (Normal, LogNormal, Uniform, Discrete),
 * seedable PRNG (mulberry32), and quantile-mode parameter solvers.
 *
 * All internal functions end with `_` so Apps Script hides them from
 * the custom-function autocomplete in the user's sheet.
 */

// =====================================================================
// PRNG — mulberry32
// =====================================================================

/**
 * 32-bit Murmur3-style finalizer. Mixes a structured seed (e.g. low
 * bits of Date.now()) into something with good avalanche before we hand
 * it to the PRNG. Without this, two consecutive auto-seeded runs can
 * have correlated initial samples.
 */
function mixSeed_(seed) {
  var z = seed >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
  z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
  z = (z ^ (z >>> 16)) >>> 0;
  return z;
}

/**
 * Returns a seedable PRNG with uniform [0, 1) output.
 * Seed must be a 32-bit unsigned integer (we coerce via >>> 0).
 * The seed is mixed via mixSeed_ first so structurally-similar seeds
 * (e.g. consecutive Date.now() values) produce well-separated streams.
 */
function mulberry32_(seed) {
  var state = mixSeed_(seed >>> 0);
  return function () {
    state = (state + 0x6D2B79F5) >>> 0;
    var t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================
// Inverse normal CDF — Acklam's approximation
// Accurate to ~1.15e-9 across the full range.
// =====================================================================

function inverseNormalCDF_(p) {
  if (!(p > 0 && p < 1)) {
    throw new Error('inverseNormalCDF: p must be in (0, 1), got ' + p);
  }

  var a = [-3.969683028665376e+01, 2.209460984245205e+02,
           -2.759285104469687e+02, 1.383577518672690e+02,
           -3.066479806614716e+01, 2.506628277459239e+00];
  var b = [-5.447609879822406e+01, 1.615858368580409e+02,
           -1.556989798598866e+02, 6.680131188771972e+01,
           -1.328068155288572e+01];
  var c = [-7.784894002430293e-03, -3.223964580411365e-01,
           -2.400758277161838e+00, -2.549732539343734e+00,
            4.374664141464968e+00,  2.938163982698783e+00];
  var d = [ 7.784695709041462e-03,  3.224671290700398e-01,
            2.445134137142996e+00,  3.754408661907416e+00];

  var plow  = 0.02425;
  var phigh = 1 - plow;

  if (p < plow) {
    var q1 = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q1+c[1])*q1+c[2])*q1+c[3])*q1+c[4])*q1+c[5]) /
           ((((d[0]*q1+d[1])*q1+d[2])*q1+d[3])*q1+1);
  } else if (p <= phigh) {
    var q2 = p - 0.5;
    var r  = q2 * q2;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q2 /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    var q3 = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q3+c[1])*q3+c[2])*q3+c[3])*q3+c[4])*q3+c[5]) /
            ((((d[0]*q3+d[1])*q3+d[2])*q3+d[3])*q3+1);
  }
}

// =====================================================================
// Samplers
// =====================================================================

// Every distribution samples via an inverse-CDF transform of a SINGLE
// uniform. One uniform per draw keeps the RNG stream aligned across
// inputs and makes Latin Hypercube stratification correct — rejection
// methods (Marsaglia polar, ziggurat) consume a variable number of
// uniforms per draw, which would scramble a stratified stream.

/** Clamp a uniform into the open interval (0,1) so inverse CDFs stay finite. */
function clampUnit_(u) {
  if (!(u > 0)) return 1e-15;          // also catches NaN
  if (u >= 1) return 1 - 1e-15;
  return u;
}

function sampleUniform_(rng, a, b) {
  return a + (b - a) * rng();
}

function normalFromU_(u, mean, sd) {
  return mean + sd * inverseNormalCDF_(clampUnit_(u));
}

function sampleNormal_(rng, mean, sd) {
  return normalFromU_(rng(), mean, sd);
}

function sampleLogNormal_(rng, mu, sigma) {
  return Math.exp(normalFromU_(rng(), mu, sigma));
}

function discreteFromU_(u, values, cumWeights) {
  // cumWeights is a pre-normalized cumulative distribution (ends at 1).
  for (var i = 0; i < cumWeights.length; i++) {
    if (u < cumWeights[i]) return values[i];
  }
  return values[values.length - 1];
}

function sampleDiscrete_(rng, values, cumWeights) {
  return discreteFromU_(rng(), values, cumWeights);
}

// =====================================================================
// Quantile-mode solvers
// =====================================================================

function solveNormalFromQuantiles_(p1, v1, p2, v2) {
  var z1 = inverseNormalCDF_(p1);
  var z2 = inverseNormalCDF_(p2);
  var dz = z2 - z1;
  if (Math.abs(dz) < 1e-6) {
    throw new Error('Quantile percentiles are too close together (p' +
      (p1 * 100) + ' and p' + (p2 * 100) + ' produce nearly identical z-scores). ' +
      'Use percentiles at least a few points apart, e.g. p10/p90 or p25/p75.');
  }
  var sd = (v2 - v1) / dz;
  var mean = v1 - z1 * sd;
  return { mean: mean, sd: sd };
}

function solveLogNormalFromQuantiles_(p1, v1, p2, v2) {
  if (v1 <= 0 || v2 <= 0) {
    throw new Error('LogNormal quantile values must be positive, got ' + v1 + ', ' + v2);
  }
  var params = solveNormalFromQuantiles_(p1, Math.log(v1), p2, Math.log(v2));
  return { mu: params.mean, sigma: params.sd };
}

function solveUniformFromQuantiles_(p1, v1, p2, v2) {
  // CDF of Uniform(a, b): F(x) = (x - a) / (b - a) for x in [a, b].
  // Given F(v1) = p1 and F(v2) = p2:
  //   (v2 - v1) = (p2 - p1) * (b - a)   =>   b - a = (v2 - v1)/(p2 - p1)
  //   a = v1 - p1 * (b - a)
  var range = (v2 - v1) / (p2 - p1);
  var a = v1 - p1 * range;
  var b = v2 + (1 - p2) * range;
  return { a: a, b: b };
}

// =====================================================================
// Build a sampler function from a distribution spec
// =====================================================================

/**
 * spec shape (produced by ModelReader):
 *   { type: 'normal'|'lognormal'|'uniform'|'discrete',
 *     mode: 'params'|'quantile',
 *     values: [...],                        // for params mode
 *     quantiles: [{p, v}, {p, v}],          // for quantile mode
 *     cellRef: 'B5' }                       // for error messages
 *
 * Returns: { sample: (rng) => number, describe: () => string }
 */
function buildSampler_(spec) {
  validateDistSpec_(spec);

  var cellRef = spec.cellRef || '(unknown cell)';
  var type = String(spec.type).toLowerCase();

  if (type === 'normal') {
    var np = (spec.mode === 'quantile')
      ? solveNormalFromQuantiles_(spec.quantiles[0].p, spec.quantiles[0].v,
                                  spec.quantiles[1].p, spec.quantiles[1].v)
      : { mean: spec.values[0], sd: spec.values[1] };
    if (!(np.sd > 0)) {
      throw new Error(cellRef + ': Normal sd must be positive, got ' + np.sd);
    }
    return {
      fromU: function (u) { return normalFromU_(u, np.mean, np.sd); },
      sample: function (rng) { return normalFromU_(rng(), np.mean, np.sd); },
      describe: function () { return 'Normal(mean=' + np.mean.toFixed(4) + ', sd=' + np.sd.toFixed(4) + ')'; }
    };
  }

  if (type === 'lognormal') {
    var lp = (spec.mode === 'quantile')
      ? solveLogNormalFromQuantiles_(spec.quantiles[0].p, spec.quantiles[0].v,
                                     spec.quantiles[1].p, spec.quantiles[1].v)
      : { mu: spec.values[0], sigma: spec.values[1] };
    if (!(lp.sigma > 0)) {
      throw new Error(cellRef + ': LogNormal sigma must be positive, got ' + lp.sigma);
    }
    return {
      fromU: function (u) { return Math.exp(normalFromU_(u, lp.mu, lp.sigma)); },
      sample: function (rng) { return Math.exp(normalFromU_(rng(), lp.mu, lp.sigma)); },
      describe: function () { return 'LogNormal(mu=' + lp.mu.toFixed(4) + ', sigma=' + lp.sigma.toFixed(4) + ')'; }
    };
  }

  if (type === 'uniform') {
    var up = (spec.mode === 'quantile')
      ? solveUniformFromQuantiles_(spec.quantiles[0].p, spec.quantiles[0].v,
                                   spec.quantiles[1].p, spec.quantiles[1].v)
      : { a: spec.values[0], b: spec.values[1] };
    if (!(up.b > up.a)) {
      throw new Error(cellRef + ': Uniform b must exceed a, got a=' + up.a + ', b=' + up.b);
    }
    return {
      fromU: function (u) { return up.a + (up.b - up.a) * u; },
      sample: function (rng) { return up.a + (up.b - up.a) * rng(); },
      describe: function () { return 'Uniform(' + up.a.toFixed(4) + ', ' + up.b.toFixed(4) + ')'; }
    };
  }

  if (type === 'discrete') {
    // spec.values is [[x1, w1], [x2, w2], ...]
    var xs = [];
    var ws = [];
    for (var i = 0; i < spec.values.length; i++) {
      xs.push(spec.values[i][0]);
      ws.push(spec.values[i][1]);
    }
    var total = 0;
    for (var j = 0; j < ws.length; j++) total += ws[j];
    if (!(total > 0)) {
      throw new Error(cellRef + ': Discrete weights must sum to > 0, got ' + total);
    }
    var cum = new Array(ws.length);
    var running = 0;
    for (var k = 0; k < ws.length; k++) {
      running += ws[k] / total;
      cum[k] = running;
    }
    cum[cum.length - 1] = 1;
    return {
      fromU: function (u) { return discreteFromU_(u, xs, cum); },
      sample: function (rng) { return discreteFromU_(rng(), xs, cum); },
      describe: function () { return 'Discrete(' + xs.length + ' outcomes)'; }
    };
  }

  throw new Error(cellRef + ': Unknown distribution type "' + spec.type + '"');
}

// =====================================================================
// Validation (called up front, before simulation starts)
// =====================================================================

function validateDistSpec_(spec) {
  var cellRef = spec.cellRef || '(unknown cell)';
  var type = String(spec.type || '').toLowerCase();

  if (['normal', 'lognormal', 'uniform', 'discrete'].indexOf(type) < 0) {
    throw new Error(cellRef + ': Unknown distribution "' + spec.type + '". ' +
                    'Supported: Normal, LogNormal, Uniform, Discrete.');
  }

  if (spec.mode === 'quantile') {
    if (type === 'discrete') {
      throw new Error(cellRef + ': Discrete does not support quantile mode.');
    }
    if (!spec.quantiles || spec.quantiles.length !== 2) {
      throw new Error(cellRef + ': Quantile mode requires exactly 2 quantile columns (e.g. p10, p90).');
    }
    var q1 = spec.quantiles[0];
    var q2 = spec.quantiles[1];
    if (!(q1.p > 0 && q1.p < 1 && q2.p > 0 && q2.p < 1)) {
      throw new Error(cellRef + ': Quantile labels must be strictly between p0 and p100, got p' +
                      (q1.p * 100) + ' and p' + (q2.p * 100) + '.');
    }
    if (!(q1.p < q2.p)) {
      throw new Error(cellRef + ': Quantile labels must be in ascending order, got p' +
                      (q1.p * 100) + ' then p' + (q2.p * 100) + '.');
    }
    if (!(q1.v < q2.v)) {
      throw new Error(cellRef + ': Quantile values must be in ascending order, got ' +
                      q1.v + ' then ' + q2.v + '.');
    }
    if (!isFinite(q1.v) || !isFinite(q2.v)) {
      throw new Error(cellRef + ': Quantile values must be finite numbers.');
    }
    return;
  }

  // Parameter mode
  if (type === 'normal' || type === 'lognormal' || type === 'uniform') {
    if (!spec.values || spec.values.length !== 2) {
      throw new Error(cellRef + ': ' + spec.type + ' requires exactly 2 parameters.');
    }
    if (!isFinite(spec.values[0]) || !isFinite(spec.values[1])) {
      throw new Error(cellRef + ': ' + spec.type + ' parameters must be finite numbers, got ' +
                      spec.values[0] + ', ' + spec.values[1]);
    }
  }

  if (type === 'discrete') {
    if (!spec.values || spec.values.length === 0) {
      throw new Error(cellRef + ': Discrete requires at least one (value, weight) pair.');
    }
    for (var i = 0; i < spec.values.length; i++) {
      var pair = spec.values[i];
      if (!pair || pair.length !== 2) {
        throw new Error(cellRef + ': Discrete values must be (value, weight) pairs.');
      }
      if (!isFinite(pair[0]) || !isFinite(pair[1]) || pair[1] < 0) {
        throw new Error(cellRef + ': Discrete entry ' + (i + 1) +
                        ' has invalid value/weight (' + pair[0] + ', ' + pair[1] + ').');
      }
    }
  }
}

// =====================================================================
// Node-only exports (stripped out by the Apps Script bundler).
// =====================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mixSeed_: mixSeed_,
    mulberry32_: mulberry32_,
    inverseNormalCDF_: inverseNormalCDF_,
    sampleUniform_: sampleUniform_,
    sampleNormal_: sampleNormal_,
    sampleLogNormal_: sampleLogNormal_,
    sampleDiscrete_: sampleDiscrete_,
    normalFromU_: normalFromU_,
    discreteFromU_: discreteFromU_,
    clampUnit_: clampUnit_,
    solveNormalFromQuantiles_: solveNormalFromQuantiles_,
    solveLogNormalFromQuantiles_: solveLogNormalFromQuantiles_,
    solveUniformFromQuantiles_: solveUniformFromQuantiles_,
    buildSampler_: buildSampler_,
    validateDistSpec_: validateDistSpec_
  };
}
