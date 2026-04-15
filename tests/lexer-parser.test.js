const h = require('./harness');
const ctx = h.sandbox();

h.describe('lexer', () => {

  h.test('strips leading =', () => {
    const toks = ctx.tokenizeFormula_('=42');
    h.eq(toks, [{ type: 'number', value: 42 }, { type: 'eof' }]);
  });

  h.test('handles plain numbers', () => {
    h.eq(ctx.tokenizeFormula_('42')[0], { type: 'number', value: 42 });
    h.eq(ctx.tokenizeFormula_('3.14')[0], { type: 'number', value: 3.14 });
    h.eq(ctx.tokenizeFormula_('.5')[0], { type: 'number', value: 0.5 });
    h.eq(ctx.tokenizeFormula_('5.')[0], { type: 'number', value: 5 });
    h.eq(ctx.tokenizeFormula_('1e-3')[0], { type: 'number', value: 0.001 });
    h.eq(ctx.tokenizeFormula_('2.5E+2')[0], { type: 'number', value: 250 });
  });

  h.test('handles cell refs with $ anchors', () => {
    h.eq(ctx.tokenizeFormula_('A1')[0], { type: 'ref', value: 'A1' });
    h.eq(ctx.tokenizeFormula_('$A$1')[0], { type: 'ref', value: 'A1' });
    h.eq(ctx.tokenizeFormula_('ab123')[0], { type: 'ref', value: 'AB123' });
  });

  h.test('distinguishes refs from identifiers', () => {
    h.eq(ctx.tokenizeFormula_('SUM')[0], { type: 'ident', value: 'SUM' });
    h.eq(ctx.tokenizeFormula_('A1')[0], { type: 'ref', value: 'A1' });
    h.eq(ctx.tokenizeFormula_('TRUE')[0], { type: 'bool', value: true });
    h.eq(ctx.tokenizeFormula_('FALSE')[0], { type: 'bool', value: false });
  });

  h.test('handles operators', () => {
    h.eq(ctx.tokenizeFormula_('<=')[0], { type: 'op', value: '<=' });
    h.eq(ctx.tokenizeFormula_('<>')[0], { type: 'op', value: '<>' });
    h.eq(ctx.tokenizeFormula_('&')[0], { type: 'op', value: '&' });
  });

  h.test('handles strings with escaped quotes', () => {
    h.eq(ctx.tokenizeFormula_('"hello"')[0], { type: 'string', value: 'hello' });
    h.eq(ctx.tokenizeFormula_('"a""b"')[0], { type: 'string', value: 'a"b' });
  });

  h.test('unterminated string throws', () => {
    h.throws(() => ctx.tokenizeFormula_('"oops'), /Unterminated/);
  });
});

h.describe('parser', () => {

  h.test('simple arithmetic', () => {
    const ast = ctx.parseFormula_('=1+2');
    h.eq(ast, { type: 'binop', op: '+',
                left: { type: 'num', value: 1 },
                right: { type: 'num', value: 2 } });
  });

  h.test('operator precedence: + vs *', () => {
    const ast = ctx.parseFormula_('=1+2*3');
    h.eq(ast.op, '+');
    h.eq(ast.right.op, '*');
  });

  h.test('parentheses override precedence', () => {
    const ast = ctx.parseFormula_('=(1+2)*3');
    h.eq(ast.op, '*');
    h.eq(ast.left.op, '+');
  });

  h.test('^ binds tighter than unary minus', () => {
    // -2^2 should parse as -(2^2), not (-2)^2
    const ast = ctx.parseFormula_('=-2^2');
    h.eq(ast.type, 'unary');
    h.eq(ast.op, '-');
    h.eq(ast.operand.type, 'binop');
    h.eq(ast.operand.op, '^');
  });

  h.test('^ is left-associative (Sheets convention)', () => {
    // 2^3^2 parses as (2^3)^2 = 64
    const ast = ctx.parseFormula_('=2^3^2');
    h.eq(ast.op, '^');
    h.eq(ast.left.op, '^');
    h.eq(ast.right.value, 2);
  });

  h.test('function call with args', () => {
    const ast = ctx.parseFormula_('=SUM(A1, A2, 3)');
    h.eq(ast.type, 'call');
    h.eq(ast.name, 'SUM');
    h.eq(ast.args.length, 3);
    h.eq(ast.args[0].type, 'ref');
    h.eq(ast.args[2].value, 3);
  });

  h.test('function call with no args', () => {
    const ast = ctx.parseFormula_('=PI()');
    h.eq(ast, { type: 'call', name: 'PI', args: [] });
  });

  h.test('range', () => {
    const ast = ctx.parseFormula_('=SUM(A1:B10)');
    h.eq(ast.args[0], { type: 'range', start: 'A1', end: 'B10' });
  });

  h.test('comparison operators', () => {
    const ast = ctx.parseFormula_('=A1<=B1');
    h.eq(ast, { type: 'binop', op: '<=',
                left: { type: 'ref', value: 'A1' },
                right: { type: 'ref', value: 'B1' } });
  });

  h.test('extractRefsFromAst finds all refs', () => {
    const ast = ctx.parseFormula_('=A1 + SUM(B1:C3) * D4');
    const refs = ctx.extractRefsFromAst_(ast).sort();
    h.eq(refs, ['A1', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3', 'D4']);
  });

  h.test('expandRange for single row', () => {
    h.eq(ctx.expandRange_('A1', 'D1'), ['A1', 'B1', 'C1', 'D1']);
  });

  h.test('expandRange for 2x2 block', () => {
    h.eq(ctx.expandRange_('A1', 'B2'), ['A1', 'B1', 'A2', 'B2']);
  });

  h.test('parseA1 roundtrip', () => {
    h.eq(ctx.parseA1_('A1'), { col: 0, row: 1 });
    h.eq(ctx.parseA1_('Z26'), { col: 25, row: 26 });
    h.eq(ctx.parseA1_('AA1'), { col: 26, row: 1 });
    h.eq(ctx.formatA1_(0, 1), 'A1');
    h.eq(ctx.formatA1_(26, 1), 'AA1');
    h.eq(ctx.formatA1_(701, 1), 'ZZ1');
  });

  h.test('unknown character throws with position', () => {
    h.throws(() => ctx.parseFormula_('=1@2'), /Unexpected/);
  });

  h.test('missing ) throws', () => {
    h.throws(() => ctx.parseFormula_('=SUM(1, 2'), /Expected/);
  });
});

if (require.main === module) h.runAll();
