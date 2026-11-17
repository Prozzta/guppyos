'use strict';
/**
 * ELECTRON-RMSYNC-AGENT-WRITABLE-108: the race of electron-rmsync-jitter.test.cjs. Started by it
 * in the installed Guppy.exe as Node (ELECTRON_RUN_AS_NODE=1), in one of two roles:
 *   <this file> race <sync|async> <base> <runs>   remove a folder again and again while a planter runs
 *   <this file> plant <dir> <victim> <stop>      the planter: an agent that keeps planting junctions
 * The race prints one JSON line: { ok, electron, out } or { ok: false, error }.
 * HOME must already be the parent's jail, and <base> inside it: nothing here may reach a real home.
 */
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VICTIM_FILES = 5;

/** The agent: plant <dir>/a/j and <dir>/a/b/j -> victim, with a random 0 to 3 ms wait between tries. */
function plant(dir, victim, stop) {
  let planted = 0;
  while (!fs.existsSync(stop)) {
    const until = Date.now() + Math.random() * 3;
    while (Date.now() < until) { /* spin: a timer is too coarse for this window */ }
    for (const sub of ['a', path.join('a', 'b')]) {
      try { fs.symlinkSync(victim, path.join(dir, sub, 'j'), 'junction'); planted++; } catch { /* no folder now, or j is there */ }
    }
  }
  console.log(JSON.stringify({ planted }));
}

/** Remove whatever is at `p` without following a link (the fixture's own clean-up, not the code under test). */
function sweep(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
  if (!st.isDirectory()) { fs.unlinkSync(p); return; }
  for (const nm of fs.readdirSync(p)) sweep(path.join(p, nm));
  fs.rmdirSync(p);
}

async function race(mode, base, runs) {
  const home = path.resolve(os.homedir());
  if (!path.resolve(base).startsWith(home + path.sep) || !home.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error(`HOME is not the test jail (${home}); refusing to run`);
  }
  const { safeRemoveTree, safeRemoveTreeSync } = require('./load-ts.cjs')(path.join(__dirname, '..', 'src/main/fsSafeRemove.ts'));
  // The shape of an agent's own claims.purge-old: a folder the agent can write while main removes it.
  const dir = path.join(base, 'claims.purge-old');
  const victim = path.join(base, 'victim');
  const stop = path.join(base, 'stop');
  fs.mkdirSync(victim, { recursive: true });
  const kid = child.spawn(process.execPath, [__filename, 'plant', dir, victim, stop], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let kidOut = '';
  kid.stdout.on('data', (d) => { kidOut += d; });
  const exited = new Promise((resolve) => kid.on('exit', resolve));

  const out = { runs: 0, losses: 0, refused: 0, errors: {}, linkLeft: 0, planted: 0 };
  const end = Date.now() + 60_000;
  try {
    while (out.runs < runs && Date.now() < end) {
      for (let i = 0; i < VICTIM_FILES; i++) fs.writeFileSync(path.join(victim, `v${i}.txt`), 'x');
      try {
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, 'a', 'b', `f${i}`), 'y');
      } catch { try { sweep(dir); } catch { /* the planter is in it; next pass */ } continue; }
      out.runs++;
      try { if (mode === 'sync') safeRemoveTreeSync(dir); else await safeRemoveTree(dir); }
      catch (e) {
        if (/refused/.test(String(e && e.message))) out.refused++;
        else { const k = (e && e.code) || String(e && e.message).slice(0, 40); out.errors[k] = (out.errors[k] || 0) + 1; }
      }
      if (fs.readdirSync(victim).length < VICTIM_FILES) out.losses++;
      if (fs.existsSync(dir)) out.linkLeft++;
      for (let i = 0; i < 20 && fs.existsSync(dir); i++) { try { sweep(dir); } catch { /* the planter got in again */ } }
    }
  } finally {
    fs.writeFileSync(stop, '');
    await exited;
  }
  try { out.planted = JSON.parse(kidOut).planted; } catch { out.planted = -1; }
  return out;
}

if (require.main === module) {
  const [role, a, b, c] = process.argv.slice(2);
  if (!process.versions.electron) { console.error('this child runs in Electron as Node only'); process.exit(64); }
  if (role === 'plant') plant(a, b, c);
  else {
    race(a, b, Number(c))
      .then((out) => ({ ok: true, electron: process.versions.electron, out }), (e) => ({ ok: false, error: String(e && e.stack || e) }))
      .then((res) => { console.log(JSON.stringify(res)); });
  }
}
