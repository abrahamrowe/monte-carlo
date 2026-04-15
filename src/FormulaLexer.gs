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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tokenizeFormula_: tokenizeFormula_ };
}
