const h = require('./harness');
const ctx = h.sandbox();

h.describe('distributions', () => {

  h.test('mulberry32 output is in [0, 1)', () => {
    const rng = ctx.mulberry32_(12345);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      h.truthy(v >= 0 && v < 1, `v=${v}`);
    }
  });

  h.test('mulberry32 is deterministic', () => {
    const a = ctx.mulberry32_(42);
    const b = ctx.mulberry32_(42);
    for (let i = 0; i < 10; i++) h.eq(a(), b(), `iter ${i}`);
  });

  h.test('mulberry32 different seeds give different sequences', () => {
    const a = ctx.mulberry32_(1);
    const b = ctx.mulberry32_(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a() === b()) same++;
    h.truthy(same < 5, `too many matches: ${same}`);
  });

  h.test('inverseNormalCDF matches known z-scores', () => {
    h.near(ctx.inverseNormalCDF_(0.5),  0,       1e-6);
    h.near(ctx.inverseNormalCDF_(0.975), 1.95996, 1e-4);
    h.near(ctx.inverseNormalCDF_(0.025), -1.95996, 1e-4);
    h.near(ctx.inverseNormalCDF_(0.9),   1.2816,  1e-4);
    h.near(ctx.inverseNormalCDF_(0.1),  -1.2816,  1e-4);
  });

  h.test('sampleUniform stays in [a, b]', () => {
    const rng = ctx.mulberry32_(7);
    for (let i = 0; i < 10000; i++) {
      const v = ctx.sampleUniform_(rng, -5, 15);
      h.truthy(v >= -5 && v <= 15, `v=${v}`);
    }
  });

  h.test('sampleNormal mean/sd converge', () => {
    const rng = ctx.mulberry32_(100);
    const N = 50000;
    let sum = 0, sum2 = 0;
    for (let i = 0; i < N; i++) {
      const x = ctx.sampleNormal_(rng, 10, 2);
      sum += x; sum2 += x * x;
    }
    const mean = sum / N;
    const variance = sum2 / N - mean * mean;
    h.near(mean, 10, 0.05);
    h.near(Math.sqrt(variance), 2, 0.05);
  });

  h.test('sampleLogNormal values positive, mean matches theory', () => {
    const rng = ctx.mulberry32_(200);
    const mu = 1, sigma = 0.5;
    const N = 50000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const x = ctx.sampleLogNormal_(rng, mu, sigma);
      h.truthy(x > 0, `got ${x}`);
      sum += x;
    }
    const mean = sum / N;
    const theoretical = Math.exp(mu + sigma * sigma / 2);  // ≈ 3.08
    h.near(mean, theoretical, 0.05);
  });

  h.test('sampleDiscrete frequencies match weights', () => {
    const rng = ctx.mulberry32_(300);
    const xs = [1, 2, 3];
    const cum = [0.2, 0.7, 1.0];  // weights 0.2, 0.5, 0.3
    const N = 50000;
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < N; i++) counts[ctx.sampleDiscrete_(rng, xs, cum)]++;
    h.near(counts[1] / N, 0.2, 0.01);
    h.near(counts[2] / N, 0.5, 0.01);
    h.near(counts[3] / N, 0.3, 0.01);
  });

  h.test('solveNormalFromQuantiles recovers correct mean/sd', () => {
    // Given a N(10, 2), p10 ≈ 10 - 1.2816 * 2 ≈ 7.4368, p90 ≈ 12.5632
    const solved = ctx.solveNormalFromQuantiles_(0.10, 7.4368, 0.90, 12.5632);
    h.near(solved.mean, 10, 0.001);
    h.near(solved.sd, 2, 0.001);
  });

  h.test('solveLogNormalFromQuantiles recovers correct mu/sigma', () => {
    const mu = 2, sigma = 0.5;
    const p10 = Math.exp(mu - 1.2816 * sigma);
    const p90 = Math.exp(mu + 1.2816 * sigma);
    const solved = ctx.solveLogNormalFromQuantiles_(0.10, p10, 0.90, p90);
    h.near(solved.mu, mu, 0.001);
    h.near(solved.sigma, sigma, 0.001);
  });

  h.test('solveUniformFromQuantiles recovers correct bounds', () => {
    // Uniform(0, 10): p10 = 1, p90 = 9
    const solved = ctx.solveUniformFromQuantiles_(0.10, 1, 0.90, 9);
    h.near(solved.a, 0, 0.001);
    h.near(solved.b, 10, 0.001);
  });

  h.test('buildSampler(Normal, params) works', () => {
    const sampler = ctx.buildSampler_({
      type: 'normal', mode: 'params', values: [5, 1], cellRef: 'B2'
    });
    const rng = ctx.mulberry32_(99);
    let sum = 0; const N = 10000;
    for (let i = 0; i < N; i++) sum += sampler.sample(rng);
    h.near(sum / N, 5, 0.05);
  });

  h.test('buildSampler(LogNormal, quantile) matches distribution', () => {
    const sampler = ctx.buildSampler_({
      type: 'lognormal', mode: 'quantile',
      quantiles: [{ p: 0.10, v: 100 }, { p: 0.90, v: 1000 }],
      cellRef: 'B3'
    });
    const rng = ctx.mulberry32_(7);
    const samples = [];
    for (let i = 0; i < 20000; i++) samples.push(sampler.sample(rng));
    samples.sort((a, b) => a - b);
    const p10 = samples[Math.floor(0.10 * samples.length)];
    const p90 = samples[Math.floor(0.90 * samples.length)];
    h.near(p10, 100, 5);
    h.near(p90, 1000, 50);
  });

  h.test('validate: Normal sd must be positive', () => {
    h.throws(() => ctx.validateDistSpec_({
      type: 'normal', mode: 'params', values: [0, -1], cellRef: 'B1'
    }), /finite/);
    h.throws(() => ctx.buildSampler_({
      type: 'normal', mode: 'params', values: [0, 0], cellRef: 'B1'
    }), /sd/);
  });

  h.test('validate: LogNormal quantile values must be positive', () => {
    h.throws(() => ctx.buildSampler_({
      type: 'lognormal', mode: 'quantile',
      quantiles: [{ p: 0.10, v: -1 }, { p: 0.90, v: 10 }],
      cellRef: 'B1'
    }), /positive/);
  });

  h.test('validate: inverted quantile values rejected', () => {
    h.throws(() => ctx.validateDistSpec_({
      type: 'normal', mode: 'quantile',
      quantiles: [{ p: 0.10, v: 100 }, { p: 0.90, v: 50 }],
      cellRef: 'B1'
    }), /ascending/);
  });

  h.test('validate: Discrete rejects quantile mode', () => {
    h.throws(() => ctx.validateDistSpec_({
      type: 'discrete', mode: 'quantile',
      quantiles: [{ p: 0.1, v: 1 }, { p: 0.9, v: 2 }],
      cellRef: 'B1'
    }), /quantile/);
  });
});

if (require.main === module) h.runAll();
