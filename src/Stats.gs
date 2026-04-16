/**
 * Stats.gs
 *
 * Summary statistics and Spearman rank correlation.
 *
 * All functions treat NaN as "missing" and exclude them from calculations.
 */

/**
 * Returns summary stats over a sample array.
 *
 * Fields:
 *   count        — number of finite samples (the "effective N")
 *   errorCount   — totalIterations - count (iterations where the model errored)
 *   mean         — arithmetic mean of the finite samples.
 *                  NOTE: when errorCount > 0 this is E[output | output is finite],
 *                  not the unconditional expectation. Bias direction depends on
 *                  whether errors correlate with one tail.
 *   meanSE       — Monte Carlo standard error of the mean: stdev / sqrt(count).
 *                  ±1.96·meanSE is a 95% CI on `mean` (under independence).
 *   stdev        — sample standard deviation (Bessel-corrected, n-1 denom).
 *   skewness     — sample skewness; we use it to pick log-vs-linear histograms.
 *   percentiles  — Hyndman-Fan type 7 (Excel/Sheets compatible).
 */
function summarize_(samples, totalIterations) {
  var clean = [];
  for (var i = 0; i < samples.length; i++) {
    var v = samples[i];
    if (typeof v === 'number' && !isNaN(v) && isFinite(v)) clean.push(v);
  }
  var n = clean.length;
  var errorCount = totalIterations - n;

  if (n === 0) {
    return {
      count: 0, errorCount: errorCount,
      mean: NaN, meanSE: NaN, median: NaN, stdev: NaN, skewness: NaN,
      min: NaN, max: NaN,
      percentiles: { p1: NaN, p5: NaN, p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, p95: NaN, p99: NaN }
    };
  }

  var sum = 0;
  var min = Infinity, max = -Infinity;
  for (var j = 0; j < n; j++) {
    sum += clean[j];
    if (clean[j] < min) min = clean[j];
    if (clean[j] > max) max = clean[j];
  }
  var mean = sum / n;

  var ssq = 0;
  for (var k = 0; k < n; k++) { var d = clean[k] - mean; ssq += d * d; }
  var stdev = n > 1 ? Math.sqrt(ssq / (n - 1)) : 0;
  var meanSE = n > 1 ? stdev / Math.sqrt(n) : 0;

  // Adjusted Fisher-Pearson sample skewness (consistent with Bessel-corrected stdev).
  var skewness = 0;
  if (stdev > 0 && n > 2) {
    var sk = 0;
    for (var t = 0; t < n; t++) {
      var dt = (clean[t] - mean) / stdev;
      sk += dt * dt * dt;
    }
    skewness = (n / ((n - 1) * (n - 2))) * sk;
  }

  var sorted = clean.slice().sort(function (a, b) { return a - b; });

  return {
    count: n,
    errorCount: errorCount,
    mean: mean,
    meanSE: meanSE,
    median: quantile_(sorted, 0.5),
    stdev: stdev,
    skewness: skewness,
    min: min,
    max: max,
    percentiles: {
      p1:  quantile_(sorted, 0.01),
      p5:  quantile_(sorted, 0.05),
      p10: quantile_(sorted, 0.10),
      p25: quantile_(sorted, 0.25),
      p50: quantile_(sorted, 0.50),
      p75: quantile_(sorted, 0.75),
      p90: quantile_(sorted, 0.90),
      p95: quantile_(sorted, 0.95),
      p99: quantile_(sorted, 0.99)
    }
  };
}

function quantile_(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  var idx = q * (sorted.length - 1);
  var lo = Math.floor(idx);
  var hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Rank values (1-based). Tied values get average rank.
 * Returns an array the same length as input.
 */
function rank_(arr) {
  var n = arr.length;
  var indexed = new Array(n);
  for (var i = 0; i < n; i++) indexed[i] = { v: arr[i], i: i };
  indexed.sort(function (a, b) { return a.v - b.v; });
  var ranks = new Array(n);
  var p = 0;
  while (p < n) {
    var q = p;
    while (q + 1 < n && indexed[q + 1].v === indexed[p].v) q++;
    var avg = (p + q) / 2 + 1;  // 1-based
    for (var k = p; k <= q; k++) ranks[indexed[k].i] = avg;
    p = q + 1;
  }
  return ranks;
}

function pearson_(x, y) {
  var n = x.length;
  if (n < 2 || y.length !== n) return NaN;
  var sx = 0, sy = 0;
  for (var i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  var mx = sx / n, my = sy / n;
  var num = 0, dx = 0, dy = 0;
  for (var j = 0; j < n; j++) {
    var a = x[j] - mx, b = y[j] - my;
    num += a * b;
    dx  += a * a;
    dy  += b * b;
  }
  // Zero variance on either side → correlation is undefined, not zero.
  if (dx === 0 || dy === 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

/**
 * Spearman rank correlation. NaN pairs are dropped.
 */
function spearman_(x, y) {
  var xs = [], ys = [];
  for (var i = 0; i < x.length; i++) {
    var a = x[i], b = y[i];
    if (typeof a === 'number' && !isNaN(a) && isFinite(a) &&
        typeof b === 'number' && !isNaN(b) && isFinite(b)) {
      xs.push(a);
      ys.push(b);
    }
  }
  if (xs.length < 2) return NaN;
  return pearson_(rank_(xs), rank_(ys));
}

/**
 * Bin samples into buckets.
 *
 * If the sample is highly skewed (|skewness| > 1) AND all positive, we use
 * LOG-spaced bins. Otherwise equal-width. Skewed outputs (LogNormal, payoffs,
 * loss distributions) plotted on linear bins look like one giant bar at the
 * mode and 39 empty bins — log-spacing is much more readable.
 *
 * Returns:
 *   {
 *     edges:     [...n+1 boundaries],
 *     counts:    [...n counts],
 *     midpoints: [...n midpoints],
 *     scale:     'linear' | 'log'
 *   }
 */
function histogram_(samples, numBins, skewnessHint) {
  numBins = numBins || 40;
  var clean = [];
  for (var i = 0; i < samples.length; i++) {
    var v = samples[i];
    if (typeof v === 'number' && !isNaN(v) && isFinite(v)) clean.push(v);
  }
  if (clean.length === 0) {
    return { edges: [], counts: [], midpoints: [], scale: 'linear' };
  }
  var min = clean[0], max = clean[0];
  for (var j = 1; j < clean.length; j++) {
    if (clean[j] < min) min = clean[j];
    if (clean[j] > max) max = clean[j];
  }
  if (min === max) {
    return { edges: [min, max], counts: [clean.length], midpoints: [min], scale: 'linear' };
  }

  // Decide log vs linear: log-space iff skewed AND all positive AND range spans
  // more than ~10× (otherwise log buys you nothing).
  var skew = (typeof skewnessHint === 'number' && !isNaN(skewnessHint))
    ? skewnessHint : skewnessOf_(clean);
  var useLog = (Math.abs(skew) > 1) && (min > 0) && (max / min > 10);

  var edges = new Array(numBins + 1);
  var counts = new Array(numBins);
  for (var z = 0; z < numBins; z++) counts[z] = 0;

  if (useLog) {
    var lmin = Math.log(min);
    var lmax = Math.log(max);
    var lstep = (lmax - lmin) / numBins;
    for (var k = 0; k <= numBins; k++) edges[k] = Math.exp(lmin + k * lstep);
    edges[numBins] = max;
    for (var p = 0; p < clean.length; p++) {
      var idx = Math.floor((Math.log(clean[p]) - lmin) / lstep);
      if (idx >= numBins) idx = numBins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
  } else {
    var step = (max - min) / numBins;
    for (var k2 = 0; k2 <= numBins; k2++) edges[k2] = min + k2 * step;
    edges[numBins] = max;
    for (var p2 = 0; p2 < clean.length; p2++) {
      var idx2 = Math.floor((clean[p2] - min) / step);
      if (idx2 >= numBins) idx2 = numBins - 1;
      if (idx2 < 0) idx2 = 0;
      counts[idx2]++;
    }
  }

  var midpoints = new Array(numBins);
  for (var q = 0; q < numBins; q++) {
    midpoints[q] = useLog
      ? Math.sqrt(edges[q] * edges[q + 1])  // geometric midpoint for log bins
      : (edges[q] + edges[q + 1]) / 2;
  }

  return { edges: edges, counts: counts, midpoints: midpoints, scale: useLog ? 'log' : 'linear' };
}

function skewnessOf_(clean) {
  var n = clean.length;
  if (n < 3) return 0;
  var sum = 0;
  for (var i = 0; i < n; i++) sum += clean[i];
  var mean = sum / n;
  var ssq = 0;
  for (var j = 0; j < n; j++) { var d = clean[j] - mean; ssq += d * d; }
  var sd = Math.sqrt(ssq / (n - 1));
  if (sd === 0) return 0;
  var sk = 0;
  for (var k = 0; k < n; k++) {
    var dk = (clean[k] - mean) / sd;
    sk += dk * dk * dk;
  }
  return (n / ((n - 1) * (n - 2))) * sk;
}

/**
 * Convergence diagnostic: split samples into nBatches equal chunks, compute
 * the mean of each, and return the coefficient of variation (CV) of those
 * batch means. CV < ~1% suggests convergence; higher means "run more
 * iterations."
 *
 * Returns { batchMeans: [Number,...], overallMean: Number, cv: Number }.
 * cv is expressed as a fraction (0.01 = 1%).
 */
function convergenceDiagnostic_(samples, nBatches) {
  nBatches = nBatches || 4;
  var clean = [];
  for (var i = 0; i < samples.length; i++) {
    var v = samples[i];
    if (typeof v === 'number' && !isNaN(v) && isFinite(v)) clean.push(v);
  }
  if (clean.length < nBatches) {
    return { batchMeans: [], overallMean: NaN, cv: NaN };
  }
  var batchSize = Math.floor(clean.length / nBatches);
  var batchMeans = [];
  var totalSum = 0;
  for (var b = 0; b < nBatches; b++) {
    var start = b * batchSize;
    var end = (b === nBatches - 1) ? clean.length : start + batchSize;
    var sum = 0;
    for (var j = start; j < end; j++) sum += clean[j];
    var bm = sum / (end - start);
    batchMeans.push(bm);
    totalSum += sum;
  }
  var overallMean = totalSum / clean.length;
  // SD of batch means
  var ssq = 0;
  for (var k = 0; k < nBatches; k++) {
    var d = batchMeans[k] - overallMean;
    ssq += d * d;
  }
  var sdBatch = nBatches > 1 ? Math.sqrt(ssq / (nBatches - 1)) : 0;
  var cv = (overallMean !== 0) ? sdBatch / Math.abs(overallMean) : (sdBatch === 0 ? 0 : Infinity);
  return { batchMeans: batchMeans, overallMean: overallMean, cv: cv };
}

/**
 * Build a CDF table from samples: sorted values + continuity-corrected
 * cumulative probabilities, subsampled to at most maxPoints for charting.
 *
 * Returns { values: [...], cdf: [...] }.
 */
function buildCDF_(samples, maxPoints) {
  maxPoints = maxPoints || 200;
  var clean = [];
  for (var i = 0; i < samples.length; i++) {
    var v = samples[i];
    if (typeof v === 'number' && !isNaN(v) && isFinite(v)) clean.push(v);
  }
  if (clean.length === 0) return { values: [], cdf: [] };
  clean.sort(function (a, b) { return a - b; });
  var n = clean.length;
  // Subsample evenly
  var step = Math.max(1, Math.floor(n / maxPoints));
  var values = [], cdf = [];
  for (var j = 0; j < n; j += step) {
    values.push(clean[j]);
    cdf.push((j + 0.5) / n);
  }
  // Always include the last point
  if (values[values.length - 1] !== clean[n - 1]) {
    values.push(clean[n - 1]);
    cdf.push((n - 0.5) / n);
  }
  return { values: values, cdf: cdf };
}

// =====================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    summarize_: summarize_,
    quantile_: quantile_,
    rank_: rank_,
    pearson_: pearson_,
    spearman_: spearman_,
    histogram_: histogram_,
    convergenceDiagnostic_: convergenceDiagnostic_,
    buildCDF_: buildCDF_
  };
}
