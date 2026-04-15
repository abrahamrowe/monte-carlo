const h = require('./harness');
const ctx = h.sandbox();

function mockSheet(values, formulas) {
  // values and formulas are parallel 2D arrays.
  // If formulas is omitted, assume no formulas (all empty strings).
  const fs = formulas || values.map(r => r.map(() => ''));
  return {
    getDataRange: () => ({
      getValues: () => values,
      getFormulas: () => fs
    })
  };
}

h.describe('ModelReader', () => {

  h.test('rejects sheet without MonteCarlo column', () => {
    const sheet = mockSheet([
      ['Label', 'Value'],
      ['foo',    1],
      ['bar',    2]
    ]);
    h.throws(() => ctx.readSheetModel_(sheet), /MonteCarlo/);
  });

  h.test('rejects MonteCarlo in column A (no value column to left)', () => {
    const sheet = mockSheet([
      ['MonteCarlo', 'Label'],
      ['Normal',     'foo']
    ]);
    h.throws(() => ctx.readSheetModel_(sheet), /to its LEFT/);
  });

  h.test('reads Normal in parameter mode', () => {
    const values = [
      ['Label',     'Value', 'MonteCarlo', 'mean', 'sd'],
      ['X',         100,     'Normal',      100,   10],
      ['Output',    200,     'Output',      '',    '']
    ];
    const sheet = mockSheet(values);
    const model = ctx.readSheetModel_(sheet);
    const distCell = model.cells.B2;
    h.eq(distCell.kind, 'distribution');
    h.eq(distCell.distSpec.type, 'normal');
    h.eq(distCell.distSpec.mode, 'params');
    h.eq(distCell.distSpec.values, [100, 10]);
    h.eq(distCell.label, 'X');
    h.truthy(model.cells.B3.isOutput, 'B3 marked as output');
  });

  h.test('reads LogNormal in quantile mode via p10/p90 headers', () => {
    const values = [
      ['Label', 'Value', 'MonteCarlo', 'p10', 'p90'],
      ['Units', 1000,    'LogNormal',   500,   2000]
    ];
    const sheet = mockSheet(values);
    const model = ctx.readSheetModel_(sheet);
    const c = model.cells.B2;
    h.eq(c.distSpec.mode, 'quantile');
    h.eq(c.distSpec.quantiles, [{ p: 0.10, v: 500 }, { p: 0.90, v: 2000 }]);
  });

  h.test('reads Discrete with many pairs', () => {
    const values = [
      ['Label', 'Value', 'MonteCarlo', 'x1','w1','x2','w2','x3','w3'],
      ['Coin',  0,       'Discrete',    0,   1,   1,   2,   2,   1]
    ];
    const sheet = mockSheet(values);
    const model = ctx.readSheetModel_(sheet);
    const c = model.cells.B2;
    h.eq(c.distSpec.type, 'discrete');
    h.eq(c.distSpec.values, [[0, 1], [1, 2], [2, 1]]);
  });

  h.test('parses formula cells', () => {
    const values = [
      ['Label', 'Value', 'MonteCarlo', 'mean', 'sd'],
      ['a',     5,       'Normal',      5,     1],
      ['b',     10,      '',            '',    ''],
      ['sum',   0,       'Output',      '',    '']
    ];
    const formulas = [
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '=B2+B3', '', '', '']
    ];
    const sheet = mockSheet(values, formulas);
    const model = ctx.readSheetModel_(sheet);
    h.eq(model.cells.B4.kind, 'formula');
    h.truthy(model.cells.B4.isOutput);
  });

  h.test('rejects mixed p10 + sd headers on same row', () => {
    const values = [
      ['Label', 'Value', 'MonteCarlo', 'p10', 'sd'],
      ['X',     100,     'Normal',      100,   10]
    ];
    const sheet = mockSheet(values);
    h.throws(() => ctx.readSheetModel_(sheet), /mixed/);
  });

  h.test('rejects Discrete with odd number of params', () => {
    const values = [
      ['Label', 'Value', 'MonteCarlo', 'x1','w1','x2'],
      ['X',     0,       'Discrete',    1,   2,   3]
    ];
    const sheet = mockSheet(values);
    h.throws(() => ctx.readSheetModel_(sheet), /pairs/);
  });

  h.test('rejects unknown keyword', () => {
    const values = [
      ['Label', 'Value', 'MonteCarlo'],
      ['X',     100,     'Weibull']
    ];
    const sheet = mockSheet(values);
    h.throws(() => ctx.readSheetModel_(sheet), /Weibull/);
  });

  h.test('end-to-end: read then simulate', () => {
    const values = [
      ['Label',     'Value',  'MonteCarlo', 'p10', 'p90'],
      ['Price',     100,      'Normal',      80,    120],
      ['Units',     50,       'LogNormal',   30,    100],
      ['Profit',    0,        'Output',      '',    '']
    ];
    const formulas = [
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '=B2*B3', '', '', '']
    ];
    const sheet = mockSheet(values, formulas);
    const model = ctx.readSheetModel_(sheet);
    h.eq(model.distCount, 2);
    h.eq(model.outputCount, 1);
    const result = ctx.runSimulationCore_(model, { iterations: 5000, seed: 1 });
    const stats = ctx.summarize_(result.outputSamples.B4, result.iterations);
    h.truthy(stats.mean > 0, 'mean should be positive');
    h.eq(stats.errorCount, 0);
  });
});

if (require.main === module) h.runAll();
