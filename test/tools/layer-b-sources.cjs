'use strict';

/**
 * The Layer B runner is deliberately split-friendly: source/AST pins must inspect every
 * implementation module, not only the small CLI entry point.  Keep this inventory here so a
 * new module is pinned as soon as it is placed in tools/layer-b/.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readSource, codeOnly } = require('../read-source.cjs');

const TOOLS = __dirname;
const ENTRY = path.join(TOOLS, 'layer-b-run.cjs');
const MODULE_DIR = path.join(TOOLS, 'layer-b');

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    return entry.isFile() && entry.name.endsWith('.cjs') ? [file] : [];
  });
}

function layerBSources() {
  return [ENTRY, ...filesUnder(MODULE_DIR).sort()].map((file) => {
    const raw = readSource(file);
    return {
      file,
      name: path.relative(TOOLS, file).replace(/\\/g, '/'),
      raw,
      code: codeOnly(raw, path.basename(file)),
    };
  });
}

module.exports = { ENTRY, MODULE_DIR, layerBSources };
