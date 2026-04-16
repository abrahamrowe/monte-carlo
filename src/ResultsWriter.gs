/**
 * ResultsWriter.gs
 *
 * Writes simulation output to three sheets:
 *   - "MC Results"     — summary stats + histograms
 *   - "MC Sensitivity" — Spearman rank correlations (inputs × outputs)
 *   - "MC Samples"     — raw per-iteration values
 *
 * Existing sheets of those names are cleared and re-populated so
 * running the simulation twice doesn't pile up stale output.
 *
 * This file touches SpreadsheetApp APIs and is only meaningful inside
 * a Google Apps Script. The Node test harness skips it.
 */

var MC_SHEET_RESULTS     = 'MC Results';
var MC_SHEET_SENSITIVITY = 'MC Sensitivity';
var MC_SHEET_SAMPLES     = 'MC Samples';

/** Guard against NaN/Infinity reaching setValues(), which would write the string "NaN". */
function safe_(v) {
  return (typeof v === 'number' && !isFinite(v)) ? '' : v;
}

function writeAllResults_(spreadsheet, simResult) {
  var resultsSheet = getOrResetSheet_(spreadsheet, MC_SHEET_RESULTS);
  var sensSheet    = getOrResetSheet_(spreadsheet, MC_SHEET_SENSITIVITY);
  var samplesSheet = getOrResetSheet_(spreadsheet, MC_SHEET_SAMPLES);

  writeResultsSheet_(resultsSheet, simResult);
  writeSensitivitySheet_(sensSheet, simResult);
  writeSamplesSheet_(samplesSheet, simResult);
}

function getOrResetSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (sheet) {
    sheet.clear();
    // Remove any embedded charts too
    var charts = sheet.getCharts();
    for (var i = 0; i < charts.length; i++) sheet.removeChart(charts[i]);
  } else {
    sheet = spreadsheet.insertSheet(name);
  }
  return sheet;
}

// ---------------------------------------------------------------------
// Results sheet: metadata + summary stats + histograms
// ---------------------------------------------------------------------

function writeResultsSheet_(sheet, sim) {
  var stats = {};
  for (var i = 0; i < sim.outputRefs.length; i++) {
    var oref = sim.outputRefs[i];
    stats[oref] = summarize_(sim.outputSamples[oref], sim.iterations);
  }

  // Row 1: title
  sheet.getRange(1, 1).setValue('Monte Carlo Simulation Results');
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);

  // Row 2-3: run metadata
  sheet.getRange(2, 1, 1, 2).setValues([['Run at', new Date()]]);
  sheet.getRange(3, 1, 1, 2).setValues([['Iterations', sim.iterations]]);
  sheet.getRange(4, 1, 1, 2).setValues([['Seed', sim.seed]]);
  sheet.getRange(5, 1, 1, 2).setValues([['Elapsed (ms)', sim.elapsedMs]]);

  // Output stats table starting at row 7
  // "Mean SE" is the Monte Carlo standard error of the mean (stdev/√n_eff).
  // ±1.96·MeanSE gives a ~95% CI around the reported Mean.
  // "Eff N" is the count of finite samples (totalIterations - errors).
  var statsHeader = ['Output', 'Cell', 'Mean', 'Mean SE', 'Median', 'StDev', 'Min',
                     'P1', 'P5', 'P10', 'P25', 'P50', 'P75', 'P90', 'P95', 'P99',
                     'Max', 'Eff N', 'Errors'];
  var headerRow = 7;
  sheet.getRange(headerRow, 1, 1, statsHeader.length).setValues([statsHeader]).setFontWeight('bold');

  var rows = [];
  for (var j = 0; j < sim.outputRefs.length; j++) {
    var ref = sim.outputRefs[j];
    var s = stats[ref];
    rows.push([
      sim.labelOf(ref), ref,
      safe_(s.mean), safe_(s.meanSE), safe_(s.median), safe_(s.stdev), safe_(s.min),
      safe_(s.percentiles.p1),  safe_(s.percentiles.p5),  safe_(s.percentiles.p10),
      safe_(s.percentiles.p25), safe_(s.percentiles.p50), safe_(s.percentiles.p75),
      safe_(s.percentiles.p90), safe_(s.percentiles.p95), safe_(s.percentiles.p99),
      safe_(s.max), s.count, s.errorCount
    ]);
  }
  if (rows.length > 0) {
    sheet.getRange(headerRow + 1, 1, rows.length, statsHeader.length).setValues(rows);
  }

  // Caveat row: when any output has errorCount > 0, warn that Mean is conditional.
  var anyErrors = false;
  for (var jj = 0; jj < sim.outputRefs.length; jj++) {
    if (stats[sim.outputRefs[jj]].errorCount > 0) { anyErrors = true; break; }
  }
  if (anyErrors) {
    var caveatRow = headerRow + rows.length + 1;
    sheet.getRange(caveatRow, 1, 1, statsHeader.length).merge();
    sheet.getRange(caveatRow, 1).setValue(
      '⚠ Errors > 0 for some outputs. Reported Mean is E[output | output is finite] — ' +
      'NOT the unconditional expectation. If errors correlate with one tail, the mean is biased.'
    ).setFontStyle('italic').setFontColor('#B7791F').setWrap(true);
  }

  // Inputs summary starting a few rows below — includes sampled stats so users
  // can verify their distributions look right.
  var inputsStartRow = headerRow + rows.length + (anyErrors ? 4 : 3);
  sheet.getRange(inputsStartRow, 1).setValue('Distribution Inputs').setFontWeight('bold');
  var inputHeader = ['Input', 'Cell', 'Distribution', 'Sample Mean', 'Sample SD', 'Sample P10', 'Sample P90'];
  sheet.getRange(inputsStartRow + 1, 1, 1, inputHeader.length).setValues([inputHeader]).setFontWeight('bold');
  var inputRows = [];
  for (var k = 0; k < sim.inputRefs.length; k++) {
    var iref = sim.inputRefs[k];
    var ist = summarize_(sim.inputSamples[iref], sim.iterations);
    inputRows.push([
      sim.labelOf(iref), iref, sim.describeDist(iref),
      safe_(ist.mean), safe_(ist.stdev), safe_(ist.percentiles.p10), safe_(ist.percentiles.p90)
    ]);
  }
  if (inputRows.length > 0) {
    sheet.getRange(inputsStartRow + 2, 1, inputRows.length, inputHeader.length).setValues(inputRows);
  }

  // Convergence diagnostic: batch means + CV per output
  var convStartRow = inputsStartRow + inputRows.length + 4;
  sheet.getRange(convStartRow, 1).setValue('Convergence Diagnostic').setFontWeight('bold');
  sheet.getRange(convStartRow + 1, 1).setValue(
    'CV (coefficient of variation of batch means) below ~1% suggests the simulation has converged. ' +
    'If CV is high, re-run with more iterations.'
  ).setFontStyle('italic').setWrap(true);
  var nBatches = 4;
  var convHeader = ['Output', 'Batch 1', 'Batch 2', 'Batch 3', 'Batch 4', 'CV (%)'];
  sheet.getRange(convStartRow + 2, 1, 1, convHeader.length).setValues([convHeader]).setFontWeight('bold');
  var convRows = [];
  for (var ci = 0; ci < sim.outputRefs.length; ci++) {
    var cref = sim.outputRefs[ci];
    var cd = convergenceDiagnostic_(sim.outputSamples[cref], nBatches);
    var cr = [sim.labelOf(cref)];
    for (var cb = 0; cb < nBatches; cb++) cr.push(safe_(cd.batchMeans[cb]));
    cr.push(isFinite(cd.cv) ? cd.cv * 100 : '');
    convRows.push(cr);
  }
  if (convRows.length > 0) {
    sheet.getRange(convStartRow + 3, 1, convRows.length, convHeader.length).setValues(convRows);
    // Color the CV column: green < 1%, yellow 1-5%, red > 5%
    var cvColNum = convHeader.length;
    for (var cc = 0; cc < convRows.length; cc++) {
      var cvCell = sheet.getRange(convStartRow + 3 + cc, cvColNum);
      var cvVal = convRows[cc][cvColNum - 1];
      if (typeof cvVal === 'number') {
        if (cvVal < 1) cvCell.setBackground('#D4EDDA');        // green
        else if (cvVal < 5) cvCell.setBackground('#FFF3CD');   // yellow
        else cvCell.setBackground('#F8D7DA');                  // red
      }
    }
  }

  // Histograms + CDF charts: write bin tables far to the right, then create charts.
  writeHistogramsAndCharts_(sheet, sim, stats, convStartRow + convRows.length + 5);

  // Autoresize the main columns.
  for (var col = 1; col <= statsHeader.length; col++) sheet.autoResizeColumn(col);
}

function writeHistogramsAndCharts_(sheet, sim, stats, chartsStartRow) {
  // Bin tables + CDF tables live in columns Z onwards so they don't collide.
  // Layout per output: [hist midpoint, hist count, gap, cdf value, cdf prob]
  var binStartCol = 26;  // column Z
  var colsPerOutput = 6; // 2 hist + 1 gap + 2 CDF + 1 gap

  for (var i = 0; i < sim.outputRefs.length; i++) {
    var ref = sim.outputRefs[i];
    var samples = sim.outputSamples[ref];
    var hist = histogram_(samples, 40, stats[ref].skewness);

    if (hist.midpoints.length === 0) continue;

    var hcol = binStartCol + i * colsPerOutput;

    // --- Histogram bin table ---
    var scaleNote = hist.scale === 'log' ? ' (log-spaced bins)' : '';
    sheet.getRange(1, hcol, 1, 2).setValues([
      [sim.labelOf(ref) + scaleNote, 'Count']
    ]).setFontWeight('bold');

    var tableRows = [];
    for (var j = 0; j < hist.midpoints.length; j++) {
      tableRows.push([hist.midpoints[j], hist.counts[j]]);
    }
    sheet.getRange(2, hcol, tableRows.length, 2).setValues(tableRows);

    // Histogram chart
    var histRange = sheet.getRange(1, hcol, tableRows.length + 1, 2);
    var hAxisOpt = { title: hist.scale === 'log' ? 'Value (log scale)' : 'Value' };
    if (hist.scale === 'log') hAxisOpt.logScale = true;
    var histChart = sheet.newChart()
      .asColumnChart()
      .addRange(histRange)
      .setOption('title', sim.labelOf(ref) + ' — Histogram' +
                 (hist.scale === 'log' ? ' (log bins, skew=' + stats[ref].skewness.toFixed(1) + ')' : ''))
      .setOption('legend', { position: 'none' })
      .setOption('hAxis', hAxisOpt)
      .setOption('vAxis', { title: 'Count' })
      .setOption('bar', { groupWidth: '99%' })
      .setPosition(chartsStartRow + i * 40, 1, 0, 0)
      .build();
    sheet.insertChart(histChart);

    // --- CDF table ---
    var ccol = hcol + 3;  // gap of 1 column
    var cdf = buildCDF_(samples, 200);
    if (cdf.values.length > 0) {
      sheet.getRange(1, ccol, 1, 2).setValues([['Value', 'P(X ≤ x)']]).setFontWeight('bold');
      var cdfRows = [];
      for (var ci = 0; ci < cdf.values.length; ci++) {
        cdfRows.push([cdf.values[ci], cdf.cdf[ci]]);
      }
      sheet.getRange(2, ccol, cdfRows.length, 2).setValues(cdfRows);

      // CDF line chart
      var cdfRange = sheet.getRange(1, ccol, cdfRows.length + 1, 2);
      var cdfChart = sheet.newChart()
        .asLineChart()
        .addRange(cdfRange)
        .setOption('title', sim.labelOf(ref) + ' — CDF')
        .setOption('legend', { position: 'none' })
        .setOption('hAxis', { title: 'Value' })
        .setOption('vAxis', { title: 'Cumulative probability', minValue: 0, maxValue: 1 })
        .setOption('curveType', 'function')
        .setOption('pointSize', 0)
        .setOption('lineWidth', 2)
        .setPosition(chartsStartRow + i * 40 + 19, 1, 0, 0)
        .build();
      sheet.insertChart(cdfChart);
    }
  }
}

// ---------------------------------------------------------------------
// Sensitivity sheet
// ---------------------------------------------------------------------

function writeSensitivitySheet_(sheet, sim) {
  sheet.getRange(1, 1).setValue('Spearman Rank Correlation (inputs × outputs)').setFontWeight('bold');
  sheet.getRange(2, 1).setValue(
    '⚠ Spearman ρ measures MONOTONIC association only. ρ near 0 does NOT mean ' +
    '"this input doesn\'t matter" — it can still drive variance through non-monotonic ' +
    'effects (e.g. Y = X²) or interactions (e.g. Y = X₁·X₂ with both X_i symmetric). ' +
    'Use this as a screening tool, not as a variance decomposition.'
  ).setFontStyle('italic').setFontColor('#B7791F').setWrap(true);
  sheet.getRange(2, 1, 1, 6).merge();

  if (sim.inputRefs.length === 0 || sim.outputRefs.length === 0) return;

  // Header: first row is output labels.
  var header = ['Input \\ Output'];
  for (var j = 0; j < sim.outputRefs.length; j++) {
    header.push(sim.labelOf(sim.outputRefs[j]) + ' (' + sim.outputRefs[j] + ')');
  }
  sheet.getRange(4, 1, 1, header.length).setValues([header]).setFontWeight('bold');

  var rows = [];
  for (var i = 0; i < sim.inputRefs.length; i++) {
    var iref = sim.inputRefs[i];
    var row = [sim.labelOf(iref) + ' (' + iref + ')'];
    for (var k = 0; k < sim.outputRefs.length; k++) {
      var oref = sim.outputRefs[k];
      var corr = spearman_(sim.inputSamples[iref], sim.outputSamples[oref]);
      // NaN (zero-variance input) shows as blank; finite correlations pass through.
      row.push((typeof corr === 'number' && isFinite(corr)) ? corr : '');
    }
    rows.push(row);
  }
  sheet.getRange(5, 1, rows.length, header.length).setValues(rows);

  // Conditional coloring to make the matrix scannable.
  var dataRange = sheet.getRange(5, 2, rows.length, sim.outputRefs.length);
  var rule = SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue('#F4A582', SpreadsheetApp.InterpolationType.NUMBER, '-1')
    .setGradientMidpointWithValue('#FFFFFF', SpreadsheetApp.InterpolationType.NUMBER, '0')
    .setGradientMaxpointWithValue('#4393C3', SpreadsheetApp.InterpolationType.NUMBER, '1')
    .setRanges([dataRange])
    .build();
  var rules = sheet.getConditionalFormatRules();
  rules.push(rule);
  sheet.setConditionalFormatRules(rules);

  sheet.autoResizeColumns(1, header.length);

  // Tornado charts: one horizontal bar chart per output, inputs sorted by |ρ|.
  writeTornadoCharts_(sheet, sim, rows, 5 + rows.length + 3);
}

function writeTornadoCharts_(sheet, sim, corrRows, startRow) {
  // corrRows[i] = [inputLabel, rho_output1, rho_output2, ...] (same order as written above)
  if (corrRows.length === 0) return;

  var tornadoTableCol = sim.outputRefs.length + 4;  // to the right of the matrix
  var colsPerChart = 3;  // label + rho + gap

  for (var oi = 0; oi < sim.outputRefs.length; oi++) {
    var oref = sim.outputRefs[oi];
    var oLabel = sim.labelOf(oref);

    // Collect (inputLabel, rho) pairs and sort by |rho| descending
    var pairs = [];
    for (var ii = 0; ii < corrRows.length; ii++) {
      var rho = corrRows[ii][oi + 1];
      if (typeof rho === 'number' && isFinite(rho)) {
        pairs.push({ label: String(corrRows[ii][0]), rho: rho });
      }
    }
    pairs.sort(function (a, b) { return Math.abs(b.rho) - Math.abs(a.rho); });

    if (pairs.length === 0) continue;

    var tcol = tornadoTableCol + oi * colsPerChart;

    // Write table: header + data (sorted lowest |ρ| at top for bar chart orientation)
    sheet.getRange(1, tcol, 1, 2).setValues([['Input', oLabel + ' ρ']]).setFontWeight('bold');
    var tRows = [];
    // Reverse so highest |ρ| is at the bottom (bar charts plot bottom-up)
    for (var p = pairs.length - 1; p >= 0; p--) {
      tRows.push([pairs[p].label, pairs[p].rho]);
    }
    sheet.getRange(2, tcol, tRows.length, 2).setValues(tRows);

    // Build horizontal bar chart
    var tRange = sheet.getRange(1, tcol, tRows.length + 1, 2);
    var tornadoChart = sheet.newChart()
      .asBarChart()
      .addRange(tRange)
      .setOption('title', 'Input importance: ' + oLabel)
      .setOption('legend', { position: 'none' })
      .setOption('hAxis', { title: 'Spearman ρ', minValue: -1, maxValue: 1 })
      .setOption('bar', { groupWidth: '80%' })
      .setOption('colors', ['#4393C3'])
      .setPosition(startRow + oi * 18, 1, 0, 0)
      .build();
    sheet.insertChart(tornadoChart);
  }
}

// ---------------------------------------------------------------------
// Samples sheet (raw per-iteration values)
// ---------------------------------------------------------------------

function writeSamplesSheet_(sheet, sim) {
  var header = [];
  for (var i = 0; i < sim.inputRefs.length; i++) {
    header.push('in:' + sim.labelOf(sim.inputRefs[i]) + ' (' + sim.inputRefs[i] + ')');
  }
  for (var j = 0; j < sim.outputRefs.length; j++) {
    header.push('out:' + sim.labelOf(sim.outputRefs[j]) + ' (' + sim.outputRefs[j] + ')');
  }
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');

  // Build one big 2D array and write in a single setValues() call.
  var n = sim.iterations;
  var matrix = new Array(n);
  for (var row = 0; row < n; row++) {
    var r = new Array(header.length);
    var idx = 0;
    for (var ii = 0; ii < sim.inputRefs.length; ii++) {
      var v1 = sim.inputSamples[sim.inputRefs[ii]][row];
      r[idx++] = (typeof v1 === 'number' && isFinite(v1)) ? v1 : '';
    }
    for (var jj = 0; jj < sim.outputRefs.length; jj++) {
      var v2 = sim.outputSamples[sim.outputRefs[jj]][row];
      r[idx++] = (typeof v2 === 'number' && isFinite(v2)) ? v2 : '';
    }
    matrix[row] = r;
  }
  if (n > 0) {
    sheet.getRange(2, 1, n, header.length).setValues(matrix);
  }
}

// =====================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    writeAllResults_: writeAllResults_,
    writeResultsSheet_: writeResultsSheet_,
    writeSensitivitySheet_: writeSensitivitySheet_,
    writeSamplesSheet_: writeSamplesSheet_
  };
}
