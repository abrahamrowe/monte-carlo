const h = require('./harness');
const ctx = h.sandbox();

h.describe('stats — summarize', () => {

  h.test('basic mean/stdev', () => {
    const s = ctx.summarize_([1, 2, 3, 4, 5], 5);
    h.eq(s.mean, 3);
    h.eq(s.median, 3);
    h.near(s.stdev, Math.sqrt(2.5), 1e-9);
    h.eq(s.min, 1);
    h.eq(s.max, 5);
    h.eq(s.errorCount, 0);
  });

  h.test('NaN values become errors, excluded from stats', () => {
    const s = ctx.summarize_([1, NaN, 3, NaN, 5], 5);
    h.eq(s.count, 3);
    h.eq(s.errorCount, 2);
    h.eq(s.mean, 3);
  });

  h.test('percentiles interpolate', () => {
    const s = ctx.summarize_([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 10);
    h.near(s.percentiles.p50, 55, 0.5);
    h.near(s.percentiles.p10, 19, 0.5);
    h.near(s.percentiles.p90, 91, 0.5);
  });

  h.test('all NaN gives NaN stats but zero count', () => {
    const s = ctx.summarize_([NaN, NaN, NaN], 3);
    h.eq(s.count, 0);
    h.eq(s.errorCount, 3);
    h.truthy(isNaN(s.mean));
  });
});

h.describe('stats — rank / correlation', () => {

  h.test('rank with ties gives average rank', () => {
    const r = ctx.rank_([10, 20, 20, 30]);
    h.eq(r, [1, 2.5, 2.5, 4]);
  });

  h.test('rank of unique values is 1..n', () => {
    h.eq(ctx.rank_([3, 1, 2]), [3, 1, 2]);
  });

  h.test('pearson of identical vectors is 1', () => {
    const r = ctx.pearson_([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    h.near(r, 1, 1e-9);
  });

  h.test('pearson of anti-correlated vectors is -1', () => {
    const r = ctx.pearson_([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    h.near(r, -1, 1e-9);
  });

  h.test('spearman handles nonlinear monotonic', () => {
    // y = x^3 — Pearson would be < 1 but Spearman = 1.
    const x = [1, 2, 3, 4, 5];
    const y = x.map(v => v * v * v);
    h.near(ctx.spearman_(x, y), 1, 1e-9);
  });

  h.test('spearman drops NaN pairs', () => {
    const r = ctx.spearman_([1, 2, NaN, 4, 5], [1, 2, 3, 4, NaN]);
    h.truthy(isFinite(r));
  });
});

h.describe('stats — histogram', () => {

  h.test('basic binning', () => {
    const samples = [0, 0.1, 0.2, 0.5, 0.9, 1.0];
    const histo = ctx.histogram_(samples, 4);
    h.eq(histo.counts.length, 4);
    // Total count = sample count (excluding last value? inclusive max)
    const total = histo.counts.reduce((a, b) => a + b, 0);
    h.eq(total, 6);
  });

  h.test('degenerate (all equal) returns single bin', () => {
    const histo = ctx.histogram_([5, 5, 5, 5], 10);
    h.eq(histo.counts.length, 1);
    h.eq(histo.counts[0], 4);
  });

  h.test('empty input returns empty histogram', () => {
    const histo = ctx.histogram_([], 10);
    h.eq(histo.counts.length, 0);
  });
});

if (require.main === module) h.runAll();
