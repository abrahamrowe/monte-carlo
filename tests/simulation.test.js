const h = require('./harness');
const ctx = h.sandbox();

h.describe('simulation — end-to-end', () => {

  h.test('sum of two independent Normals is Normal with combined variance', () => {
    // A1 = Normal(10, 2), A2 = Normal(0, 1), A3 = A1 + A2 (output)
    // Expected: mean = 10, variance = 5 → stdev ≈ 2.236
    const ast = ctx.parseFormula_('=A1+A2');
    const model = {
      cells: {
        A1: {
          kind: 'distribution',
          distSpec: { type: 'normal', mode: 'params', values: [10, 2], cellRef: 'A1' },
          label: 'X'
        },
        A2: {
          kind: 'distribution',
          distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A2' },
          label: 'Y'
        },
        A3: { kind: 'formula', ast: ast, isOutput: true, label: 'Sum' }
      }
    };

    const result = ctx.runSimulationCore_(model, { iterations: 20000, seed: 42 });
    const samples = result.outputSamples.A3;
    const stats = ctx.summarize_(samples, result.iterations);

    h.near(stats.mean,  10,        0.1);
    h.near(stats.stdev, Math.sqrt(5), 0.05);
    h.eq(stats.errorCount, 0);
  });

  h.test('quantile-mode Normal produces expected percentiles', () => {
    // Normal with p10=0, p90=10 → mean=5, sd ≈ 3.9
    const ast = ctx.parseFormula_('=A1');
    const model = {
      cells: {
        A1: {
          kind: 'distribution',
          distSpec: {
            type: 'normal', mode: 'quantile',
            quantiles: [{ p: 0.10, v: 0 }, { p: 0.90, v: 10 }],
            cellRef: 'A1'
          },
          label: 'X'
        },
        A2: { kind: 'formula', ast: ast, isOutput: true, label: 'X copy' }
      }
    };
    const result = ctx.runSimulationCore_(model, { iterations: 30000, seed: 7 });
    const stats = ctx.summarize_(result.outputSamples.A2, result.iterations);
    h.near(stats.percentiles.p10, 0,  0.2);
    h.near(stats.percentiles.p90, 10, 0.2);
    h.near(stats.mean, 5, 0.1);
  });

  h.test('Uniform output spread', () => {
    const ast = ctx.parseFormula_('=A1');
    const model = {
      cells: {
        A1: {
          kind: 'distribution',
          distSpec: { type: 'uniform', mode: 'params', values: [0, 10], cellRef: 'A1' },
          label: 'U'
        },
        A2: { kind: 'formula', ast: ast, isOutput: true, label: 'U copy' }
      }
    };
    const result = ctx.runSimulationCore_(model, { iterations: 20000, seed: 3 });
    const stats = ctx.summarize_(result.outputSamples.A2, result.iterations);
    h.near(stats.mean, 5, 0.1);
    h.near(stats.stdev, 10 / Math.sqrt(12), 0.05);
    h.truthy(stats.min >= 0);
    h.truthy(stats.max <= 10);
  });

  h.test('cycle in formulas is detected', () => {
    const astA = ctx.parseFormula_('=A2+1');
    const astB = ctx.parseFormula_('=A1+1');
    const model = {
      cells: {
        A1: { kind: 'formula', ast: astA, isOutput: true, label: 'a' },
        A2: { kind: 'formula', ast: astB, isOutput: false, label: 'b' },
        A3: {
          kind: 'distribution',
          distSpec: { type: 'uniform', mode: 'params', values: [0, 1], cellRef: 'A3' }
        }
      }
    };
    h.throws(() => ctx.runSimulationCore_(model, { iterations: 100 }), /Circular/);
  });

  h.test('unknown function surfaces at build time', () => {
    const ast = ctx.parseFormula_('=FOOBAR(A1)');
    const model = {
      cells: {
        A1: {
          kind: 'distribution',
          distSpec: { type: 'uniform', mode: 'params', values: [0, 1], cellRef: 'A1' }
        },
        A2: { kind: 'formula', ast: ast, isOutput: true, label: 'bad' }
      }
    };
    h.throws(() => ctx.runSimulationCore_(model, { iterations: 100 }), /Unknown function/);
  });

  h.test('sensitivity: monotonic formula has high Spearman', () => {
    // A1 = Normal(0, 1), A2 = Normal(0, 1), A3 = 10*A1 + A2 (A1 dominates)
    const ast = ctx.parseFormula_('=10*A1+A2');
    const model = {
      cells: {
        A1: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A1' }, label: 'strong' },
        A2: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A2' }, label: 'weak' },
        A3: { kind: 'formula', ast: ast, isOutput: true, label: 'out' }
      }
    };
    const result = ctx.runSimulationCore_(model, { iterations: 10000, seed: 5 });
    const rho1 = ctx.spearman_(result.inputSamples.A1, result.outputSamples.A3);
    const rho2 = ctx.spearman_(result.inputSamples.A2, result.outputSamples.A3);
    h.truthy(rho1 > 0.9, `A1 should dominate, rho=${rho1}`);
    h.truthy(Math.abs(rho2) < 0.3, `A2 should be weak, rho=${rho2}`);
  });

  h.test('deterministic with same seed', () => {
    const ast = ctx.parseFormula_('=A1+A2');
    const model = () => ({
      cells: {
        A1: { kind: 'distribution', distSpec: { type: 'normal', mode: 'params', values: [0, 1], cellRef: 'A1' } },
        A2: { kind: 'distribution', distSpec: { type: 'uniform', mode: 'params', values: [0, 1], cellRef: 'A2' } },
        A3: { kind: 'formula', ast: ast, isOutput: true, label: 'out' }
      }
    });
    const a = ctx.runSimulationCore_(model(), { iterations: 100, seed: 123 });
    const b = ctx.runSimulationCore_(model(), { iterations: 100, seed: 123 });
    for (let i = 0; i < 100; i++) h.eq(a.outputSamples.A3[i], b.outputSamples.A3[i], `iter ${i}`);
  });
});

if (require.main === module) h.runAll();
