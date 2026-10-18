'use strict';

const fs = require('node:fs');
const path = require('node:path');

const allocated = new Set();

function newMutantDir(label) {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error(`invalid mutant directory label: ${label}`);
  const dir = fs.mkdtempSync(path.join(__dirname, `.mutants-${label}-`));
  allocated.add(path.resolve(dir));
  return dir;
}

function cleanupMutantDir(dir) {
  const resolved = path.resolve(dir);
  if (!allocated.delete(resolved)) throw new Error(`refusing to clean an unallocated mutant directory: ${dir}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = { newMutantDir, cleanupMutantDir };
