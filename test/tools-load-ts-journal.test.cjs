'use strict';
// SCRATCH-DISK-REAP-108: release-worktrees loads linkSafeRemove through tools/load-ts.cjs.
// It must fail closed if a census left that source journaled; no real repository journal is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../tools/load-ts.cjs');

test('tools load-ts refuses a temporary root with a nonempty mutant recovery journal (MUTANT: removing the guard loads x.ts)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-load-ts-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, '.mutant-runner-recovery.json'), JSON.stringify({
    owner: { pid: 2147483000, start: '2026-11-18T00:00:00Z' },
    records: [{ file: path.join(root, 'src', 'x.ts'), original: Buffer.from('export const x = 0;\n').toString('base64') }]
  }));
  assert.throws(() => loadTs.forRoot(root)('src/x.ts'), /\[tools\/load-ts\] refusing to load mutated source: mutant recovery journal is present\. Journaled: .*src[\\/]x\.ts/);
});
