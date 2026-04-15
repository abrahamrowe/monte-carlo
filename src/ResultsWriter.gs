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
      s.mean, s.meanSE, s.median, s.stdev, s.min,
      s.percentiles.p1,  s.percentiles.p5,  s.percentiles.p10,
      s.percentiles.p25, s.percentiles.p50, s.percentiles.p75,
      s.percentiles.p90, s.percentiles.p95, s.percentiles.p99,
      s.max, s.count, s.errorCount
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

  // Inputs summary starting a few rows below
  var inputsStartRow = headerRow + rows.length + 3;
  sheet.getRange(inputsStartRow, 1).setValue('Distribution Inputs').setFontWeight('bold');
  var inputHeader = ['Input', 'Cell', 'Distribution'];
  sheet.getRange(inputsStartRow + 1, 1, 1, inputHeader.length).setValues([inputHeader]).setFontWeight('bold');
  var inputRows = [];
  for (var k = 0; k < sim.inputRefs.length; k++) {
    var iref = sim.inputRefs[k];
    inputRows.push([sim.labelOf(iref), iref, sim.describeDist(iref)]);
  }
  if (inputRows.length > 0) {
    sheet.getRange(inputsStartRow + 2, 1, inputRows.length, inputHeader.length).setValues(inputRows);
  }

  // Histograms: write bin tables far to the right, then create charts.
  writeHistogramsAndCharts_(sheet, sim, stats, inputsStartRow + inputRows.length + 4);

  // Autoresize the main columns.
  for (var col = 1; col <= statsHeader.length; col++) sheet.autoResizeColumn(col);
}

function writeHistogramsAndCharts_(sheet, sim, stats, chartsStartRow) {
  // Bin tables live in columns Z onwards so they don't collide with the stats.
  var binStartCol = 26;  // column Z
  var binTableCols = 2;  // midpoint + count
  var binTableGap = 1;

  for (var i = 0; i < sim.outputRefs.length; i++) {
    var ref = sim.outputRefs[i];
    var samples = sim.outputSamples[ref];
    // Pass skewness so histogram_ doesn't recompute it.
    var hist = histogram_(samples, 40, stats[ref].skewness);

    if (hist.midpoints.length === 0) continue;

    var col = binStartCol + i * (binTableCols + binTableGap);

    // Header — note the scale so users know what they're looking at.
    var scaleNote = hist.scale === 'log' ? ' (log-spaced bins)' : '';
    sheet.getRange(1, col, 1, 2).setValues([
      [sim.labelOf(ref) + scaleNote, 'Count']
    ]).setFontWeight('bold');

    // Rows
    var tableRows = [];
    for (var j = 0; j < hist.midpoints.length; j++) {
      tableRows.push([hist.midpoints[j], hist.counts[j]]);
    }
    sheet.getRange(2, col, tableRows.length, 2).setValues(tableRows);

    // Build chart. Range includes header + data (so the series is auto-labeled).
    var dataRange = sheet.getRange(1, col, tableRows.length + 1, 2);
    var hAxisOpt = { title: hist.scale === 'log' ? 'Value (log scale)' : 'Value' };
    if (hist.scale === 'log') hAxisOpt.logScale = true;
    var chart = sheet.newChart()
      .asColumnChart()
      .addRange(dataRange)
      .setOption('title', sim.labelOf(ref) + ' (' + ref + ')' +
                 (hist.scale === 'log' ? ' — log bins (skew=' + stats[ref].skewness.toFixed(1) + ')' : ''))
      .setOption('legend', { position: 'none' })
      .setOption('hAxis', hAxisOpt)
      .setOption('vAxis', { title: 'Count' })
      .setOption('bar', { groupWidth: '99%' })
      .setPosition(chartsStartRow + i * 20, 1, 0, 0)
      .build();
    sheet.insertChart(chart);
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
