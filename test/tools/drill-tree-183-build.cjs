'use strict';
// @heavy-lock live: sustained work: a cold run exports v1.1.83, installs its modules and builds a native (minutes). DRILL-TREE-SELF-BUILD-108.
/**
 * DRILL-TREE-SELF-BUILD-108: the command for the 1.1.83 drill tree (the library is drill-tree-183.cjs).
 *   node test/tools/drill-tree-183-build.cjs            build if absent or broken, verify, print the path
 *   node test/tools/drill-tree-183-build.cjs --check    verify only (exit 1 with the reason; builds nothing)
 *   node test/tools/drill-tree-183-build.cjs --path     print where the tree lives
 * Any other argument is a usage error (exit 2) and does nothing.
 */
const { ensureTree, treeLocation } = require('./drill-tree-183.cjs');

const a = process.argv.slice(2);
if (a.length > 1 || (a.length === 1 && a[0] !== '--check' && a[0] !== '--path')) {
  process.stderr.write('usage: node test/tools/drill-tree-183-build.cjs [--check | --path]\n');
  process.exit(2);
}
try {
  if (a[0] === '--path') process.stdout.write(`${treeLocation().tree}\n`);
  else process.stdout.write(`${ensureTree({ build: a[0] !== '--check' })}\n`);
} catch (e) { process.stderr.write(`drill-tree-183: ${e.message}\n`); process.exit(1); }
