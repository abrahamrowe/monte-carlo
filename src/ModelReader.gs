/**
 * ModelReader.gs
 *
 * Reads a Google Sheet and produces a Model object the simulator can run.
 *
 * Sheet conventions:
 *   - The header of the keyword column must contain the literal string
 *     "MonteCarlo" (case-insensitive), within the first 10 rows.
 *   - The column immediately to the LEFT of MonteCarlo is the "value column" —
 *     cells there are the ones replaced by samples / marked as outputs.
 *   - Columns to the RIGHT of MonteCarlo hold distribution parameters.
 *   - The header row is whichever row contains "MonteCarlo". Param column
 *     headers are read from the SAME row.
 *
 * Mode detection (per-row):
 *   - Normal / LogNormal / Uniform: read the first TWO columns after MonteCarlo.
 *     If both headers match /^p\d+(\.\d+)?$/ (e.g. p10, p90, p25, p75),
 *     row is in quantile mode. If neither matches, parameter mode. Mixed = error.
 *   - Discrete: always parameter mode. Read every non-blank column in pairs
 *     (value, weight). Headers are ignored.
 *
 * For Google Sheets: `sheet` is a SpreadsheetApp.Sheet.
 * For testing: pass a mock with matching signatures.
 */

var MC_KEYWORD_HEADER = 'montecarlo';

function readSheetModel_(sheet) {
  // A mock sheet for testing can provide getDataRange()/getValues()/getFormulas() directly.
  var data = sheet.getDataRange();
  var values = data.getValues();
  var formulas = data.getFormulas();
  var nRows = values.length;
  var nCols = nRows > 0 ? values[0].length : 0;

  if (nRows === 0 || nCols === 0) {
    throw new Error('Sheet is empty. Add some data and a MonteCarlo column first.');
  }

  // -------------------------------------------------------------------
  // Locate the MonteCarlo column
  // -------------------------------------------------------------------
  var keywordCol = -1, headerRow = -1;
  var scanRows = Math.min(10, nRows);
  for (var r = 0; r < scanRows; r++) {
    for (var c = 0; c < nCols; c++) {
      var v = String(values[r][c] == null ? '' : values[r][c]).trim().toLowerCase();
      if (v === MC_KEYWORD_HEADER) {
        keywordCol = c;
        headerRow = r;
        break;
      }
    }
    if (keywordCol >= 0) break;
  }

  if (keywordCol < 0) {
    throw new Error('Could not find "MonteCarlo" header in the first 10 rows. ' +
                    'Add a column whose header cell reads "MonteCarlo" to mark distributions and outputs.');
  }
  if (keywordCol === 0) {
    throw new Error('MonteCarlo column must have a column to its LEFT for the values it annotates. ' +
                    'Insert a column before the MonteCarlo column.');
  }
  var valueCol = keywordCol - 1;

  // -------------------------------------------------------------------
  // Param column headers (for mode detection)
  // -------------------------------------------------------------------
  var paramHeaders = [];
  for (var pc = keywordCol + 1; pc < nCols; pc++) {
    paramHeaders.push(String(values[headerRow][pc] == null ? '' : values[headerRow][pc]).trim());
  }
  var quantileRe = /^p(\d+(\.\d+)?)$/i;

  // -------------------------------------------------------------------
  // First pass: populate every cell as static or formula (based on content)
  // -------------------------------------------------------------------
  var cells = {};
  for (var rr = 0; rr < nRows; rr++) {
    for (var cc = 0; cc < nCols; cc++) {
      var ref = formatA1_(cc, rr + 1);
      var formula = formulas[rr][cc];
      var vv = values[rr][cc];
      if (formula && formula.charAt(0) === '=') {
        var ast;
        try {
          ast = parseFormula_(formula);
        } catch (e) {
          throw new Error('Cell ' + ref + ': cannot parse formula "' + formula + '" — ' + e.message);
        }
        cells[ref] = { kind: 'formula', ast: ast };
      } else if (vv !== '' && vv !== null && vv !== undefined) {
        cells[ref] = { kind: 'static', value: normalizeCellValue_(vv) };
      } else {
        cells[ref] = { kind: 'static', value: null };
      }
    }
  }

  // -------------------------------------------------------------------
  // Second pass: apply MonteCarlo annotations
  // -------------------------------------------------------------------
  var distCount = 0, outputCount = 0;

  for (var dr = headerRow + 1; dr < nRows; dr++) {
    var keyword = String(values[dr][keywordCol] == null ? '' : values[dr][keywordCol]).trim();
    if (!keyword) continue;

    var valueRef = formatA1_(valueCol, dr + 1);
    var labelCol = (valueCol > 0) ? valueCol - 1 : -1;
    var label = (labelCol >= 0) ? String(values[dr][labelCol] == null ? '' : values[dr][labelCol]).trim() : '';
    if (!label) label = valueRef;

    var kw = keyword.toLowerCase();

    if (kw === 'output') {
      if (!cells[valueRef]) cells[valueRef] = { kind: 'static', value: null };
      cells[valueRef].isOutput = true;
      cells[valueRef].label = label;
      outputCount++;
      continue;
    }

    if (kw === 'normal' || kw === 'lognormal' || kw === 'uniform' || kw === 'discrete') {
      var spec = buildSpecForRow_(kw, dr, values, keywordCol, paramHeaders, quantileRe, valueRef);
      spec.cellRef = valueRef;
      validateDistSpec_(spec);

      cells[valueRef] = {
        kind: 'distribution',
        distSpec: spec,
        label: label
      };
      distCount++;
      continue;
    }

    throw new Error('Cell ' + formatA1_(keywordCol, dr + 1) +
                    ': unrecognized MonteCarlo keyword "' + keyword +
                    '". Supported: Normal, LogNormal, Uniform, Discrete, Output.');
  }

  return {
    cells: cells,
    headerRow: headerRow,
    keywordCol: keywordCol,
    valueCol: valueCol,
    distCount: distCount,
    outputCount: outputCount,
    formulaCount: countByKind_(cells, 'formula')
  };
}

function countByKind_(cells, kind) {
  var n = 0;
  for (var r in cells) if (cells[r].kind === kind) n++;
  return n;
}

function normalizeCellValue_(v) {
  // Date objects come back from Sheets — keep them as-is for now; arithmetic will error.
  // Booleans and numbers pass through.
  if (v instanceof Date) return v;
  return v;
}

/**
 * Build a distribution spec for a single row.
 */
function buildSpecForRow_(kw, rowIdx, values, keywordCol, paramHeaders, quantileRe, valueRef) {
  // Gather non-blank params in order, with their header tags.
  var rawParams = [];
  for (var c = keywordCol + 1; c < values[rowIdx].length; c++) {
    var v = values[rowIdx][c];
    if (v === '' || v === null || v === undefined) continue;
    rawParams.push({
      value: v,
      col: c,
      header: paramHeaders[c - keywordCol - 1] || ''
    });
  }

  if (kw === 'discrete') {
    if (rawParams.length === 0) {
      throw new Error('Cell ' + valueRef + ': Discrete needs at least one (value, weight) pair.');
    }
    if (rawParams.length % 2 !== 0) {
      throw new Error('Cell ' + valueRef + ': Discrete params must be in (value, weight) pairs. Found ' +
                      rawParams.length + ' values — missing a weight.');
    }
    var pairs = [];
    for (var i = 0; i < rawParams.length; i += 2) {
      pairs.push([
        toFiniteNumber_(rawParams[i].value, valueRef, 'Discrete value'),
        toFiniteNumber_(rawParams[i + 1].value, valueRef, 'Discrete weight')
      ]);
    }
    return { type: kw, mode: 'params', values: pairs };
  }

  // Normal / LogNormal / Uniform: expect exactly 2 params.
  if (rawParams.length !== 2) {
    throw new Error('Cell ' + valueRef + ': ' + kw + ' needs exactly 2 parameters, found ' +
                    rawParams.length + '.');
  }
  var h1 = rawParams[0].header, h2 = rawParams[1].header;
  var h1q = quantileRe.test(h1), h2q = quantileRe.test(h2);

  if (h1q && h2q) {
    var p1 = parseFloat(h1.substring(1)) / 100;
    var p2 = parseFloat(h2.substring(1)) / 100;
    return {
      type: kw, mode: 'quantile',
      quantiles: [
        { p: p1, v: toFiniteNumber_(rawParams[0].value, valueRef, h1) },
        { p: p2, v: toFiniteNumber_(rawParams[1].value, valueRef, h2) }
      ]
    };
  }
  if (!h1q && !h2q) {
    return {
      type: kw, mode: 'params',
      values: [
        toFiniteNumber_(rawParams[0].value, valueRef, kw + ' param 1'),
        toFiniteNumber_(rawParams[1].value, valueRef, kw + ' param 2')
      ]
    };
  }

  throw new Error('Cell ' + valueRef + ': mixed parameter and quantile column headers ("' +
                  h1 + '", "' + h2 + '"). Use either both p-style (e.g. p10, p90) for quantiles, ' +
                  'or neither for parameters.');
}

function toFiniteNumber_(v, cellRef, what) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    var t = v.trim();
    var n = Number(t);
    if (t !== '' && isFinite(n)) return n;
  }
  throw new Error('Cell ' + cellRef + ': expected a finite number for ' + what +
                  ', got "' + v + '".');
}

// =====================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    readSheetModel_: readSheetModel_,
    buildSpecForRow_: buildSpecForRow_,
    toFiniteNumber_: toFiniteNumber_
  };
}
