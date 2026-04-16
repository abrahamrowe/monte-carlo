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

  // IF and IFS need lazy evaluation: only evaluate the branch that's
  // actually taken. Without this, =IF(B1>0, LN(B1), 0) would error
  // when B1<=0 because the LN(B1) branch is evaluated eagerly.
  if (ast.name === 'IF')  return evalIF_(ast.args, state);
  if (ast.name === 'IFS') return evalIFS_(ast.args, state);

  var args = new Array(ast.args.length);
  for (var i = 0; i < ast.args.length; i++) {
    args[i] = evalAst_(ast.args[i], state);
  }
  return fn(args, state);
}

function evalIF_(argAsts, state) {
  if (argAsts.length < 2 || argAsts.length > 3) return makeError_(MC_ERR_VALUE);
  var cond = toBoolean_(evalAst_(argAsts[0], state));
  if (isError_(cond)) return cond;
  if (cond) return evalAst_(argAsts[1], state);
  return argAsts.length === 3 ? evalAst_(argAsts[2], state) : false;
}

function evalIFS_(argAsts, state) {
  if (argAsts.length % 2 !== 0 || argAsts.length === 0) return makeError_(MC_ERR_VALUE);
  for (var i = 0; i < argAsts.length; i += 2) {
    var cond = toBoolean_(evalAst_(argAsts[i], state));
    if (isError_(cond)) return cond;
    if (cond) return evalAst_(argAsts[i + 1], state);
  }
  return makeError_(MC_ERR_NA);
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    evalAst_: evalAst_,
    evalRange_: evalRange_,
    evalBinop_: evalBinop_,
    evalCall_: evalCall_,
    valueToString_: valueToString_,
    compareValues_: compareValues_
  };
}
