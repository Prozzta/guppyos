'use strict';
require('./tools/own-job.cjs');
/**
 * ELECTRON-RM-EPERM-UNKNOWN-CAUSE-108 (god 6addb8, pin C): once a HiveManager is shut down in the
 * app's order (stopLedgerGuard(), dispose(), await drainReads()) it holds NO directory watcher and
 * NO open file inside its folder.
 *
 * Why it matters: change-home and reset shut the manager down and then copy or delete the folder.
 * Under Electron 45 on Windows a recursive rmSync of a tree with a watcher or a file still open
 * inside it throws ENOTEMPTY, the folder stays delete-pending, and the next rm, mkdir or readdir on
 * it throws EPERM. Runner Node deletes such a tree, so the delete alone proves nothing there:
 * this file counts the handles itself (every fs.watch and fs.openSync under the folder, and its
 * close), which holds on both runtimes, and then deletes the folder as the real consequence.
 * HOME and USERPROFILE are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dispose-handles-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');

// The count, installed before any product code loads: product code calls fs.watch / fs.openSync /
// fs.closeSync through the module object, so it reaches these.
const open = new Set();
const realWatch = fs.watch; const realOpen = fs.openSync; const realClose = fs.closeSync;
const byFd = new Map();
fs.watch = function (p, ...rest) {
  const w = realWatch.call(this, p, ...rest);
  const rec = { kind: 'watch', path: path.resolve(String(p)) };
  open.add(rec);
  const close = w.close.bind(w);
  w.close = () => { open.delete(rec); return close(); };
  return w;
};
fs.openSync = function (p, ...rest) {
  const fd = realOpen.call(this, p, ...rest);
  const rec = { kind: 'fd', path: path.resolve(String(p)) };
  open.add(rec); byFd.set(fd, rec);
  return fd;
};
fs.closeSync = function (fd) {
  const rec = byFd.get(fd);
  if (rec) { open.delete(rec); byFd.delete(fd); }
  return realClose.call(this, fd);
};
test.after(() => {
  fs.watch = realWatch; fs.openSync = realOpen; fs.closeSync = realClose;
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');

/** What is open inside `dir`, as 'kind relative-path' lines. */
const openUnder = (dir) => [...open].filter((r) => r.path === dir || r.path.startsWith(dir + path.sep))
  .map((r) => `${r.kind} ${path.relative(dir, r.path) || '.'}`).sort();

async function floor() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(JAIL, 'floor-')));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'please' }, 'god-1');
  return { home, hive };
}
/** The app's order at change-home and reset (src/main/index.ts). */
async function shutDown(hive) { hive.stopLedgerGuard(); hive.dispose(); await hive.drainReads(); }
function deletes(home) {
  assert.doesNotThrow(() => fs.rmSync(home, { recursive: true, force: true }), 'the folder deletes once the manager is shut down');
  assert.equal(fs.existsSync(home), false, 'and it is gone (not left delete-pending)');
}

test('a manager that watched and logged holds no watcher and no open file in its folder after stopLedgerGuard(), dispose() and drainReads()', async () => {
  const { home, hive } = await floor();
  hive.startLedgerGuard();
  hive.tasks();
  hive.mailObligations();
  await hive.mailObligationsAsync();
  const used = openUnder(home);
  // Not vacuous: the guard's watcher or an authority watcher, and the kept-open log, are there now.
  assert.ok(used.some((l) => l.startsWith('watch ')), `a live manager watches its folder: ${JSON.stringify(used)}`);
  assert.ok(used.some((l) => l.startsWith('fd ')), `a live manager keeps a file open: ${JSON.stringify(used)}`);
  await shutDown(hive);
  assert.deepEqual(openUnder(home), [], 'nothing of the manager is open in its folder after shutdown');
  deletes(home);
});

test('a second manager over the same folder is closed by its own shutdown, not by the first one\'s', async () => {
  const { home, hive } = await floor();
  const cold = new HiveManager(() => home, () => true);
  await cold.mailObligationsAsync();
  cold.mailObligations();
  await shutDown(hive);
  const left = openUnder(home);
  assert.ok(left.length > 0, 'the second manager still holds its own handles: each manager closes only what it opened');
  await shutDown(cold);
  assert.deepEqual(openUnder(home), [], 'nothing is open once both are shut down');
  deletes(home);
});
