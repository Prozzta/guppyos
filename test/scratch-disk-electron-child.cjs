'use strict';

const path = require('node:path');
const scratch = require('./load-ts.cjs')('src/main/scratchDisk.ts');
const base = process.argv[2];
if (!base || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(64);
try {
  scratch.removeScratchRoot(path.join(base, 'work'), path.join(base, 'work', 'tree'));
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
}
