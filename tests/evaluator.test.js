const h = require('./harness');
const ctx = h.sandbox();

function evalFormula(formula, state) {
  const ast = ctx.parseFormula_(formula);
  return ctx.evalAst_(ast, state || {});
}

h.describe('evaluator — arithmetic', () => {

  h.test('basic arithmetic', () => {
    h.eq(evalFormula('=1+2'), 3);
    h.eq(evalFormula('=10-3*2'), 4);
    h.eq(evalFormula('=2^3'), 8);
    h.eq(evalFormula('=(2+3)*4'), 20);
  });

  h.test('division by zero is #DIV/0!', () => {
    const r = evalFormula('=5/0');
    h.eq(r, { __error: '#DIV/0!' });
  });

  h.test('unary minus', () => {
    h.eq(evalFormula('=-5+3'), -2);
    h.eq(evalFormula('=-2^2'), -4);  // Sheets convention
  });

  h.test('cell reference resolves', () => {
    h.eq(evalFormula('=A1*2', { A1: 5 }), 10);
  });

  h.test('blank cell coerces to 0', () => {
    h.eq(evalFormula('=A1+3', { A1: null }), 3);
  });

  h.test('string coercion in arithmetic', () => {
    h.eq(evalFormula('=A1+3', { A1: '5' }), 8);
    const r = evalFormula('=A1+3', { A1: 'abc' });
    h.eq(r, { __error: '#VALUE!' });
  });

  h.test('boolean coercion in arithmetic', () => {
    h.eq(evalFormula('=A1+3', { A1: true }), 4);
    h.eq(evalFormula('=A1+3', { A1: false }), 3);
  });

  h.test('error propagates through +', () => {
    const r = evalFormula('=(1/0)+5');
    h.eq(r, { __error: '#DIV/0!' });
  });
});

h.describe('evaluator — comparisons and strings', () => {

  h.test('equality returns boolean', () => {
    h.eq(evalFormula('=1=1'), true);
    h.eq(evalFormula('=1=2'), false);
    h.eq(evalFormula('=1<>2'), true);
  });

  h.test('concat operator', () => {
    h.eq(evalFormula('="foo"&"bar"'), 'foobar');
    h.eq(evalFormula('=A1&"!"', { A1: 42 }), '42!');
  });

  h.test('string comparison is case-insensitive', () => {
    h.eq(evalFormula('="abc"="ABC"'), true);
  });
});

h.describe('evaluator — functions', () => {

  h.test('SUM over range', () => {
    const state = { A1: 1, A2: 2, A3: 3, A4: 4 };
    h.eq(evalFormula('=SUM(A1:A4)', state), 10);
  });

  h.test('SUM ignores strings in ranges', () => {
    const state = { A1: 1, A2: 'oops', A3: 3 };
    h.eq(evalFormula('=SUM(A1:A3)', state), 4);
  });

  h.test('SUM of empty range is 0', () => {
    h.eq(evalFormula('=SUM(A1:A3)', {}), 0);
  });

  h.test('AVERAGE skips blanks, divides by numeric count', () => {
    const state = { A1: 2, A2: null, A3: 4 };
    h.eq(evalFormula('=AVERAGE(A1:A3)', state), 3);
  });

  h.test('AVERAGE of no numbers is #DIV/0!', () => {
    const r = evalFormula('=AVERAGE(A1:A3)', { A1: 'a', A2: 'b', A3: null });
    h.eq(r, { __error: '#DIV/0!' });
  });

  h.test('MIN/MAX over range', () => {
    const state = { A1: 5, A2: 2, A3: 8, A4: 3 };
    h.eq(evalFormula('=MIN(A1:A4)', state), 2);
    h.eq(evalFormula('=MAX(A1:A4)', state), 8);
  });

  h.test('COUNT counts only numbers', () => {
    const state = { A1: 1, A2: 'x', A3: 3, A4: null };
    h.eq(evalFormula('=COUNT(A1:A4)', state), 2);
  });

  h.test('IF returns branch', () => {
    h.eq(evalFormula('=IF(TRUE, 1, 2)'), 1);
    h.eq(evalFormula('=IF(FALSE, 1, 2)'), 2);
  });

  h.test('IF with comparison', () => {
    h.eq(evalFormula('=IF(A1>0, "pos", "neg")', { A1: 5 }), 'pos');
    h.eq(evalFormula('=IF(A1>0, "pos", "neg")', { A1: -5 }), 'neg');
  });

  h.test('IFERROR catches errors', () => {
    h.eq(evalFormula('=IFERROR(1/0, 99)'), 99);
    h.eq(evalFormula('=IFERROR(5, 99)'), 5);
  });

  h.test('IFS picks first matching', () => {
    h.eq(evalFormula('=IFS(FALSE, 1, TRUE, 2, TRUE, 3)'), 2);
  });

  h.test('IFS with no match is #N/A', () => {
    h.eq(evalFormula('=IFS(FALSE, 1, FALSE, 2)'), { __error: '#N/A' });
  });

  h.test('AND / OR short-circuit', () => {
    h.eq(evalFormula('=AND(TRUE, TRUE, TRUE)'), true);
    h.eq(evalFormula('=AND(TRUE, FALSE, TRUE)'), false);
    h.eq(evalFormula('=OR(FALSE, FALSE, TRUE)'), true);
  });

  h.test('SQRT of negative is #NUM!', () => {
    h.eq(evalFormula('=SQRT(-1)'), { __error: '#NUM!' });
  });

  h.test('LN of non-positive is #NUM!', () => {
    h.eq(evalFormula('=LN(0)'), { __error: '#NUM!' });
    h.eq(evalFormula('=LN(-1)'), { __error: '#NUM!' });
  });

  h.test('EXP/LN roundtrip', () => {
    h.near(evalFormula('=LN(EXP(3))'), 3, 1e-9);
  });

  h.test('ROUND / CEILING / FLOOR', () => {
    h.eq(evalFormula('=ROUND(3.14159, 2)'), 3.14);
    h.eq(evalFormula('=CEILING(4.2, 1)'), 5);
    h.eq(evalFormula('=FLOOR(4.8, 1)'), 4);
    h.eq(evalFormula('=CEILING(42, 10)'), 50);
  });

  h.test('MOD with divisor zero is #DIV/0!', () => {
    h.eq(evalFormula('=MOD(5, 0)'), { __error: '#DIV/0!' });
  });

  h.test('POWER', () => {
    h.eq(evalFormula('=POWER(2, 10)'), 1024);
  });

  h.test('MEDIAN', () => {
    const state = { A1: 1, A2: 3, A3: 5, A4: 7, A5: 9 };
    h.eq(evalFormula('=MEDIAN(A1:A5)', state), 5);
  });

  h.test('STDEV of constant is 0', () => {
    const state = { A1: 5, A2: 5, A3: 5, A4: 5 };
    h.eq(evalFormula('=STDEV(A1:A4)', state), 0);
  });

  h.test('PERCENTILE interpolates', () => {
    const state = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 };
    h.eq(evalFormula('=PERCENTILE(A1:A5, 0)', state), 1);
    h.eq(evalFormula('=PERCENTILE(A1:A5, 0.5)', state), 3);
    h.eq(evalFormula('=PERCENTILE(A1:A5, 1)', state), 5);
  });

  h.test('SUMPRODUCT of two ranges', () => {
    const state = { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30 };
    h.eq(evalFormula('=SUMPRODUCT(A1:A3, B1:B3)', state), 1*10 + 2*20 + 3*30);
  });

  h.test('unknown function is #NAME?', () => {
    const r = evalFormula('=FOOBAR(1)');
    h.eq(r, { __error: '#NAME?' });
  });

  h.test('NESTED: IF + SUM', () => {
    const state = { A1: 5 };
    h.eq(evalFormula('=IF(A1>0, SUM(A1,A1,A1), 0)', state), 15);
  });

  h.test('error in SUM range propagates', () => {
    const state = { A1: 1, A2: { __error: '#DIV/0!' }, A3: 3 };
    h.eq(evalFormula('=SUM(A1:A3)', state), { __error: '#DIV/0!' });
  });
});

if (require.main === module) h.runAll();
