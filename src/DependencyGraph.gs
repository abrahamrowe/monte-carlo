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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildEvalPlan_: buildEvalPlan_,
    validateFunctionsInAst_: validateFunctionsInAst_
  };
}
