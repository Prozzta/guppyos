'use strict';
/**
 * CLAIMS-REKEY-SHARED-KEY child: one "app instance" writing the shared user-data record files.
 * argv: <userData> <tag> <count> <goFile>. Waits for goFile so every child starts together, then
 * sets <count> key-record entries and <count> head anchors under its own synthetic floor roots.
 * HOME/USERPROFILE come jailed from the parent and are asserted before product code loads.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [ud, tag, countArg, goFile] = process.argv.slice(2);
assert.ok(process.env.CLAIMS_REKEY_JAIL && os.homedir() === process.env.CLAIMS_REKEY_JAIL, 'HOME must be jailed');
assert.ok(path.resolve(ud).startsWith(path.resolve(process.env.CLAIMS_REKEY_JAIL)), 'user-data must be inside the jail');

const loadTs = require('../load-ts.cjs');
const ROOT = path.join(__dirname, '..', '..');
const { FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));

const rec = new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE));
const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 20000;
while (!fs.existsSync(goFile)) {
  if (Date.now() > deadline) process.exit(3);
  Atomics.wait(wait, 0, 0, 2);
}
const n = Number(countArg);
for (let i = 0; i < n; i++) {
  const floor = path.join(ud, '..', `FLOOR-${tag}-${i}`);
  rec.set(floor, `key-${tag}-${i}`);
  anchors.set(floor, 'andy', { head: `head-${tag}-${i}`, lastId: `c-${tag}${i}` });
}
process.exit(0);
