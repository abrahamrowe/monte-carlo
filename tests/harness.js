/**
 * tests/harness.js
 *
 * Loads the .gs source files into a shared VM context so their
 * top-level `var` declarations and function definitions are visible
 * to each other (mimicking Apps Script's global scope).
 *
 * Exposes:
 *   - sandbox()        → loaded context with all exported symbols
 *   - test(name, fn)   → registers a test; throw from fn to fail
 *   - runAll()         → runs registered tests, exits non-zero on failure
 *   - assert helpers
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function sandbox() {
  const srcDir = path.join(__dirname, '..', 'src');
  // Load in dependency order (later files may reference earlier ones).
  const files = [
    'Distributions.gs',
    'FormulaLexer.gs',
    'FormulaParser.gs',
    'FormulaFunctions.gs',
    'FormulaEvaluator.gs',
    'DependencyGraph.gs',
    'Stats.gs',
    'Simulation.gs',
    'ModelReader.gs'
  ];
  const context = {
    Math, Date, isFinite, isNaN, Number, String, Array, Object,
    console, JSON, parseInt, parseFloat, undefined,
    Infinity, NaN, Boolean, Error, RegExp
  };
  context.global = context;
  vm.createContext(context);
  for (const f of files) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    try {
      vm.runInContext(src, context, { filename: f });
    } catch (e) {
      console.error(`Failed to load ${f}:`, e.stack);
      throw e;
    }
  }
  return context;
}

// ---------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------

const _tests = [];
let _currentFile = null;

function test(name, fn) {
  _tests.push({ name, fn, file: _currentFile });
}

function describe(file, block) {
  _currentFile = file;
  block();
  _currentFile = null;
}

function runAll() {
  let passed = 0, failed = 0;
  const byFile = {};
  for (const t of _tests) {
    const file = t.file || 'misc';
    if (!byFile[file]) byFile[file] = [];
    byFile[file].push(t);
  }
  for (const file of Object.keys(byFile)) {
    console.log(`\n▸ ${file}`);
    for (const t of byFile[file]) {
      try {
        t.fn();
        console.log(`   ✓ ${t.name}`);
        passed++;
      } catch (e) {
        console.error(`   ✗ ${t.name}`);
        console.error(`     ${e.message}`);
        if (process.env.STACK) console.error(e.stack);
        failed++;
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

function eq(actual, expected, msg) {
  const aStr = JSON.stringify(actual, stringifier);
  const eStr = JSON.stringify(expected, stringifier);
  if (aStr !== eStr) {
    throw new Error((msg || 'eq') + `: expected ${eStr}, got ${aStr}`);
  }
}

function stringifier(_, v) {
  if (typeof v === 'number' && !isFinite(v)) return String(v);
  return v;
}

function near(actual, expected, tol, msg) {
  if (typeof actual !== 'number' || isNaN(actual)) {
    throw new Error((msg || 'near') + `: expected number, got ${actual}`);
  }
  if (Math.abs(actual - expected) > tol) {
    throw new Error((msg || 'near') +
      `: expected ${expected} ± ${tol}, got ${actual} (diff ${Math.abs(actual - expected)})`);
  }
}

function truthy(v, msg) {
  if (!v) throw new Error((msg || 'truthy') + `: got ${v}`);
}

function throws(fn, pattern, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error((msg || 'throws') + ': expected to throw but did not');
  if (pattern) {
    const matches = pattern instanceof RegExp ? pattern.test(err.message) : err.message.includes(pattern);
    if (!matches) {
      throw new Error((msg || 'throws') +
        `: error message ${JSON.stringify(err.message)} did not match ${pattern}`);
    }
  }
}

module.exports = { sandbox, test, describe, runAll, eq, near, truthy, throws };
