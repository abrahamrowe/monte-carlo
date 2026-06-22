/**
 * Main.gs
 *
 * Entry point for the Apps Script. Adds a menu, handles the orchestration
 * of "read sheet → build model → run simulation → write results", and
 * surfaces errors as UI alerts with the offending cell reference.
 *
 * Default iteration count: 10,000.
 */

var MC_DEFAULT_ITERATIONS = 10000;
var MC_MIN_ITERATIONS = 10;
var MC_MAX_ITERATIONS = 200000;

function onOpen(e) {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Monte Carlo')
    .addItem('Run Simulation',          'runMonteCarloSimulation')
    .addItem('Run Simulation (custom…)','runMonteCarloSimulationCustom')
    .addSeparator()
    .addItem('Insert Example Layout',   'insertMonteCarloExample')
    .addItem('Help / Format Reference', 'showMonteCarloHelp')
    .addToUi();
}

function runMonteCarloSimulation() {
  runSimulationWithOptions_({
    iterations: MC_DEFAULT_ITERATIONS,
    seed: null,
    askBeforeRun: true
  });
}

function runMonteCarloSimulationCustom() {
  var ui = SpreadsheetApp.getUi();
  var iterResp = ui.prompt(
    'Run Monte Carlo Simulation',
    'Number of iterations (default ' + MC_DEFAULT_ITERATIONS + '):',
    ui.ButtonSet.OK_CANCEL);
  if (iterResp.getSelectedButton() !== ui.Button.OK) return;
  var iterStr = iterResp.getResponseText().trim();
  var iterations = iterStr === '' ? MC_DEFAULT_ITERATIONS : parseInt(iterStr, 10);
  if (!(iterations >= MC_MIN_ITERATIONS && iterations <= MC_MAX_ITERATIONS)) {
    ui.alert('Iteration count must be between ' + MC_MIN_ITERATIONS +
             ' and ' + MC_MAX_ITERATIONS + '.');
    return;
  }

  var seedResp = ui.prompt(
    'Random seed',
    'Optional integer seed for reproducibility (leave blank for random):',
    ui.ButtonSet.OK_CANCEL);
  if (seedResp.getSelectedButton() !== ui.Button.OK) return;
  var seedStr = seedResp.getResponseText().trim();
  var seed = seedStr === '' ? null : parseInt(seedStr, 10);
  if (seedStr !== '' && (!isFinite(seed) || isNaN(seed))) {
    ui.alert('Seed must be an integer.');
    return;
  }

  runSimulationWithOptions_({
    iterations: iterations,
    seed: seed,
    askBeforeRun: false
  });
}

function runSimulationWithOptions_(opts) {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();

  var model;
  try {
    model = readSheetModel_(sheet);
  } catch (err) {
    ui.alert('Monte Carlo — setup error', err.message, ui.ButtonSet.OK);
    return;
  }

  // Pre-run summary.
  if (opts.askBeforeRun) {
    var summary =
      'Found:\n' +
      '  • ' + model.distCount + ' distribution input(s)\n' +
      '  • ' + model.outputCount + ' output(s)\n' +
      '  • ' + model.formulaCount + ' formula cell(s)\n\n' +
      'Run ' + opts.iterations + ' iterations on sheet "' + sheet.getName() + '"?';
    var resp = ui.alert('Monte Carlo — Ready to Run', summary, ui.ButtonSet.OK_CANCEL);
    if (resp !== ui.Button.OK) return;
  }

  ss.toast('Starting simulation…', 'Monte Carlo', 3);

  var simResult;
  try {
    simResult = runSimulationCore_(model, {
      iterations: opts.iterations,
      seed: opts.seed,
      progress: function (done, total) {
        ss.toast('Iteration ' + done + ' / ' + total, 'Monte Carlo', -1);
      }
    });
  } catch (err) {
    ui.alert('Monte Carlo — simulation error', err.message, ui.ButtonSet.OK);
    return;
  }

  ss.toast('Writing results…', 'Monte Carlo', 3);
  try {
    writeAllResults_(ss, simResult);
  } catch (err) {
    ui.alert('Monte Carlo — results write error', err.message, ui.ButtonSet.OK);
    return;
  }

  var seconds = (simResult.elapsedMs / 1000).toFixed(1);
  ss.toast('Done in ' + seconds + 's. See the "MC Results" tab.', 'Monte Carlo', 8);
}

// ---------------------------------------------------------------------
// Help modal
// ---------------------------------------------------------------------

function showMonteCarloHelp() {
  var ui = SpreadsheetApp.getUi();
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family: Arial, sans-serif; line-height:1.5; padding:10px; max-width:640px;">' +
    '<h3>Monte Carlo — Input Format</h3>' +
    '<p>Add a column headed <b>MonteCarlo</b> (anywhere in the first 10 rows) with a ' +
      'column of values to its LEFT. Mark rows as random inputs or outputs:</p>' +
    '<ul>' +
    '<li><b>Normal, LogNormal, Uniform, Discrete</b> — the cell to the left becomes a random input. ' +
      'Put parameters in the columns to the right of MonteCarlo.</li>' +
    '<li><b>Output</b> — the cell to the left is collected across iterations.</li>' +
    '<li>Empty — the row is deterministic (plain value or formula).</li>' +
    '</ul>' +
    '<p><b>Parameter mode</b>: columns right of MonteCarlo hold numeric parameters.<br>' +
    'e.g. <code>Normal</code> → mean, sd. <code>Uniform</code> → a, b. ' +
    '<code>Discrete</code> → value, weight, value, weight, …</p>' +
    '<p><b>Quantile mode</b>: label two columns as <code>p10</code>, <code>p90</code> ' +
    '(or any two percentiles). Values become the 10th / 90th percentile of the distribution. ' +
    'Note: for <code>Uniform</code> with p10/p90, the implied a/b extends past those values ' +
    '(p10=0, p90=10 implies a=−1.25, b=11.25), so samples can land outside what you typed.</p>' +
    '<p>Supported functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, MEDIAN, STDEV, VAR, PERCENTILE, ' +
      'SUMPRODUCT, PRODUCT, IF, IFS, AND, OR, NOT, IFERROR, ISERROR, ISNUMBER, ISBLANK, ABS, SQRT, EXP, LN, LOG, ' +
      'LOG10, POWER, MOD, ROUND, CEILING, FLOOR, INT, TRUNC, PI.</p>' +
    '<p><b>Results</b> land on three new sheets: <i>MC Results</i>, ' +
      '<i>MC Sensitivity</i>, and <i>MC Samples</i>. The Results sheet shows Monte Carlo standard ' +
      'errors next to each Mean (±1.96·SE ≈ 95% CI), 95% confidence intervals on the percentiles, ' +
      'and an Effective N column when iterations error out.</p>' +
    '<p><b>Sampling</b> uses Latin Hypercube stratification (seeded and reproducible), which ' +
      'converges faster than plain Monte Carlo at the same iteration count.</p>' +
    '</div>'
  ).setWidth(700).setHeight(520);
  ui.showModalDialog(html, 'Monte Carlo — Help');
}

// ---------------------------------------------------------------------
// Example layout
// ---------------------------------------------------------------------

function insertMonteCarloExample() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var name = 'MC Example';
  var existing = ss.getSheetByName(name);
  if (existing) {
    var resp = ui.alert('"' + name + '" already exists. Replace it?', ui.ButtonSet.OK_CANCEL);
    if (resp !== ui.Button.OK) return;
    ss.deleteSheet(existing);
  }
  var sheet = ss.insertSheet(name);

  var data = [
    ['Label',          'Value',             'MonteCarlo', 'p10',  'p90'],
    ['Price per unit', 100,                 'Normal',      80,    120],
    ['Units sold',     1000,                'LogNormal',   500,   2000],
    ['Fixed costs',    50000,               '',            '',    ''],
    ['Variable cost',  0.4,                 'Uniform',     0.3,   0.5],
    ['Revenue',        '=B2*B3',            '',            '',    ''],
    ['Variable total', '=B3*B2*B5',         '',            '',    ''],
    ['Profit',         '=B6-B7-B4',         'Output',      '',    '']
  ];
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
  sheet.getRange(1, 1, 1, data[0].length).setFontWeight('bold');
  sheet.autoResizeColumns(1, data[0].length);

  ss.toast('Example layout inserted. Open the Monte Carlo menu and run!', 'Monte Carlo', 8);
}
