'use strict';
/**
 * FS-REMOVE-READDIR-GAP-108: the race behind fs-remove-gap.test.cjs and the CI pin. Not a test
 * file by itself. It runs under plain Node and under Electron as Node, on Windows, Linux and macOS:
 *   <this file> race <impl> <base> <runs> <seconds>   remove a folder again and again while an agent attacks it
 *   <this file> plant <dir> <victim> <park> <stop> [follow]   the agent
 *   <this file> pin <racers> <runs> <seconds>         <racers> races at once for each of sync, async and reaper,
 *                                                     <runs> each: exit 0 only with every run done and 0 losses
 *                                                     (a fourth argument names the callers, e.g. `sync` or
 *                                                     `async,reaper`, so a long pin can run one caller at a time)
 *   <this file> control <racers> <runs> <seconds>     the same with jswalk: exit 0 only if it LOST; every racer
 *                                                     stops at the first loss by any of them
 * pin and control start their races with FS_GAP_EXE (run as Node: ELECTRON_RUN_AS_NODE=1) when it is
 * set, and with this Node otherwise.
 * `impl` is what removes the folder:
 *   sync | async   src/main/fsSafeRemove.ts safeRemoveTreeSync / safeRemoveTree (the fs-handle addon)
 *   reaper         scripts/worktree-reaper.cjs applyReap on the folder
 *   jswalk         THE CONTROL: the walk of lstat, readdir, unlink and rmdir on paths that
 *                  fsSafeRemove.ts had at e074a677. It must lose, or the agent has no teeth. It loses
 *                  to a link that appears while it walks, planted or swapped in (see HOLD_US).
 * The race prints one JSON line: { ok, electron, node, out } or { ok: false, error }.
 * <base> must be under the temp folder; the victim is <base>/victim and nothing else is named.
 *
 * The agent does two things in a loop, with a random 0 to 3 ms spin between tries:
 *   plant  a link to the victim at <dir>/a/j and <dir>/a/b/j (Jim's planter of 7604b62f)
 *   swap   rename <dir>, <dir>/a or <dir>/a/b away and put a link to the victim under that name.
 *          This is the gap itself: a real folder when it was checked, a link when it is listed. And
 *          because the victim holds files under the tree's own names (MIRROR), it is also every later
 *          step by path: a file that was listed in the real folder is deleted in the victim.
 * The reaper renames the folder to <dir>.reaping-<n> before it deletes it, which would take the tree out
 * of this agent's reach. So against the reaper the agent follows: it works on the newest such name next
 * to <dir> when there is one. The pin counts the agent's links per caller, and a caller the agent did
 * not reach in more than a tenth of its runs fails the pin. It also counts the swaps that landed (the
 * name that was moved away was a real folder of the tree), and a caller with none fails the pin.
 */
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LINK = process.platform === 'win32' ? 'junction' : 'dir';
// The victim also holds a file under every file name the tree has (MIRROR): <dir>/a/b/f9 is the
// victim's f9 once a/b is a link to it, and <dir>/a/g3 is its g3 once a is. So a delete that names a
// file by its path loses it whenever the swap lands while it is still at work in that folder, not only
// in the gap between a check and a listing. Every name, not some: the old walk throws on the first
// name it does not find behind the link, and would stop before it came to one the victim holds.
// The victim holds no folder named a or b: the agent works on those names by path too, and through
// a link it would move the victim's own folders away itself.
const MIRROR = [...Array.from({ length: 40 }, (_, i) => `f${i}`), ...Array.from({ length: 4 }, (_, i) => `g${i}`)];
const VICTIM = ['v0.txt', 'v1.txt', 'v2.txt', 'v3.txt', 'v4.txt', path.join('sub', 's0.txt'), ...MIRROR];

function plant(home, victim, park, stop, follow) {
  const out = { planted: 0, swapped: 0, landed: 0 };
  const parent = path.dirname(home), tomb = `${path.basename(home)}.reaping-`;
  // The newest tombstone of `home`, when the caller renames before it deletes; else `home`.
  const where = () => {
    if (!follow) return home;
    let names = []; try { names = fs.readdirSync(parent).filter((nm) => nm.startsWith(tomb)); } catch { /* not there now */ }
    return names.length ? path.join(parent, names.sort().pop()) : home;
  };
  let n = 0;
  while (!fs.existsSync(stop)) {
    const until = Date.now() + Math.random() * 3;
    while (Date.now() < until) { /* spin: a timer is too coarse for this window */ }
    const dir = where();
    const spots = [dir, path.join(dir, 'a'), path.join(dir, 'a', 'b')];
    if (Math.random() < 0.5) {
      for (const sub of ['a', path.join('a', 'b')]) {
        try { fs.symlinkSync(victim, path.join(dir, sub, 'j'), LINK); out.planted++; } catch { /* no folder now, or j is there */ }
      }
    } else {
      const spot = spots[Math.floor(Math.random() * spots.length)];
      const to = path.join(park, `p${process.pid}-${n++}`);
      let moved = false;
      try {
        fs.renameSync(spot, to);
        moved = true;
        fs.symlinkSync(victim, spot, LINK);
        out.swapped++;
      } catch { /* not there now, busy, or its parent is gone */ }
      // landed: what moved away was a real folder of the tree, not a link left by an earlier swap
      if (moved) { try { if (fs.lstatSync(to).isDirectory()) out.landed++; } catch { /* swept already */ } }
    }
  }
  console.log(JSON.stringify(out));
}

/** Remove whatever is at `p` without following a link (the fixture's own clean-up, not the code under test). */
function sweep(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } return; }
  if (!st.isDirectory()) { fs.unlinkSync(p); return; }
  for (const nm of fs.readdirSync(p)) sweep(path.join(p, nm));
  fs.rmdirSync(p);
}

/** The control: fsSafeRemove.ts safeRemoveTreeSync as it was at e074a677, word for word but in JS. */
function jsWalk(root) {
  const unlinkLink = (p) => {
    if (!fs.lstatSync(p).isSymbolicLink()) throw new Error('refused: expected a reparse point');
    if (process.platform === 'win32') { try { fs.rmdirSync(p); return; } catch { fs.unlinkSync(p); return; } }
    fs.unlinkSync(p);
  };
  const walk = (p, isRoot) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { if (isRoot) throw new Error('refused: root is a reparse point'); unlinkLink(p); return; }
    if (!st.isDirectory()) { if (isRoot) throw new Error('refused: root is not a directory'); fs.unlinkSync(p); return; }
    for (const name of fs.readdirSync(p)) walk(path.join(p, name), false);
    const current = fs.lstatSync(p);
    if (current.isSymbolicLink()) { if (isRoot) throw new Error('refused: root became a reparse point'); unlinkLink(p); return; }
    if (!current.isDirectory()) throw new Error('refused: directory changed during removal');
    try { fs.rmdirSync(p); }
    catch (error) {
      if (error.code !== 'ENOTEMPTY') throw error;
      for (const name of fs.readdirSync(p)) walk(path.join(p, name), false);
      fs.rmdirSync(p);
    }
  };
  walk(root, true);
}

// The control's walk is held for this long after each check that found a real folder. The agent's swap
// is two steps (move the folder away, then put the link there), and between them the name is missing
// for longer than one step of the walk takes. A walk that is never held looks into that hole, throws
// "not found" and loses nothing: measured without load, 322 swaps landed in 300 runs and 208 of the
// walks ended that way, with no loss. Held for 1 ms, the walk meets the finished link instead: 16 of 16
// control legs lost within 73 runs. The hold is put around the walk from outside; the walk's text is
// not changed. The callers under test are one native call each and are not held.
// The plant loses too, by the same lines of the walk. On Windows a junction is made in two steps (an
// empty folder, then the link is set on it), so a planted j is a real folder for a moment. The walk's
// check of j (its first lstat) can fall in that moment; its listing of j (the readdir after it) then
// goes through the finished link, and the victim's files are deleted by path. Measured with 8 racers
// at once: 25 of 32 plant-only legs lost held, 5 of 8 not held, and the check had seen j as a real
// folder in every leg that lost and in none that did not. An agent that does nothing lost nothing in
// 11,982 runs. So the control's claim is: the walk loses to a link that appears while it walks.
const HOLD_US = 1000;

function remover(impl, work) {
  if (impl === 'jswalk') {
    const lstat = fs.lstatSync;
    return (dir) => {
      fs.lstatSync = (...args) => {
        const st = lstat(...args);
        if (st && st.isDirectory()) { const until = process.hrtime.bigint() + BigInt(HOLD_US) * 1000n; while (process.hrtime.bigint() < until) { /* held: a timer is too coarse */ } }
        return st;
      };
      try { jsWalk(dir); } finally { fs.lstatSync = lstat; }
    };
  }
  if (impl === 'reaper') {
    const R = require(path.join(__dirname, '..', 'scripts', 'worktree-reaper.cjs'));
    const rm = R.loadRemover();
    if (!rm.removeTree) throw new Error(`no fs-handle addon: ${rm.reason}`);
    let now = 1700000000000;
    return (dir) => {
      const [r] = R.applyReap([{ name: path.basename(dir), path: dir, kind: 'folder', action: 'reap', reason: 'race' }], { root: work, now: now++, exes: () => [], remover: rm });
      if (r.result !== 'deleted') throw Object.assign(new Error(`reaper: ${r.error || r.result}`), /refused|reparse/.test(String(r.error)) ? { code: 'EREFUSED' } : {});
    };
  }
  const S = require('./load-ts.cjs')(path.join(__dirname, '..', 'src/main/fsSafeRemove.ts'));
  if (impl === 'sync') return (dir) => S.safeRemoveTreeSync(dir);
  if (impl === 'async') return (dir) => S.safeRemoveTree(dir);
  throw new Error(`unknown impl ${impl}`);
}

async function race(impl, base, runs, seconds) {
  const tmp = fs.realpathSync(os.tmpdir());
  base = path.resolve(base);
  if (!base.startsWith(tmp + path.sep) && !base.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error(`the base is not under the temp folder (${base}); refusing to run`);
  const work = path.join(base, 'work');
  const dir = path.join(work, 'claims.purge-old');
  const victim = path.join(base, 'victim');
  const park = path.join(base, 'park');
  const stage = path.join(base, 'stage');
  const stop = path.join(base, 'stop');
  const trash = path.join(base, 'trash');
  for (const d of [work, path.join(victim, 'sub'), park, trash]) fs.mkdirSync(d, { recursive: true });
  const remove = remover(impl, work);
  const kid = child.spawn(process.execPath, [__filename, 'plant', dir, victim, park, stop, ...(impl === 'reaper' ? ['follow'] : [])], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let kidOut = '';
  kid.stdout.on('data', (d) => { kidOut += d; });
  const exited = new Promise((resolve) => kid.on('exit', resolve));

  const out = { impl, runs: 0, losses: 0, firstLossAt: 0, removed: 0, refused: 0, errors: {}, planted: 0, swapped: 0, landed: 0, ms: 0 };
  const t0 = Date.now();
  const end = t0 + seconds * 1000;
  // The fixture's own clean-up must not be the walk under test: what is left at a path the agent
  // can reach is first moved, in one step, to where the agent is not, and only swept there.
  let trashed = 0;
  const clear = (p) => {
    for (let i = 0; i < 50 && fs.lstatSync(p, { throwIfNoEntry: false }); i++) {
      const to = path.join(trash, `t${trashed++}`);
      try { fs.renameSync(p, to); sweep(to); } catch { /* the agent is in it; again */ }
    }
  };
  // The control only: its racers share one flag file, and all stop once any of them has lost.
  const lost = impl === 'jswalk' ? process.env.FS_GAP_LOST : '';
  try {
    while (out.runs < runs && Date.now() < end) {
      if (lost && fs.existsSync(lost)) break;
      fs.mkdirSync(path.join(victim, 'sub'), { recursive: true });
      for (const f of VICTIM) fs.writeFileSync(path.join(victim, f), 'x');
      // Built where the agent is not, then moved into place in one step.
      clear(stage); clear(dir);
      if (impl === 'reaper') for (const nm of fs.readdirSync(work)) { if (nm.startsWith(`${path.basename(dir)}.reaping-`)) clear(path.join(work, nm)); }
      try {
        fs.mkdirSync(path.join(stage, 'a', 'b'), { recursive: true });
        for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(stage, 'a', 'b', `f${i}`), 'y');
        for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(stage, 'a', `g${i}`), 'y');
        fs.renameSync(stage, dir);
      } catch { continue; }
      out.runs++;
      try { await remove(dir); out.removed++; }
      catch (e) {
        if (/refused/.test(String(e && e.message)) || (e && e.code === 'EREFUSED')) out.refused++;
        else { const k = (e && e.code) || String(e && e.message).replace(/'[^']*'|[A-Za-z]:\\\S+|\/\S+/g, '<path>').slice(0, 60); out.errors[k] = (out.errors[k] || 0) + 1; }
      }
      if (!VICTIM.every((f) => fs.existsSync(path.join(victim, f)))) { out.losses++; if (!out.firstLossAt) out.firstLossAt = out.runs; if (impl === 'jswalk') { if (lost) fs.writeFileSync(lost, ''); break; } }
      if (out.runs % 50 === 0) for (const nm of fs.readdirSync(park)) { try { sweep(path.join(park, nm)); } catch { /* next time */ } }
    }
  } finally {
    fs.writeFileSync(stop, '');
    await exited;
  }
  out.ms = Date.now() - t0;
  try { Object.assign(out, JSON.parse(kidOut)); } catch { out.planted = -1; }
  // the agent has stopped: what is left is swept where it lies
  for (const p of [work, stage, park, trash]) { try { sweep(p); } catch { /* reported by the caller's own clean-up */ } }
  return out;
}

/** Run `racers` races of each impl at once, each in its own temp folder; returns the totals per impl. */
async function many(impls, racers, runs, seconds) {
  const exe = process.env.FS_GAP_EXE || process.execPath;
  const flags = impls.includes('jswalk') ? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fs-gap-lost-')) : '';
  const env = { ...process.env, ...(process.env.FS_GAP_EXE ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...(flags ? { FS_GAP_LOST: path.join(flags, 'lost') } : {}) };
  const jobs = [];
  for (const impl of impls) {
    for (let i = 0; i < racers; i++) {
      const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `fs-gap-${impl}-`));
      jobs.push(new Promise((resolve) => {
        child.execFile(exe, [__filename, 'race', impl, base, String(runs), String(seconds)], { env, windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
          let res;
          try { res = JSON.parse(stdout.trim().split('\n').pop()); } catch { res = { ok: false, error: `no result: ${err && err.message} ${stderr}` }; }
          try { sweep(base); } catch { /* left in the temp folder */ }
          resolve({ impl, res });
        });
      }));
    }
  }
  const done = await Promise.all(jobs);
  if (flags) { try { sweep(flags); } catch { /* left in the temp folder */ } }
  const totals = {};
  let runtime = null;
  for (const { impl, res } of done) {
    const t = totals[impl] || (totals[impl] = { races: 0, failed: 0, runs: 0, losses: 0, removed: 0, refused: 0, errors: {}, planted: 0, swapped: 0, landed: 0, firstLossAt: [] });
    t.races++;
    if (!res.ok) { t.failed++; t.errors[`RACE FAILED: ${String(res.error).slice(0, 200)}`] = 1; continue; }
    runtime = res.electron ? `Electron ${res.electron} as Node` : `Node ${res.node}`;
    for (const k of ['runs', 'losses', 'removed', 'refused', 'planted', 'swapped', 'landed']) t[k] += res.out[k];
    for (const [k, v] of Object.entries(res.out.errors)) t.errors[k] = (t.errors[k] || 0) + v;
    if (res.out.firstLossAt) t.firstLossAt.push(res.out.firstLossAt);
  }
  return { runtime, platform: process.platform, totals };
}

module.exports = { race, many, sweep, VICTIM };

if (require.main === module) {
  const [role, a, b, c, d, e] = process.argv.slice(2);
  if (role === 'plant') plant(a, b, c, d, e === 'follow');
  else if (role === 'race') {
    race(a, b, Number(c), Number(d))
      .then((out) => ({ ok: true, electron: process.versions.electron || null, node: process.versions.node, out }), (e) => ({ ok: false, error: String(e && e.stack || e) }))
      .then((res) => { console.log(JSON.stringify(res)); process.exitCode = res.ok ? 0 : 1; });
  } else if (role === 'pin' || role === 'control') {
    const impls = role === 'pin' ? String(d || 'sync,async,reaper').split(',') : ['jswalk'];
    // On GitHub Actions the result line is also a notice on the job, where it can be read without the log.
    const say = (line) => { console.log(line); if (process.env.GITHUB_ACTIONS) console.log(`::notice title=fs-remove-gap ${role}::${line}`); };
    many(impls, Number(a), Number(b), Number(c)).then((res) => {
      console.log(JSON.stringify(res, null, 1));
      const all = Object.values(res.totals);
      const runs = all.reduce((n, t) => n + t.runs, 0), losses = all.reduce((n, t) => n + t.losses, 0);
      const failed = all.reduce((n, t) => n + t.failed, 0), attacks = all.reduce((n, t) => n + t.planted + t.swapped, 0);
      if (role === 'pin') {
        const want = impls.length * Number(a) * Number(b);
        // per caller: a caller the agent hardly reached proves nothing, whatever the others add up to
        const reached = all.every((t) => t.planted + t.swapped > t.runs / 10);
        // per caller too: a caller whose tree the agent never swapped a real folder out of was not raced
        const landed = all.every((t) => t.landed > 0);
        const ok = !failed && losses === 0 && runs === want && reached && landed;
        say(`${ok ? 'PIN PASS' : 'PIN FAIL'}: ${res.runtime} on ${res.platform}: ${impls.join(', ')}: ${runs} of ${want} runs, ${losses} losses, ${attacks} links put in by the agent${reached ? '' : ' (TOO FEW for ' + impls.filter((i) => { const t = res.totals[i]; return !(t.planted + t.swapped > t.runs / 10); }).join(', ') + ')'}, swaps that landed on a real folder: ${impls.map((i) => `${i} ${res.totals[i].landed}`).join(', ')}${landed ? '' : ' (NONE LANDED for ' + impls.filter((i) => !(res.totals[i].landed > 0)).join(', ') + ')'}`);
        process.exitCode = ok ? 0 : 1;
      } else {
        const ok = !failed && losses > 0;
        say(`${ok ? 'CONTROL LOST (as it must)' : 'CONTROL DID NOT LOSE: the agent has no teeth here'}: ${res.runtime} on ${res.platform}: the JS walk lost the victim's files to a link that appeared during the walk in ${losses} of ${runs} runs (${attacks} links planted or swapped in by the agent)`);
        process.exitCode = ok ? 0 : 1;
      }
    });
  } else { console.error('usage: pin <racers> <runs> <seconds> [sync,async,reaper] | control <racers> <runs> <seconds> | race <sync|async|reaper|jswalk> <base> <runs> <seconds> | plant <dir> <victim> <park> <stop> [follow]'); process.exit(64); }
}
