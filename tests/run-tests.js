/**
 * Runs all test files under tests/*.test.js and prints a summary.
 *
 * Usage:
 *   node tests/run-tests.js
 *   STACK=1 node tests/run-tests.js   # show full stack on failure
 */

require('./distributions.test');
require('./lexer-parser.test');
require('./evaluator.test');
require('./stats.test');
require('./simulation.test');
require('./model-reader.test');

const { runAll } = require('./harness');
runAll();
