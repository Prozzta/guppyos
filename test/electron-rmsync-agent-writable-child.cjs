'use strict';
/**
 * ELECTRON-RMSYNC-AGENT-WRITABLE-108: the sites of electron-rmsync-agent-writable.test.cjs, run on
 * a fixture the parent built. Loaded by the parent (plain Node) and started by it in the installed
 * Guppy.exe as Node:  Guppy.exe <this file> <site> <base>   (ELECTRON_RUN_AS_NODE=1)
 * Prints one JSON line: { ok, electron, out } or { ok: false, error }.
 * HOME must already be the parent's jail, and <base> inside it: nothing here may reach a real home.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const DAY = '2026-11-17';

function openStore(base) {
  const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
  const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
  const ud = path.join(base, 'userdata');
  const logs = [];
  const store = new ClaimStore({
    hiveRoot: path.join(base, 'hive'), keys: new SandboxKeyProvider(),
    keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)),
    headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)),
    alert: () => {}, log: (r) => logs.push(r)
  });
  return { store, logs };
}

const SITES = {
  /** store.ts finishPurgeSwap: any read of an agent's ledger finishes or drops a purge swap. */
  'purge-swap'(base) {
    const { store, logs } = openStore(base);
    try {
      store.readLedger('evil');
      store.readLedger('other');
    } finally { store.close(); }
    return { failed: logs.filter((r) => r.kind === 'claims-purge-failed').map((r) => r.error) };
  },
  /** store.ts backupIfDue: the day's backup is built in `<day>.tmp-<pid>`, removed first if it is there. */
  'backup-tmp'(base) {
    const dayDir = path.join(base, 'hive', 'backups', 'claims', 'evil', DAY);
    fs.mkdirSync(path.dirname(dayDir), { recursive: true });
    // Only this process knows its pid: the left-over is planted here, a junction to live/backup.
    fs.symlinkSync(path.join(base, 'live', 'backup'), `${dayDir}.tmp-${process.pid}`, 'junction');
    const { store, logs } = openStore(base);
    let made;
    try { made = store.backupIfDue('evil', `${DAY}T10:00:00.000Z`); } finally { store.close(); }
    return { made: made === dayDir, failed: logs.filter((r) => r.kind === 'claims-backup-failed').map((r) => r.error) };
  },
  /**
   * store.ts logOnce: a clean-up that fails on every pass is logged once per path. Three ledger
   * reads with purge-old undeletable (this process's working folder is inside it; Windows refuses
   * to remove that), and three backup attempts on each of two days with the backup folder's
   * parent a file.
   */
  'refusal-log'(base) {
    const held = path.join(base, 'hive', 'agents', 'evil', 'memory', 'claims.purge-old', 'held');
    const { store, logs } = openStore(base);
    const cwd = process.cwd();
    try {
      process.chdir(held);
      for (let i = 0; i < 3; i++) store.readLedger('evil');
      for (const day of [DAY, '2026-11-18']) for (let i = 0; i < 3; i++) store.backupIfDue('evil', `${day}T10:00:00.000Z`);
    } finally { process.chdir(cwd); store.close(); }
    const rows = (kind) => logs.filter((r) => r.kind === kind).map((r) => ({ step: r.step, day: r.day, once: r.once }));
    return { purge: rows('claims-purge-failed'), backup: rows('claims-backup-failed'), oldStillThere: fs.existsSync(held) };
  },
  /** kg-core.cjs removeDoc: a doc folder that is a link, and a real one with a link inside it. */
  'kg-remove'(base) {
    const core = require(path.join(ROOT, 'src', 'main', 'kg-core.cjs'));
    const kg = path.join(base, 'kg');
    return { linked: core.removeDoc(kg, 'linked'), real: core.removeDoc(kg, 'real') };
  }
};

function run(site, base) {
  if (!SITES[site]) throw new Error(`unknown site ${site}`);
  const home = path.resolve(os.homedir());
  if (!path.resolve(base).startsWith(home + path.sep) || !home.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error(`HOME is not the test jail (${home}); refusing to run ${site}`);
  }
  return SITES[site](base);
}

module.exports = { run, DAY };

if (require.main === module) {
  if (!process.versions.electron) { console.error('this child runs in Electron as Node only'); process.exit(64); }
  let res;
  try { res = { ok: true, electron: process.versions.electron, out: run(process.argv[2], process.argv[3]) }; }
  catch (e) { res = { ok: false, error: String(e && e.stack || e) }; }
  console.log(JSON.stringify(res));
}
