'use strict';
require('./tools/own-job.cjs');
/**
 * FLAKE-RIG-NODE-LOOKUP-UNDER-LOAD-108: a win32 command lookup must not depend on how fast a new
 * process can start.
 *
 * The chain (measured): the mail rig spawns a fake agent through an npm cmd-shim, PtyManager resolves
 * the shim's interpreter "node" with lookupCommandAsync, and on win32 that STARTED where.exe inside a
 * 3000 ms box. Inside the suite's 50%-capped job a new process's start was starved for up to 2986 ms
 * (spawn at 6-49 ms, exit 1.6-3.0 s later, low loop lag). Two boxed runs in a row (the at-once retry)
 * gave UNKNOWN and the spawn refusal "could not be checked": the 3 rig reds.
 *
 * PART A (the red-before): a win32 lookup starts NO process. Counted at the deps.exec seam, no clock:
 *  - A1: a lookup of 'node' that is on PATH makes zero exec calls;
 *  - A2: an exec seam that would take 4 s to answer cannot turn a lookup of a CLI that IS on PATH
 *    into UNKNOWN (on the old path the 3000 ms box fires first).
 * PART B (parity): the answer for a plain name is the one where.exe gives today. A child node, with
 * a fixture PATH (System32 last, so the old path can still start where), runs the real resolver; the
 * test runs the real where.exe with the same env from an empty cwd and applies today's pick rule
 * (first line whose extension is in PATHEXT and that existsSync accepts). Measured where.exe facts
 * this pins (2026-11-19, this box):
 *  - inside one dir where lists matches in DIRECTORY order (rgfy, rgfy.cmd, rgfy.exe), not in PATHEXT
 *    order, for PATHEXT .CMD;.EXE and .exe;.cmd alike; PATHEXT case does not matter;
 *  - a quoted PATH entry is NOT searched by where; empty entries and a trailing backslash are fine;
 *  - a missing dir and a FILE given as a PATH entry are skipped; a DIRECTORY named rgfx.exe is not
 *    listed;
 *  - a name with an extension matches as-is;
 *  - App Execution Aliases (WindowsApps, 0-byte reparse points): where LISTS them, but fs.statSync
 *    throws EACCES and existsSync is FALSE, so today's rule skips them (found:false). Pinned as is.
 *  - where searches the CURRENT DIR first; the cwd here is empty, so this part does not cover that.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const R = loadTs('src/main/commandResolver.ts');
const WIN = process.platform === 'win32';
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rignl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function mk(root, rel, { dir = false } = {}) {
  const p = path.join(root, rel);
  fs.mkdirSync(dir ? p : path.dirname(p), { recursive: true });
  if (!dir) fs.writeFileSync(p, '@echo off\r\n');
  return p;
}

/** The live deps with a fake exec that records every process start. `answer(file,args)` gives the
 *  stdout; `delayMs` holds the answer back (a starved process start). */
function countingDeps(t, env, { answer = () => '', delayMs = 0 } = {}) {
  const calls = [];
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const d = {
    ...R.nodeResolverDeps(),
    env,
    exec: (file, args, opts, cb) => {
      calls.push(file);
      if (file === 'taskkill') { setImmediate(() => cb(null, 'SUCCESS')); return { pid: 2 }; }
      const out = answer(file, args);
      if (delayMs > 0) timers.push(setTimeout(() => cb(null, out), delayMs));
      else setImmediate(() => cb(null, out));
      return { pid: 4243 };
    }
  };
  return { d, calls };
}

// ─── PART A: no process start ────────────────────────────────────────────────────────

test('A1 win32: a lookup of node that is on PATH starts ZERO processes (counted at deps.exec)', { skip: !WIN && 'win32 only' }, async (t) => {
  const root = tmpRoot(t);
  const node = mk(root, 'bin\\node.exe');
  const { d, calls } = countingDeps(t, { PATH: path.join(root, 'bin'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }, { answer: () => node + '\r\n' });
  assert.deepEqual(await R.lookupCommandAsync('node', d), { path: node, found: true });
  assert.deepEqual(calls, [], `a win32 lookup must not start a process (its start is starved under the suite's CPU cap), started: ${JSON.stringify(calls)}`);
});

test('A2 win32: an exec seam that takes 4 s cannot make a lookup of an installed CLI UNKNOWN', { skip: !WIN && 'win32 only' }, async (t) => {
  const root = tmpRoot(t);
  const node = mk(root, 'bin\\node.exe');
  const { d, calls } = countingDeps(t, { PATH: path.join(root, 'bin'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }, { answer: () => node + '\r\n', delayMs: 4000 });
  const r = await R.lookupCommandAsync('node', d);
  assert.deepEqual(r, { path: node, found: true }, `node is on PATH; a slow process start must not decide the answer (got ${JSON.stringify(r)}, process starts ${JSON.stringify(calls)})`);
});

// ─── PART B: parity with where.exe ───────────────────────────────────────────────────

const CHILD = [
  "const [repo, name] = process.argv.slice(1);",
  "const R = require(repo + '/test/load-ts.cjs')('src/main/commandResolver.ts');",
  "R.lookupCommandAsync(name).then((r) => process.stdout.write(JSON.stringify(r)));"
].join('\n');

const run = (file, args, opts) => new Promise((res) => execFile(file, args, { windowsHide: true, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })));

/** The env both sides see: the fixture PATH, System32 LAST (the old path starts `where` by name), and
 *  the install-dir candidates (APPDATA, LOCALAPPDATA, USERPROFILE) pointed at an empty dir. */
function fixtureEnv(root, pathEntries, pathext) {
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  return {
    PATH: [...pathEntries, SYS32].join(';'), PATHEXT: pathext,
    SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    APPDATA: empty, LOCALAPPDATA: empty, USERPROFILE: empty, HOME: empty
  };
}

/** Today's answer: where.exe's lines, the first one with a PATHEXT extension that existsSync accepts. */
async function whereAnswer(name, env, cwd) {
  const w = await run(path.join(SYS32, 'where.exe'), [name], { env, cwd });
  if (w.code !== 0 && w.code !== 1) throw new Error(`where.exe failed (${w.code}): ${w.stderr}`);
  const exts = env.PATHEXT.split(';').map((e) => e.trim().toUpperCase()).filter(Boolean);
  const lines = w.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((p) => {
    // commandResolver.ts isExecutable, verbatim: an extension on the basename, listed in PATHEXT.
    const dot = p.lastIndexOf('.');
    const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return dot > sep && exts.includes(p.slice(dot).toUpperCase()) && fs.existsSync(p);
  });
  return { lines, pick: pick ?? null };
}

async function resolverAnswer(name, env, cwd) {
  const c = await run(process.execPath, ['-e', CHILD, REPO, name], { env, cwd });
  assert.equal(c.code, 0, `resolver child failed: ${c.stderr}`);
  return JSON.parse(c.stdout);
}

/** expectRel: the pick where.exe gives, hard-coded (relative to root; null = a plain miss), so a
 *  fixture slip that makes both sides miss cannot pass. undefined = the oracle only (B4). */
async function parity(t, root, name, pathEntries, pathext, expectRel) {
  const env = fixtureEnv(root, pathEntries, pathext);
  const cwd = path.join(root, 'empty');
  const w = await whereAnswer(name, env, cwd);
  const r = await resolverAnswer(name, env, cwd);
  if (expectRel !== undefined) assert.equal(w.pick, expectRel === null ? null : path.join(root, expectRel), `fixture: where.exe's pick for ${name} (PATHEXT ${pathext}), it listed ${JSON.stringify(w.lines)}`);
  const want = w.pick ? { path: w.pick, found: true } : { path: name, found: false };
  assert.deepEqual(r, want, `${name} with PATH ${JSON.stringify(pathEntries)} PATHEXT ${pathext}: where.exe listed ${JSON.stringify(w.lines)}`);
  return w;
}

test('B1 parity: PATHEXT order and case, an extensionless shim first, an upper-case file name', { skip: !WIN && 'win32 only' }, async (t) => {
  const root = tmpRoot(t);
  for (const f of ['e1\\rgfy', 'e1\\rgfy.cmd', 'e1\\rgfy.exe', 'e2\\RGFW.EXE']) mk(root, f);
  const e1 = path.join(root, 'e1');
  await parity(t, root, 'rgfy', [e1], '.CMD;.EXE', 'e1\\rgfy.cmd');
  await parity(t, root, 'rgfy', [e1], '.exe;.cmd', 'e1\\rgfy.cmd'); // name order, not PATHEXT order
  await parity(t, root, 'rgfy', [e1], '.EXE', 'e1\\rgfy.exe');
  await parity(t, root, 'rgfw', [path.join(root, 'e2')], '.COM;.EXE;.BAT;.CMD', 'e2\\RGFW.EXE');
});

test('B2 parity: quoted, empty and trailing-backslash PATH entries; a name with an extension', { skip: !WIN && 'win32 only' }, async (t) => {
  const root = tmpRoot(t);
  mk(root, 'sp ace\\rgfz.CMD');
  mk(root, 'e1\\rgfy.cmd'); mk(root, 'e1\\rgfy.exe');
  const sp = path.join(root, 'sp ace');
  await parity(t, root, 'rgfz', [`"${sp}"`], '.EXE;.CMD', null); // where does not search a quoted entry
  await parity(t, root, 'rgfz', ['', '', sp + '\\', ''], '.EXE;.CMD', 'sp ace\\rgfz.CMD');
  await parity(t, root, 'rgfy.cmd', [path.join(root, 'e1')], '.EXE;.CMD', 'e1\\rgfy.cmd');
});

test('B3 parity: a missing dir and a FILE as PATH entries are skipped; a DIRECTORY named rgfx.exe is not a hit; no hit is a plain miss', { skip: !WIN && 'win32 only' }, async (t) => {
  const root = tmpRoot(t);
  mk(root, 'd1\\rgfx.exe', { dir: true });
  mk(root, 'd2\\rgfx.exe');
  const asFile = mk(root, 'f\\notadir');
  await parity(t, root, 'rgfx', [path.join(root, 'nope'), asFile, path.join(root, 'd1'), path.join(root, 'd2')], '.EXE', 'd2\\rgfx.exe');
  await parity(t, root, 'rgfnone', [path.join(root, 'd1'), path.join(root, 'd2')], '.EXE', null);
});

test('B5 cwd-first is DROPPED (stated decision): a hit only in the cwd is not found; a PATH hit beats a cwd hit', { skip: !WIN && 'win32 only' }, async (t) => {
  // where.exe searches the current dir before PATH. The app's resolver must not resolve a CLI from
  // whatever dir main happens to run in, so this is the one case that deliberately is NOT parity.
  const root = tmpRoot(t);
  const cwd = path.join(root, 'cwd');
  mk(root, 'cwd\\rgfc.exe');
  const onPath = mk(root, 'p\\rgfc.exe');
  const empty = path.join(root, 'p0');
  fs.mkdirSync(empty, { recursive: true });
  const onlyCwd = fixtureEnv(root, [empty], '.EXE');
  const w = await run(path.join(SYS32, 'where.exe'), ['rgfc'], { env: onlyCwd, cwd });
  assert.match(w.stdout, /rgfc\.exe/i, `fixture: where.exe must list the cwd hit (cwd-first), got ${JSON.stringify(w.stdout)}`);
  assert.deepEqual(await resolverAnswer('rgfc', onlyCwd, cwd), { path: 'rgfc', found: false }, 'a hit only in the cwd must not resolve');
  const both = fixtureEnv(root, [path.join(root, 'p')], '.EXE');
  assert.deepEqual(await resolverAnswer('rgfc', both, cwd), { path: onPath, found: true }, 'the PATH hit must win over the cwd hit');
});

test('B4 parity: App Execution Aliases in WindowsApps (listed by where, existsSync false today)', { skip: !WIN && 'win32 only' }, async (t) => {
  const wa = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps');
  let names = [];
  try { names = fs.readdirSync(wa).filter((n) => /^(winget|python|python3)\.exe$/i.test(n)); } catch { /* no dir */ }
  if (names.length === 0) { t.skip(`no winget/python alias in ${wa} on this box`); return; }
  const root = tmpRoot(t);
  for (const n of names) {
    const w = await parity(t, root, n.slice(0, -4), [wa], '.COM;.EXE;.BAT;.CMD');
    assert.ok(w.lines.length > 0, `where.exe must list the alias ${n} (else this case pins nothing)`);
  }
});
