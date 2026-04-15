/**
 * MonteCarlo.gs — bundled single-file build
 *
 * Paste this into Google Apps Script (Extensions → Apps Script) on
 * your sheet, save, then reload the sheet. A new "Monte Carlo"
 * menu will appear.
 *
 * Source files (in order) are separated by banners below.
 */

// =====================================================================
// Distributions.gs
// =====================================================================

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

function sampleUniform_(rng, a, b) {
  return a + (b - a) * rng();
}

/**
 * Marsaglia polar method for generating standard normal samples.
 *
 * Each iteration of the polar loop produces TWO independent N(0,1) draws
 * from two uniforms. We return one and stash the other in a per-rng cache
 * so the next call to sampleNormal_ on the same rng is essentially free.
 *
 * Marsaglia polar is preferred over trig-form Box-Muller because it has
 * better numerical behavior at the tails (no cos/sin amplification of
 * floating-point error when one uniform is small).
 */
var _normalCache_ = { rng: null, value: null };

function resetNormalCache_() {
  _normalCache_.rng = null;
  _normalCache_.value = null;
}

function sampleNormal_(rng, mean, sd) {
  if (_normalCache_.rng === rng && _normalCache_.value !== null) {
    var z = _normalCache_.value;
    _normalCache_.value = null;
    return mean + sd * z;
  }
  var u, v, s;
  do {
    u = 2 * rng() - 1;
    v = 2 * rng() - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  var f = Math.sqrt(-2 * Math.log(s) / s);
  _normalCache_.rng = rng;
  _normalCache_.value = v * f;
  return mean + sd * (u * f);
}

function sampleLogNormal_(rng, mu, sigma) {
  return Math.exp(sampleNormal_(rng, mu, sigma));
}

function sampleDiscrete_(rng, values, cumWeights) {
  // cumWeights is pre-normalized cumulative distribution (ends at 1).
  var r = rng();
  for (var i = 0; i < cumWeights.length; i++) {
    if (r < cumWeights[i]) return values[i];
  }
  return values[values.length - 1];
}

// =====================================================================
// Quantile-mode solvers
// =====================================================================

function solveNormalFromQuantiles_(p1, v1, p2, v2) {
  var z1 = inverseNormalCDF_(p1);
  var z2 = inverseNormalCDF_(p2);
  var sd = (v2 - v1) / (z2 - z1);
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
      sample: function (rng) { return sampleNormal_(rng, np.mean, np.sd); },
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
      sample: function (rng) { return sampleLogNormal_(rng, lp.mu, lp.sigma); },
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
      sample: function (rng) { return sampleUniform_(rng, up.a, up.b); },
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
      sample: function (rng) { return sampleDiscrete_(rng, xs, cum); },
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

// =====================================================================
// FormulaLexer.gs
// =====================================================================

/**
 * FormulaLexer.gs
 *
 * Tokenizes a Sheets-style formula string into a token array.
 *
 * Leading `=` is stripped. Whitespace is ignored. Cell refs with $
 * anchors are normalized (the $ markers are dropped — all refs are
 * treated as relative, since we evaluate a single sheet at a time).
 *
 * Token types:
 *   number   { type:'number', value:Number }
 *   string   { type:'string', value:String }
 *   bool     { type:'bool',   value:Boolean }
 *   ref      { type:'ref',    value:'A1' }       // letters uppercased
 *   ident    { type:'ident',  value:'SUM' }      // uppercased
 *   op       { type:'op',     value:'+' | '-' | '*' | '/' | '^' | '&' |
 *                                   '=' | '<>' | '<' | '>' | '<=' | '>=' }
 *   lparen   { type:'(' }
 *   rparen   { type:')' }
 *   comma    { type:',' }
 *   colon    { type:':' }
 *   eof      { type:'eof' }
 *
 * Throws `Error` with a position marker on invalid input.
 */

function tokenizeFormula_(formula) {
  var s = String(formula || '').replace(/^=/, '');
  var tokens = [];
  var i = 0;
  var n = s.length;

  while (i < n) {
    var c = s.charAt(i);

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // Single-char punctuation
    if (c === '(') { tokens.push({ type: '(' }); i++; continue; }
    if (c === ')') { tokens.push({ type: ')' }); i++; continue; }
    if (c === ',') { tokens.push({ type: ',' }); i++; continue; }
    if (c === ':') { tokens.push({ type: ':' }); i++; continue; }

    // Multi-char and single-char operators
    if (c === '<') {
      if (s.charAt(i + 1) === '=') { tokens.push({ type: 'op', value: '<=' }); i += 2; continue; }
      if (s.charAt(i + 1) === '>') { tokens.push({ type: 'op', value: '<>' }); i += 2; continue; }
      tokens.push({ type: 'op', value: '<' }); i++; continue;
    }
    if (c === '>') {
      if (s.charAt(i + 1) === '=') { tokens.push({ type: 'op', value: '>=' }); i += 2; continue; }
      tokens.push({ type: 'op', value: '>' }); i++; continue;
    }
    if (c === '=' || c === '+' || c === '-' || c === '*' || c === '/' ||
        c === '^' || c === '&') {
      tokens.push({ type: 'op', value: c }); i++; continue;
    }

    // String literal "..."  (embedded "" is an escaped quote)
    if (c === '"') {
      var j = i + 1;
      var buf = '';
      while (j < n) {
        var ch = s.charAt(j);
        if (ch === '"') {
          if (s.charAt(j + 1) === '"') { buf += '"'; j += 2; continue; }
          break;
        }
        buf += ch; j++;
      }
      if (j >= n) {
        throw new Error('Unterminated string starting at position ' + i + ' in: ' + formula);
      }
      tokens.push({ type: 'string', value: buf });
      i = j + 1; continue;
    }

    // Number: 5 | 5. | 5.14 | .5 | 5e10 | 5.14e-3 | .5e2
    var rest = s.substring(i);
    var numMatch = rest.match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (numMatch) {
      tokens.push({ type: 'number', value: parseFloat(numMatch[0]) });
      i += numMatch[0].length; continue;
    }

    // Cell reference (must be tried before identifier)
    // Pattern: optional $, letters, optional $, digits
    var refMatch = rest.match(/^\$?[A-Za-z]+\$?\d+/);
    if (refMatch) {
      var refRaw = refMatch[0].replace(/\$/g, '').toUpperCase();
      tokens.push({ type: 'ref', value: refRaw });
      i += refMatch[0].length; continue;
    }

    // Identifier (function name, TRUE, FALSE)
    var identMatch = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identMatch) {
      var name = identMatch[0].toUpperCase();
      if (name === 'TRUE') {
        tokens.push({ type: 'bool', value: true });
      } else if (name === 'FALSE') {
        tokens.push({ type: 'bool', value: false });
      } else {
        tokens.push({ type: 'ident', value: name });
      }
      i += identMatch[0].length; continue;
    }

    throw new Error('Unexpected character "' + c + '" at position ' + i + ' in: ' + formula);
  }

  tokens.push({ type: 'eof' });
  return tokens;
}

// =====================================================================

// =====================================================================
// FormulaParser.gs
// =====================================================================

/**
 * FormulaParser.gs
 *
 * Pratt parser that turns a token stream into an AST.
 *
 * AST node shapes:
 *   { type: 'num',   value: Number }
 *   { type: 'str',   value: String }
 *   { type: 'bool',  value: Boolean }
 *   { type: 'ref',   value: 'A1' }
 *   { type: 'range', start: 'A1', end: 'B10' }
 *   { type: 'unary', op: '-'|'+', operand: AST }
 *   { type: 'binop', op: String, left: AST, right: AST }
 *   { type: 'call',  name: String, args: [AST, ...] }
 *
 * Operator precedence (low → high), matching Google Sheets:
 *   comparison (= <> < > <= >=)   — 1
 *   & (concat)                    — 2
 *   + - (binary)                  — 3
 *   * /                           — 4
 *   unary -/+                     — 5
 *   ^ (left-associative)          — 6
 */

var MC_BINARY_OPS_ = {
  '=':  { prec: 1 },
  '<>': { prec: 1 },
  '<':  { prec: 1 },
  '>':  { prec: 1 },
  '<=': { prec: 1 },
  '>=': { prec: 1 },
  '&':  { prec: 2 },
  '+':  { prec: 3 },
  '-':  { prec: 3 },
  '*':  { prec: 4 },
  '/':  { prec: 4 },
  '^':  { prec: 6 }
};
var MC_UNARY_PREC_ = 5;

function parseFormula_(formula) {
  var tokens = tokenizeFormula_(formula);
  var state = { tokens: tokens, pos: 0, formula: formula };
  var expr = parseExpr_(state, 0);
  expectType_(state, 'eof');
  return expr;
}

function peek_(state)    { return state.tokens[state.pos]; }
function advance_(state) { return state.tokens[state.pos++]; }

function expectType_(state, type) {
  var tok = peek_(state);
  if (tok.type !== type) {
    throw new Error('Expected ' + type + ' but got ' + describeToken_(tok) +
                    ' in formula: ' + state.formula);
  }
  return advance_(state);
}

function describeToken_(tok) {
  if (tok.type === 'eof') return 'end of formula';
  if (tok.type === 'op') return 'operator "' + tok.value + '"';
  if (tok.type === 'ref') return 'cell reference "' + tok.value + '"';
  if (tok.type === 'ident') return 'identifier "' + tok.value + '"';
  if (tok.type === 'number' || tok.type === 'string' || tok.type === 'bool') {
    return tok.type + ' ' + JSON.stringify(tok.value);
  }
  return tok.type;
}

function parseExpr_(state, minPrec) {
  var left = parsePrefix_(state);

  while (true) {
    var tok = peek_(state);
    if (tok.type !== 'op') break;
    var info = MC_BINARY_OPS_[tok.value];
    if (!info || info.prec < minPrec) break;

    advance_(state);
    // All of our binary ops are left-associative → nextMinPrec = prec + 1.
    var right = parseExpr_(state, info.prec + 1);
    left = { type: 'binop', op: tok.value, left: left, right: right };
  }
  return left;
}

function parsePrefix_(state) {
  var tok = peek_(state);

  if (tok.type === 'op' && (tok.value === '-' || tok.value === '+')) {
    advance_(state);
    var operand = parseExpr_(state, MC_UNARY_PREC_);
    return { type: 'unary', op: tok.value, operand: operand };
  }

  return parseAtom_(state);
}

function parseAtom_(state) {
  var tok = peek_(state);

  if (tok.type === 'number') { advance_(state); return { type: 'num',  value: tok.value }; }
  if (tok.type === 'string') { advance_(state); return { type: 'str',  value: tok.value }; }
  if (tok.type === 'bool')   { advance_(state); return { type: 'bool', value: tok.value }; }

  if (tok.type === '(') {
    advance_(state);
    var expr = parseExpr_(state, 0);
    expectType_(state, ')');
    return expr;
  }

  if (tok.type === 'ref') {
    advance_(state);
    if (peek_(state).type === ':') {
      advance_(state);
      var endTok = expectType_(state, 'ref');
      return { type: 'range', start: tok.value, end: endTok.value };
    }
    return { type: 'ref', value: tok.value };
  }

  if (tok.type === 'ident') {
    advance_(state);
    if (peek_(state).type !== '(') {
      throw new Error('Expected "(" after function name "' + tok.value +
                      '" in formula: ' + state.formula);
    }
    advance_(state);
    var args = [];
    if (peek_(state).type !== ')') {
      args.push(parseExpr_(state, 0));
      while (peek_(state).type === ',') {
        advance_(state);
        args.push(parseExpr_(state, 0));
      }
    }
    expectType_(state, ')');
    return { type: 'call', name: tok.value, args: args };
  }

  throw new Error('Unexpected ' + describeToken_(tok) + ' in formula: ' + state.formula);
}

// =====================================================================

/**
 * Walk an AST and return the unique set of cell refs it reads.
 * Ranges expand to all individual cells.
 */
function extractRefsFromAst_(ast) {
  var refs = Object.create(null);
  walk_(ast, refs);
  return Object.keys(refs);
}

function walk_(ast, refs) {
  if (!ast) return;
  switch (ast.type) {
    case 'num': case 'str': case 'bool': return;
    case 'ref':
      refs[ast.value] = true;
      return;
    case 'range':
      var cells = expandRange_(ast.start, ast.end);
      for (var i = 0; i < cells.length; i++) refs[cells[i]] = true;
      return;
    case 'unary':
      walk_(ast.operand, refs); return;
    case 'binop':
      walk_(ast.left, refs); walk_(ast.right, refs); return;
    case 'call':
      for (var j = 0; j < ast.args.length; j++) walk_(ast.args[j], refs);
      return;
    default:
      throw new Error('Unknown AST node type: ' + ast.type);
  }
}

/**
 * Convert "A1" ↔ { col: 0, row: 1 }  (col is zero-indexed, row is one-indexed).
 */
function parseA1_(ref) {
  var m = String(ref).match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error('Invalid cell reference: ' + ref);
  var colLetters = m[1];
  var row = parseInt(m[2], 10);
  var col = 0;
  for (var i = 0; i < colLetters.length; i++) {
    col = col * 26 + (colLetters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: row };
}

function formatA1_(col, row) {
  var letters = '';
  var c = col + 1;
  while (c > 0) {
    var rem = (c - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return letters + row;
}

function expandRange_(startRef, endRef) {
  var a = parseA1_(startRef);
  var b = parseA1_(endRef);
  var colLo = Math.min(a.col, b.col);
  var colHi = Math.max(a.col, b.col);
  var rowLo = Math.min(a.row, b.row);
  var rowHi = Math.max(a.row, b.row);
  var out = [];
  for (var r = rowLo; r <= rowHi; r++) {
    for (var c = colLo; c <= colHi; c++) {
      out.push(formatA1_(c, r));
    }
  }
  return out;
}

// =====================================================================

// =====================================================================
// FormulaFunctions.gs
// =====================================================================

/**
 * FormulaFunctions.gs
 *
 * Registry of spreadsheet functions. Each function takes an array of
 * already-evaluated arguments and returns a value (or an error sentinel).
 *
 * Error-value convention: errors are plain objects { __error: '#DIV/0!' }.
 * Functions either propagate errors (most do) or catch them (IFERROR).
 *
 * Blank cells: represented as `null` in the state map. Aggregations skip
 * them; arithmetic coerces them to 0; IF treats them as falsy.
 *
 * Range args arrive as 2D arrays (rows × cols). Scalar args are primitives.
 */

// ---------------------------------------------------------------------
// Error sentinels
// ---------------------------------------------------------------------

var MC_ERR_DIV0  = '#DIV/0!';
var MC_ERR_VALUE = '#VALUE!';
var MC_ERR_NUM   = '#NUM!';
var MC_ERR_NA    = '#N/A';
var MC_ERR_NAME  = '#NAME?';
var MC_ERR_REF   = '#REF!';
var MC_ERR_CYCLE = '#CYCLE!';

function makeError_(code) { return { __error: code }; }

function isError_(v) {
  return v !== null && typeof v === 'object' && '__error' in v;
}

// First scalar error in a flat args array (does NOT scan into ranges).
function scalarError_(args) {
  for (var i = 0; i < args.length; i++) if (isError_(args[i])) return args[i];
  return null;
}

// Deep scan: return the first error anywhere in the args (including ranges).
function anyError_(args) {
  var flat = flattenArgs_(args);
  for (var i = 0; i < flat.length; i++) if (isError_(flat[i])) return flat[i];
  return null;
}

function flattenArgs_(args) {
  var out = [];
  for (var i = 0; i < args.length; i++) pushFlat_(args[i], out);
  return out;
}

function pushFlat_(v, out) {
  if (Array.isArray(v)) {
    for (var i = 0; i < v.length; i++) pushFlat_(v[i], out);
  } else {
    out.push(v);
  }
}

// ---------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------

function isBlank_(v) {
  return v === null || v === undefined || v === '';
}

function toNumber_(v) {
  if (isError_(v)) return v;
  if (typeof v === 'number') {
    if (isNaN(v) || !isFinite(v)) return makeError_(MC_ERR_NUM);
    return v;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isBlank_(v)) return 0;
  if (typeof v === 'string') {
    var trimmed = v.trim();
    if (trimmed === '') return 0;
    var n = Number(trimmed);
    if (isNaN(n)) return makeError_(MC_ERR_VALUE);
    return n;
  }
  if (Array.isArray(v)) return makeError_(MC_ERR_VALUE);
  return makeError_(MC_ERR_VALUE);
}

function toBoolean_(v) {
  if (isError_(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isBlank_(v)) return false;
  if (typeof v === 'string') {
    var up = v.toUpperCase().trim();
    if (up === 'TRUE')  return true;
    if (up === 'FALSE') return false;
    // Any other non-empty string is truthy in Sheets.
    return up !== '';
  }
  return makeError_(MC_ERR_VALUE);
}

function finite_(x) {
  if (isError_(x)) return x;
  if (typeof x !== 'number') return makeError_(MC_ERR_VALUE);
  if (isNaN(x) || !isFinite(x)) return makeError_(MC_ERR_NUM);
  return x;
}

// Collect numeric values across a mix of scalar/array args.
// - Scalars: coerced with toNumber_; strings that can't coerce propagate error.
// - Arrays:  skip strings, booleans, and blanks (matches Sheets aggregation).
// - Errors:  propagate (returned as the first element with _stop flag).
function collectNumbers_(args, opts) {
  opts = opts || {};
  var includeBooleansFromArrays = !!opts.includeBooleansFromArrays;
  var nums = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (Array.isArray(a)) {
      var flat = [];
      pushFlat_(a, flat);
      for (var j = 0; j < flat.length; j++) {
        var v = flat[j];
        if (isError_(v)) return { error: v };
        if (typeof v === 'number') {
          if (isNaN(v) || !isFinite(v)) return { error: makeError_(MC_ERR_NUM) };
          nums.push(v);
        } else if (typeof v === 'boolean' && includeBooleansFromArrays) {
          nums.push(v ? 1 : 0);
        }
        // else: skip (blanks, strings, booleans-in-ranges-default)
      }
    } else {
      if (isError_(a)) return { error: a };
      if (isBlank_(a)) continue;  // skip
      var n = toNumber_(a);
      if (isError_(n)) return { error: n };
      nums.push(n);
    }
  }
  return { nums: nums };
}

// ---------------------------------------------------------------------
// Function registry
// ---------------------------------------------------------------------

var MC_FUNCTIONS_ = {};

// -- Math aggregations ------------------------------------------------

MC_FUNCTIONS_.SUM = function (args) {
  var r = collectNumbers_(args, { includeBooleansFromArrays: true });
  if (r.error) return r.error;
  var s = 0;
  for (var i = 0; i < r.nums.length; i++) s += r.nums[i];
  return s;
};

MC_FUNCTIONS_.PRODUCT = function (args) {
  var r = collectNumbers_(args, { includeBooleansFromArrays: true });
  if (r.error) return r.error;
  if (r.nums.length === 0) return 0;  // Sheets returns 0 for empty PRODUCT
  var p = 1;
  for (var i = 0; i < r.nums.length; i++) p *= r.nums[i];
  return p;
};

MC_FUNCTIONS_.AVERAGE = function (args) {
  var r = collectNumbers_(args);
  if (r.error) return r.error;
  if (r.nums.length === 0) return makeError_(MC_ERR_DIV0);
  var s = 0;
  for (var i = 0; i < r.nums.length; i++) s += r.nums[i];
  return s / r.nums.length;
};

MC_FUNCTIONS_.MIN = function (args) {
  var r = collectNumbers_(args);
  if (r.error) return r.error;
  if (r.nums.length === 0) return 0;
  var m = r.nums[0];
  for (var i = 1; i < r.nums.length; i++) if (r.nums[i] < m) m = r.nums[i];
  return m;
};

MC_FUNCTIONS_.MAX = function (args) {
  var r = collectNumbers_(args);
  if (r.error) return r.error;
  if (r.nums.length === 0) return 0;
  var m = r.nums[0];
  for (var i = 1; i < r.nums.length; i++) if (r.nums[i] > m) m = r.nums[i];
  return m;
};

MC_FUNCTIONS_.COUNT = function (args) {
  // Count numeric values only. Skip booleans/strings/blanks in ranges.
  // For scalar args, count if coercible to finite number.
  var count = 0;
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (isError_(a)) return a;
    if (Array.isArray(a)) {
      var flat = [];
      pushFlat_(a, flat);
      for (var j = 0; j < flat.length; j++) {
        var v = flat[j];
        if (typeof v === 'number' && isFinite(v)) count++;
      }
    } else if (typeof a === 'number' && isFinite(a)) {
      count++;
    } else if (typeof a === 'string') {
      var t = a.trim();
      if (t !== '' && !isNaN(Number(t))) count++;
    }
  }
  return count;
};

MC_FUNCTIONS_.COUNTA = function (args) {
  var count = 0;
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (isError_(a)) { count++; continue; }  // errors count as "non-blank"
    if (Array.isArray(a)) {
      var flat = [];
      pushFlat_(a, flat);
      for (var j = 0; j < flat.length; j++) if (!isBlank_(flat[j])) count++;
    } else if (!isBlank_(a)) count++;
  }
  return count;
};

MC_FUNCTIONS_.MEDIAN = function (args) {
  var r = collectNumbers_(args);
  if (r.error) return r.error;
  var xs = r.nums.slice().sort(function (a, b) { return a - b; });
  if (xs.length === 0) return makeError_(MC_ERR_NUM);
  var mid = Math.floor(xs.length / 2);
  return (xs.length % 2) ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
};

MC_FUNCTIONS_.STDEV = function (args) {
  var r = collectNumbers_(args);
  if (r.error) return r.error;
  var n = r.nums.length;
  if (n < 2) return makeError_(MC_ERR_DIV0);
  var mean = 0;
  for (var i = 0; i < n; i++) mean += r.nums[i];
  mean /= n;
  var ss = 0;
  for (var j = 0; j < n; j++) { var d = r.nums[j] - mean; ss += d * d; }
  return Math.sqrt(ss / (n - 1));
};

MC_FUNCTIONS_.VAR = function (args) {
  var r = collectNumbers_(args);
  if (r.error) return r.error;
  var n = r.nums.length;
  if (n < 2) return makeError_(MC_ERR_DIV0);
  var mean = 0;
  for (var i = 0; i < n; i++) mean += r.nums[i];
  mean /= n;
  var ss = 0;
  for (var j = 0; j < n; j++) { var d = r.nums[j] - mean; ss += d * d; }
  return ss / (n - 1);
};

MC_FUNCTIONS_.PERCENTILE = function (args) {
  if (args.length !== 2) return makeError_(MC_ERR_VALUE);
  var r = collectNumbers_([args[0]]);
  if (r.error) return r.error;
  var k = toNumber_(args[1]);
  if (isError_(k)) return k;
  if (k < 0 || k > 1 || r.nums.length === 0) return makeError_(MC_ERR_NUM);
  var xs = r.nums.slice().sort(function (a, b) { return a - b; });
  var idx = k * (xs.length - 1);
  var lo = Math.floor(idx);
  var hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (idx - lo) * (xs[hi] - xs[lo]);
};

MC_FUNCTIONS_.SUMPRODUCT = function (args) {
  // Element-wise product across same-shape arrays, then sum.
  // Simplified: flatten each arg, require equal flat lengths, multiply, sum.
  if (args.length === 0) return 0;
  var flats = args.map(function (a) { var out = []; pushFlat_(a, out); return out; });
  var len = flats[0].length;
  for (var i = 1; i < flats.length; i++) {
    if (flats[i].length !== len) return makeError_(MC_ERR_VALUE);
  }
  var sum = 0;
  for (var k = 0; k < len; k++) {
    var prod = 1;
    for (var j = 0; j < flats.length; j++) {
      var v = flats[j][k];
      if (isError_(v)) return v;
      if (isBlank_(v)) { prod = 0; break; }
      var n = toNumber_(v);
      if (isError_(n)) { prod = 0; break; }  // Sheets treats non-numeric as 0 here
      prod *= n;
    }
    sum += prod;
  }
  return sum;
};

// -- Single-argument math --------------------------------------------

function _unaryNum(fn) {
  return function (args) {
    if (args.length !== 1) return makeError_(MC_ERR_VALUE);
    var n = toNumber_(args[0]);
    if (isError_(n)) return n;
    return finite_(fn(n));
  };
}

MC_FUNCTIONS_.ABS    = _unaryNum(Math.abs);
MC_FUNCTIONS_.SQRT   = _unaryNum(function (x) { return x < 0 ? NaN : Math.sqrt(x); });
MC_FUNCTIONS_.EXP    = _unaryNum(Math.exp);
MC_FUNCTIONS_.LN     = _unaryNum(function (x) { return x <= 0 ? NaN : Math.log(x); });
MC_FUNCTIONS_.LOG10  = _unaryNum(function (x) { return x <= 0 ? NaN : Math.log(x) / Math.LN10; });
MC_FUNCTIONS_.INT    = _unaryNum(Math.floor);

MC_FUNCTIONS_.LOG = function (args) {
  if (args.length < 1 || args.length > 2) return makeError_(MC_ERR_VALUE);
  var x = toNumber_(args[0]);
  if (isError_(x)) return x;
  var base = (args.length === 2) ? toNumber_(args[1]) : 10;
  if (isError_(base)) return base;
  if (x <= 0 || base <= 0 || base === 1) return makeError_(MC_ERR_NUM);
  return Math.log(x) / Math.log(base);
};

MC_FUNCTIONS_.POWER = function (args) {
  if (args.length !== 2) return makeError_(MC_ERR_VALUE);
  var a = toNumber_(args[0]);
  if (isError_(a)) return a;
  var b = toNumber_(args[1]);
  if (isError_(b)) return b;
  return finite_(Math.pow(a, b));
};

MC_FUNCTIONS_.MOD = function (args) {
  if (args.length !== 2) return makeError_(MC_ERR_VALUE);
  var a = toNumber_(args[0]);
  if (isError_(a)) return a;
  var b = toNumber_(args[1]);
  if (isError_(b)) return b;
  if (b === 0) return makeError_(MC_ERR_DIV0);
  // Sheets MOD(a, b) uses the sign of b.
  return a - b * Math.floor(a / b);
};

MC_FUNCTIONS_.ROUND = function (args) {
  if (args.length < 1 || args.length > 2) return makeError_(MC_ERR_VALUE);
  var x = toNumber_(args[0]);
  if (isError_(x)) return x;
  var n = (args.length === 2) ? toNumber_(args[1]) : 0;
  if (isError_(n)) return n;
  var f = Math.pow(10, Math.trunc(n));
  return Math.round(x * f) / f;
};

MC_FUNCTIONS_.CEILING = function (args) {
  if (args.length < 1 || args.length > 2) return makeError_(MC_ERR_VALUE);
  var x = toNumber_(args[0]);
  if (isError_(x)) return x;
  var step = (args.length === 2) ? toNumber_(args[1]) : 1;
  if (isError_(step)) return step;
  if (step === 0) return 0;
  return Math.ceil(x / step) * step;
};

MC_FUNCTIONS_.FLOOR = function (args) {
  if (args.length < 1 || args.length > 2) return makeError_(MC_ERR_VALUE);
  var x = toNumber_(args[0]);
  if (isError_(x)) return x;
  var step = (args.length === 2) ? toNumber_(args[1]) : 1;
  if (isError_(step)) return step;
  if (step === 0) return 0;
  return Math.floor(x / step) * step;
};

MC_FUNCTIONS_.TRUNC = function (args) {
  if (args.length < 1 || args.length > 2) return makeError_(MC_ERR_VALUE);
  var x = toNumber_(args[0]);
  if (isError_(x)) return x;
  var n = (args.length === 2) ? toNumber_(args[1]) : 0;
  if (isError_(n)) return n;
  var f = Math.pow(10, Math.trunc(n));
  return (x < 0 ? Math.ceil(x * f) : Math.floor(x * f)) / f;
};

// -- Logic ------------------------------------------------------------

MC_FUNCTIONS_.IF = function (args) {
  if (args.length < 2 || args.length > 3) return makeError_(MC_ERR_VALUE);
  var cond = toBoolean_(args[0]);
  if (isError_(cond)) return cond;
  if (cond) return args[1];
  return args.length === 3 ? args[2] : false;
};

MC_FUNCTIONS_.IFS = function (args) {
  if (args.length % 2 !== 0 || args.length === 0) return makeError_(MC_ERR_VALUE);
  for (var i = 0; i < args.length; i += 2) {
    var cond = toBoolean_(args[i]);
    if (isError_(cond)) return cond;
    if (cond) return args[i + 1];
  }
  return makeError_(MC_ERR_NA);
};

MC_FUNCTIONS_.AND = function (args) {
  if (args.length === 0) return makeError_(MC_ERR_VALUE);
  var flat = flattenArgs_(args);
  var saw = false;
  for (var i = 0; i < flat.length; i++) {
    var v = flat[i];
    if (isError_(v)) return v;
    if (isBlank_(v)) continue;
    var b = toBoolean_(v);
    if (isError_(b)) return b;
    if (!b) return false;
    saw = true;
  }
  return saw;
};

MC_FUNCTIONS_.OR = function (args) {
  if (args.length === 0) return makeError_(MC_ERR_VALUE);
  var flat = flattenArgs_(args);
  for (var i = 0; i < flat.length; i++) {
    var v = flat[i];
    if (isError_(v)) return v;
    if (isBlank_(v)) continue;
    var b = toBoolean_(v);
    if (isError_(b)) return b;
    if (b) return true;
  }
  return false;
};

MC_FUNCTIONS_.NOT = function (args) {
  if (args.length !== 1) return makeError_(MC_ERR_VALUE);
  var b = toBoolean_(args[0]);
  if (isError_(b)) return b;
  return !b;
};

MC_FUNCTIONS_.IFERROR = function (args) {
  if (args.length < 1 || args.length > 2) return makeError_(MC_ERR_VALUE);
  if (isError_(args[0])) {
    return args.length === 2 ? args[1] : '';
  }
  return args[0];
};

MC_FUNCTIONS_.TRUE  = function () { return true; };
MC_FUNCTIONS_.FALSE = function () { return false; };
MC_FUNCTIONS_.NA    = function () { return makeError_(MC_ERR_NA); };
MC_FUNCTIONS_.ISERROR = function (args) {
  if (args.length !== 1) return makeError_(MC_ERR_VALUE);
  return isError_(args[0]);
};
MC_FUNCTIONS_.ISNUMBER = function (args) {
  if (args.length !== 1) return makeError_(MC_ERR_VALUE);
  var v = args[0];
  if (isError_(v)) return false;
  return typeof v === 'number' && isFinite(v);
};
MC_FUNCTIONS_.ISBLANK = function (args) {
  if (args.length !== 1) return makeError_(MC_ERR_VALUE);
  var v = args[0];
  if (isError_(v)) return false;
  return isBlank_(v);
};

// PI is a zero-arg function in Sheets: PI()
MC_FUNCTIONS_.PI = function (args) {
  if (args.length !== 0) return makeError_(MC_ERR_VALUE);
  return Math.PI;
};

// =====================================================================

// =====================================================================
// FormulaEvaluator.gs
// =====================================================================

/**
 * FormulaEvaluator.gs
 *
 * Evaluates an AST against a state map { 'A1': value, 'B2': value, ... }.
 *
 * Returns one of:
 *   - number / string / boolean / null  (null = blank)
 *   - 2D array (for range expressions)
 *   - error sentinel  { __error: '#DIV/0!' }
 *
 * The evaluator never throws for runtime errors — they always come back
 * as error sentinels so the simulation loop can record them per-iteration
 * and continue. (Exceptions are reserved for programming bugs.)
 */

function evalAst_(ast, state) {
  if (!ast) return makeError_(MC_ERR_VALUE);

  switch (ast.type) {
    case 'num':
    case 'str':
    case 'bool':
      return ast.value;

    case 'ref': {
      var v = state[ast.value];
      return v === undefined ? null : v;
    }

    case 'range':
      return evalRange_(ast.start, ast.end, state);

    case 'unary': {
      var u = evalAst_(ast.operand, state);
      if (isError_(u)) return u;
      var un = toNumber_(u);
      if (isError_(un)) return un;
      return ast.op === '-' ? -un : un;
    }

    case 'binop':
      return evalBinop_(ast, state);

    case 'call':
      return evalCall_(ast, state);
  }

  throw new Error('Unknown AST node type: ' + ast.type);
}

function evalRange_(startRef, endRef, state) {
  var a = parseA1_(startRef);
  var b = parseA1_(endRef);
  var colLo = Math.min(a.col, b.col);
  var colHi = Math.max(a.col, b.col);
  var rowLo = Math.min(a.row, b.row);
  var rowHi = Math.max(a.row, b.row);
  var rows = [];
  for (var r = rowLo; r <= rowHi; r++) {
    var row = [];
    for (var c = colLo; c <= colHi; c++) {
      var ref = formatA1_(c, r);
      var v = state[ref];
      row.push(v === undefined ? null : v);
    }
    rows.push(row);
  }
  return rows;
}

function evalBinop_(ast, state) {
  var op = ast.op;

  // Concatenation
  if (op === '&') {
    var lc = evalAst_(ast.left, state);
    if (isError_(lc)) return lc;
    var rc = evalAst_(ast.right, state);
    if (isError_(rc)) return rc;
    return valueToString_(lc) + valueToString_(rc);
  }

  // Comparison
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    var lcm = evalAst_(ast.left, state);
    if (isError_(lcm)) return lcm;
    var rcm = evalAst_(ast.right, state);
    if (isError_(rcm)) return rcm;
    return compareValues_(op, lcm, rcm);
  }

  // Arithmetic: + - * / ^
  var lv = evalAst_(ast.left, state);
  if (isError_(lv)) return lv;
  if (Array.isArray(lv)) lv = firstScalar_(lv);
  var ln = toNumber_(lv);
  if (isError_(ln)) return ln;

  var rv = evalAst_(ast.right, state);
  if (isError_(rv)) return rv;
  if (Array.isArray(rv)) rv = firstScalar_(rv);
  var rn = toNumber_(rv);
  if (isError_(rn)) return rn;

  switch (op) {
    case '+': return finite_(ln + rn);
    case '-': return finite_(ln - rn);
    case '*': return finite_(ln * rn);
    case '/':
      if (rn === 0) return makeError_(MC_ERR_DIV0);
      return finite_(ln / rn);
    case '^':
      // 0^0 is conventionally 1 in spreadsheets; let's match Math.pow.
      return finite_(Math.pow(ln, rn));
  }
  return makeError_(MC_ERR_VALUE);
}

function evalCall_(ast, state) {
  var fn = MC_FUNCTIONS_[ast.name];
  if (!fn) {
    return makeError_(MC_ERR_NAME);
  }
  var args = new Array(ast.args.length);
  for (var i = 0; i < ast.args.length; i++) {
    args[i] = evalAst_(ast.args[i], state);
  }
  return fn(args, state);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function valueToString_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return valueToString_(firstScalar_(v));
  return String(v);
}

function firstScalar_(arr) {
  // Implicit intersection: take top-left cell of an array.
  while (Array.isArray(arr) && arr.length > 0) arr = arr[0];
  return arr === undefined ? null : arr;
}

function compareValues_(op, l, r) {
  // Coerce to scalar.
  if (Array.isArray(l)) l = firstScalar_(l);
  if (Array.isArray(r)) r = firstScalar_(r);

  var cmp;
  var ln = numericOrNull_(l);
  var rn = numericOrNull_(r);

  if (ln !== null && rn !== null) {
    cmp = ln < rn ? -1 : (ln > rn ? 1 : 0);
  } else {
    var ls = valueToString_(l).toLowerCase();
    var rs = valueToString_(r).toLowerCase();
    cmp = ls < rs ? -1 : (ls > rs ? 1 : 0);
  }

  switch (op) {
    case '=':  return cmp === 0;
    case '<>': return cmp !== 0;
    case '<':  return cmp < 0;
    case '>':  return cmp > 0;
    case '<=': return cmp <= 0;
    case '>=': return cmp >= 0;
  }
  return false;
}

function numericOrNull_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'string') {
    var t = v.trim();
    if (t === '') return 0;
    var n = Number(t);
    return isNaN(n) ? null : n;
  }
  return null;
}

// =====================================================================

// =====================================================================
// DependencyGraph.gs
// =====================================================================

/**
 * DependencyGraph.gs
 *
 * Given a model (dict of cells: distribution | formula | static),
 * produce an evaluation plan: the order in which formula cells must
 * be computed on each iteration.
 *
 * Also validates function names up front (errors at build time, not
 * during the simulation loop, so users see them immediately).
 */

/**
 * model.cells: { 'A1': cell, ... }
 * cell.kind: 'distribution' | 'formula' | 'static'
 * cell.ast (for formula): parsed AST
 * cell.sampler (for distribution): { sample, describe }
 * cell.value (for static): scalar value (null for blank)
 *
 * Returns:
 *   {
 *     formulaOrder:     ['C3', 'D5', ...],   // topologically sorted
 *     distributionRefs: ['A1', 'B2', ...],
 *     staticRefs:       ['A2', ...]
 *   }
 *
 * Throws on cycles or unknown function names.
 */
function buildEvalPlan_(model) {
  var cells = model.cells;

  // Classify cells
  var formulaRefs = [];
  var distRefs = [];
  var staticRefs = [];
  for (var ref in cells) {
    var c = cells[ref];
    if (c.kind === 'distribution') distRefs.push(ref);
    else if (c.kind === 'formula') formulaRefs.push(ref);
    else staticRefs.push(ref);
  }

  // Validate function names in every formula AST
  for (var i = 0; i < formulaRefs.length; i++) {
    var fref = formulaRefs[i];
    validateFunctionsInAst_(cells[fref].ast, fref);
  }

  // Build dependency edges (only formula→formula matter for ordering)
  var deps = {};          // ref -> [refs it directly depends on, that are also formula cells]
  var allDeps = {};       // ref -> [all refs it directly depends on]
  for (var j = 0; j < formulaRefs.length; j++) {
    var fr = formulaRefs[j];
    var refs = extractRefsFromAst_(cells[fr].ast);
    allDeps[fr] = refs;
    var fdeps = [];
    for (var k = 0; k < refs.length; k++) {
      var d = refs[k];
      if (cells[d] && cells[d].kind === 'formula') fdeps.push(d);
    }
    deps[fr] = fdeps;
  }

  // Reverse graph: revDeps[d] = formulas that depend on d
  var revDeps = {};
  for (var p = 0; p < formulaRefs.length; p++) {
    var r = formulaRefs[p];
    for (var q = 0; q < deps[r].length; q++) {
      var dd = deps[r][q];
      (revDeps[dd] = revDeps[dd] || []).push(r);
    }
  }

  // Kahn's topo sort
  var inDegree = {};
  for (var s = 0; s < formulaRefs.length; s++) inDegree[formulaRefs[s]] = deps[formulaRefs[s]].length;

  var queue = [];
  for (var t = 0; t < formulaRefs.length; t++) {
    if (inDegree[formulaRefs[t]] === 0) queue.push(formulaRefs[t]);
  }

  var order = [];
  while (queue.length) {
    var cur = queue.shift();
    order.push(cur);
    var rds = revDeps[cur] || [];
    for (var m = 0; m < rds.length; m++) {
      var nxt = rds[m];
      inDegree[nxt]--;
      if (inDegree[nxt] === 0) queue.push(nxt);
    }
  }

  if (order.length !== formulaRefs.length) {
    var cyclic = [];
    for (var u = 0; u < formulaRefs.length; u++) {
      if (inDegree[formulaRefs[u]] > 0) cyclic.push(formulaRefs[u]);
    }
    throw new Error('Circular reference detected among cells: ' + cyclic.join(', ') +
                    '. Remove the cycle and run again.');
  }

  return {
    formulaOrder: order,
    distributionRefs: distRefs,
    staticRefs: staticRefs,
    allDeps: allDeps
  };
}

function validateFunctionsInAst_(ast, cellRef) {
  if (!ast) return;
  switch (ast.type) {
    case 'num': case 'str': case 'bool': case 'ref': case 'range': return;
    case 'unary': validateFunctionsInAst_(ast.operand, cellRef); return;
    case 'binop':
      validateFunctionsInAst_(ast.left, cellRef);
      validateFunctionsInAst_(ast.right, cellRef);
      return;
    case 'call':
      if (!MC_FUNCTIONS_[ast.name]) {
        throw new Error('Cell ' + cellRef + ': Unknown function "' + ast.name +
                        '". Supported functions: ' + Object.keys(MC_FUNCTIONS_).sort().join(', '));
      }
      for (var i = 0; i < ast.args.length; i++) {
        validateFunctionsInAst_(ast.args[i], cellRef);
      }
      return;
    default:
      throw new Error('Cell ' + cellRef + ': unknown AST node type "' + ast.type + '"');
  }
}

// =====================================================================

// =====================================================================
// Stats.gs
// =====================================================================

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

  // Sample skewness (used to decide log-vs-linear histogram bins).
  var skewness = 0;
  if (stdev > 0 && n > 2) {
    var sk = 0;
    for (var t = 0; t < n; t++) {
      var dt = (clean[t] - mean) / stdev;
      sk += dt * dt * dt;
    }
    skewness = sk / n;
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
  return sk / n;
}

// =====================================================================

// =====================================================================
// Simulation.gs
// =====================================================================

/**
 * Simulation.gs
 *
 * Runs the Monte Carlo loop.
 *
 * Input: a model (from ModelReader) + options.
 * Output: sample arrays for each input and output, plus metadata.
 *
 * Errors during evaluation are recorded as NaN per iteration and counted
 * via errorCounts, so a single bad path never kills the whole run.
 */

function runSimulationCore_(model, options) {
  options = options || {};
  var iterations = options.iterations > 0 ? Math.floor(options.iterations) : 10000;
  var seed = (options.seed !== undefined && options.seed !== null)
    ? (options.seed >>> 0)
    : (Date.now() & 0xFFFFFFFF);
  var progress = options.progress || null;

  var plan = buildEvalPlan_(model);

  // Pre-build samplers once (this also runs validation).
  var samplers = {};
  for (var d = 0; d < plan.distributionRefs.length; d++) {
    var dref = plan.distributionRefs[d];
    samplers[dref] = buildSampler_(model.cells[dref].distSpec);
  }

  // Seed the state map with static values.
  var state = {};
  for (var s = 0; s < plan.staticRefs.length; s++) {
    var sref = plan.staticRefs[s];
    state[sref] = model.cells[sref].value;
  }

  // Identify outputs.
  var outputs = [];
  for (var ref in model.cells) {
    if (model.cells[ref].isOutput) outputs.push(ref);
  }
  if (outputs.length === 0) {
    throw new Error('No output cells marked. Add "Output" in the MonteCarlo column for at least one row.');
  }
  if (plan.distributionRefs.length === 0) {
    throw new Error('No distribution cells defined. Add a distribution keyword (Normal, LogNormal, Uniform, or Discrete) in the MonteCarlo column for at least one row.');
  }

  // Pre-allocate sample arrays.
  var outputSamples = {};
  for (var o = 0; o < outputs.length; o++) outputSamples[outputs[o]] = new Array(iterations);
  var inputSamples = {};
  for (var d2 = 0; d2 < plan.distributionRefs.length; d2++) {
    inputSamples[plan.distributionRefs[d2]] = new Array(iterations);
  }

  var rng = mulberry32_(seed);
  resetNormalCache_();  // ensure no stale cache from a previous run leaks in

  // Error counts per output.
  var errorCounts = {};
  for (var o2 = 0; o2 < outputs.length; o2++) errorCounts[outputs[o2]] = 0;

  var startTime = Date.now();

  for (var iter = 0; iter < iterations; iter++) {
    // Sample all distributions for this iteration.
    for (var di = 0; di < plan.distributionRefs.length; di++) {
      var dr = plan.distributionRefs[di];
      var v = samplers[dr].sample(rng);
      state[dr] = v;
      inputSamples[dr][iter] = v;
    }

    // Evaluate formula cells in topological order.
    for (var fi = 0; fi < plan.formulaOrder.length; fi++) {
      var fr = plan.formulaOrder[fi];
      state[fr] = evalAst_(model.cells[fr].ast, state);
    }

    // Collect outputs.
    for (var oi = 0; oi < outputs.length; oi++) {
      var oref = outputs[oi];
      var ov = state[oref];
      if (isError_(ov)) {
        outputSamples[oref][iter] = NaN;
        errorCounts[oref]++;
      } else if (typeof ov === 'number') {
        if (isNaN(ov) || !isFinite(ov)) {
          outputSamples[oref][iter] = NaN;
          errorCounts[oref]++;
        } else {
          outputSamples[oref][iter] = ov;
        }
      } else {
        var n = numericOrNull_(ov);
        if (n === null) {
          outputSamples[oref][iter] = NaN;
          errorCounts[oref]++;
        } else {
          outputSamples[oref][iter] = n;
        }
      }
    }

    if (progress && iter > 0 && iter % 1000 === 0) {
      progress(iter, iterations);
    }
  }

  var elapsedMs = Date.now() - startTime;

  // Gather labels for display (fall back to cell ref if no label).
  function labelFor(ref) {
    var c = model.cells[ref];
    return (c && c.label) ? c.label : ref;
  }

  return {
    iterations: iterations,
    seed: seed,
    elapsedMs: elapsedMs,
    outputSamples: outputSamples,
    inputSamples: inputSamples,
    errorCounts: errorCounts,
    outputRefs: outputs,
    inputRefs: plan.distributionRefs,
    labelOf: labelFor,
    describeDist: function (ref) {
      return samplers[ref] ? samplers[ref].describe() : '';
    }
  };
}

// =====================================================================

// =====================================================================
// ModelReader.gs
// =====================================================================

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

// =====================================================================
// ResultsWriter.gs
// =====================================================================

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

// =====================================================================
// Main.gs
// =====================================================================

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
      'errors next to each Mean (±1.96·SE ≈ 95% CI) and an Effective N column when iterations error out.</p>' +
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
