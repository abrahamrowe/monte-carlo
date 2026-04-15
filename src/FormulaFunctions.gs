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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MC_FUNCTIONS_: MC_FUNCTIONS_,
    makeError_: makeError_,
    isError_: isError_,
    isBlank_: isBlank_,
    toNumber_: toNumber_,
    toBoolean_: toBoolean_,
    finite_: finite_,
    flattenArgs_: flattenArgs_,
    MC_ERR_DIV0: MC_ERR_DIV0,
    MC_ERR_VALUE: MC_ERR_VALUE,
    MC_ERR_NUM: MC_ERR_NUM,
    MC_ERR_NA: MC_ERR_NA,
    MC_ERR_NAME: MC_ERR_NAME,
    MC_ERR_REF: MC_ERR_REF,
    MC_ERR_CYCLE: MC_ERR_CYCLE
  };
}
