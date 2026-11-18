'use strict';
/**
 * Small TypeScript loader for repository maintenance tools. It deliberately lives outside test/:
 * scripts use it too, and scripts must not depend on the test harness. It refuses a tree the
 * mutant census left journaled, because a maintenance script may delete or publish product data.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { assertUnmutated } = require('./mutant-journal.cjs');

const ROOT = path.resolve(__dirname, '..');
function forRoot(root) {
  root = path.resolve(root);
  const cache = new Map();

  function resolveTs(fromDir, request) {
    const base = request.startsWith('@shared/')
      ? path.resolve(root, 'src/shared', request.slice('@shared/'.length))
      : path.resolve(fromDir, request);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  function loadFile(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
      fileName: filename,
      reportDiagnostics: true
    });
    if (output.diagnostics?.length) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
        getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (name) => name, getNewLine: () => '\n'
      }));
    }
    const mod = { exports: {} };
    cache.set(filename, mod);
    const localRequire = (request) => {
      if (request.startsWith('.') || request.startsWith('@shared/')) {
        const resolved = resolveTs(path.dirname(filename), request);
        if (resolved) return loadFile(resolved);
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', '__filename', '__dirname', output.outputText)(mod, mod.exports, localRequire, filename, path.dirname(filename));
    return mod.exports;
  }

  return function loadTs(relativePath) {
    assertUnmutated(root);
    return loadFile(path.resolve(root, relativePath));
  };
}

/** Load a TypeScript repository module for a script or other maintenance tool. */
const loadTs = forRoot(ROOT);
loadTs.forRoot = forRoot;
module.exports = loadTs;
