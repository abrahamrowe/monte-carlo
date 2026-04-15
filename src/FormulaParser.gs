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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseFormula_: parseFormula_,
    extractRefsFromAst_: extractRefsFromAst_,
    parseA1_: parseA1_,
    formatA1_: formatA1_,
    expandRange_: expandRange_
  };
}
