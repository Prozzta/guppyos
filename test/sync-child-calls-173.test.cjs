'use strict';
/**
 * SYNC-CHILD-CALLS (1.1.73): no user-triggerable main-process path runs a SYNCHRONOUS child
 * process. The main thread must never block on one (SYNC-KILLALL-WHY.md: killAll's per-terminal
 * spawnSync taskkill froze every window ~110-290 ms PER SESSION, up to 10 s each).
 *
 * 1. THE SYNC-CHILD CENSUS: a parsed (TypeScript AST) walk of src/main + src/preload, .ts AND
 *    .cjs/.js. It fails on any use of a synchronous child_process API (spawnSync / execSync /
 *    execFileSync) however it is reached - a property access (`cp.spawnSync`,
 *    `require('node:child_process').execFileSync`), a named import, a destructured require, a
 *    computed name on a child_process namespace, a namespace used as a bare value (alias, pass),
 *    or node's internal `spawn_sync` binding - unless the file is on SYNC_CHILD_ALLOWLIST with a
 *    written reason. The allowlist is EMPTY: no such call is left in main.
 *    KNOWN LIMIT, stated: a sync API reached through something the census cannot name (e.g. a
 *    helper module outside src/main/src/preload that main imports) is invisible to it.
 * 2. Mutants: the census kills a spawnSync in a scratch copy, in every spelling above.
 * 3. Wiring: reset and changeHome await killAllAsync; the synchronous killAll/hardKillTree are gone.
 * 4. The shared async resolver (commandResolver.ts): hit, miss cached, miss re-checked after the
 *    TTL, invalidate, concurrent callers share one lookup; the platform lookups themselves.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tsc = require('typescript');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ─── 1. THE SYNC-CHILD CENSUS ──────────────────────────────────────────────────────────

const SYNC_APIS = new Set(['spawnSync', 'execSync', 'execFileSync']);
const CHILD_MODULES = new Set(['child_process', 'node:child_process']);

/** file -> { api -> { count, reason } }. Every entry must say why the call can never block the
 *  main thread on a user action (a worker only, build time only, ...). Minimal by rule: EMPTY. */
const SYNC_CHILD_ALLOWLIST = {};

function walkSrc(rel) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
    const child = `${rel}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walkSrc(child));
    else if (/\.(ts|tsx|cjs|mjs|js)$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(child);
  }
  return out;
}

function kindOf(file) {
  if (file.endsWith('.tsx')) return tsc.ScriptKind.TSX;
  if (file.endsWith('.ts')) return tsc.ScriptKind.TS;
  return tsc.ScriptKind.JS;
}

const isChildModule = (n) => !!n && tsc.isStringLiteralLike(n) && CHILD_MODULES.has(n.text);
const isRequireOfChild = (n) => !!n && tsc.isCallExpression(n) && tsc.isIdentifier(n.expression)
  && n.expression.text === 'require' && isChildModule(n.arguments[0]);

/** Every sync-child use in one file: [{ api, line, text }]. */
function scanFile(file, text) {
  const sf = tsc.createSourceFile(file, text, tsc.ScriptTarget.ES2022, true, kindOf(file));
  const hits = [];
  const hit = (api, node) => hits.push({ api, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).slice(0, 120) });
  // Pass 1: the names a child_process NAMESPACE is bound to (import * as cp / import cp /
  // const cp = require('child_process')).
  const namespaces = new Set();
  const collect = (node) => {
    if (tsc.isImportDeclaration(node) && isChildModule(node.moduleSpecifier) && node.importClause) {
      const c = node.importClause;
      if (c.name) namespaces.add(c.name.text);
      if (c.namedBindings && tsc.isNamespaceImport(c.namedBindings)) namespaces.add(c.namedBindings.name.text);
    }
    if (tsc.isVariableDeclaration(node) && tsc.isIdentifier(node.name) && isRequireOfChild(node.initializer)) namespaces.add(node.name.text);
    tsc.forEachChild(node, collect);
  };
  collect(sf);
  // Pass 2: the uses.
  const visit = (node) => {
    // `x.spawnSync` on anything (the names are child_process's alone).
    if (tsc.isPropertyAccessExpression(node) && SYNC_APIS.has(node.name.text)) hit(node.name.text, node);
    // `x['spawnSync']`
    if (tsc.isElementAccessExpression(node) && tsc.isStringLiteralLike(node.argumentExpression) && SYNC_APIS.has(node.argumentExpression.text)) hit(node.argumentExpression.text, node);
    // `import { spawnSync [as y] } from 'child_process'`
    if (tsc.isImportSpecifier(node) && SYNC_APIS.has((node.propertyName ?? node.name).text)) hit((node.propertyName ?? node.name).text, node);
    // `const { spawnSync [: y] } = <anything>` (a destructured require, or a namespace)
    if (tsc.isBindingElement(node) && tsc.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if ((tsc.isIdentifier(key) || tsc.isStringLiteralLike(key)) && SYNC_APIS.has(key.text)) hit(key.text, node);
    }
    // node's internal binding behind spawnSync
    if (tsc.isStringLiteralLike(node) && node.text === 'spawn_sync') hit('spawn_sync', node);
    // A child_process namespace used as anything but `ns.<name>` (computed name, alias, passed
    // along) is invisible to a census of names: refused outright.
    if (tsc.isIdentifier(node) && namespaces.has(node.text)) {
      const p = node.parent;
      const declared = (tsc.isVariableDeclaration(p) && p.name === node) || tsc.isImportClause(p) || tsc.isNamespaceImport(p);
      const namedAccess = (tsc.isPropertyAccessExpression(p) && p.expression === node)
        || (tsc.isElementAccessExpression(p) && p.expression === node && tsc.isStringLiteralLike(p.argumentExpression));
      if (!declared && !namedAccess) hit('namespace-as-value', p);
    }
    // `require('child_process')[...]` with a computed name
    if (tsc.isElementAccessExpression(node) && isRequireOfChild(node.expression) && !tsc.isStringLiteralLike(node.argumentExpression)) hit('computed-name', node);
    tsc.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** @param readFile (rel) => source, so a mutant can be overlaid. Asserts; returns the census. */
function syncChildCensus(readFile) {
  // src/shared too (Jim's audit CHANGE 1): main imports it, so a sync call there runs on main.
  const files = [...walkSrc('src/main'), ...walkSrc('src/preload'), ...walkSrc('src/shared')];
  assert.ok(files.includes('src/main/index.ts') && files.includes('src/main/kg-core.cjs') && files.includes('src/preload/index.ts')
    && files.includes('src/shared/modelCatalog.ts'),
    'SYNC-CHILD CENSUS: the walk reaches main, its .cjs sidecars, preload and shared');
  const found = {};
  for (const f of files) {
    for (const h of scanFile(f, readFile(f))) (found[f] ??= []).push(h);
  }
  for (const [f, hits] of Object.entries(found)) {
    const counts = {};
    for (const h of hits) counts[h.api] = (counts[h.api] ?? 0) + 1;
    for (const [api, count] of Object.entries(counts)) {
      const allowed = SYNC_CHILD_ALLOWLIST[f]?.[api];
      const where = hits.filter((h) => h.api === api).map((h) => `${f}:${h.line} \`${h.text}\``).join('; ');
      assert.ok(allowed, `SYNC-CHILD CENSUS: synchronous child process API \`${api}\` in main (${where}) - make it async, or allowlist it WITH a reason it can never block the main thread on a user action`);
      assert.equal(count, allowed.count, `SYNC-CHILD CENSUS: ${f} uses \`${api}\` ${count}x, allowlisted ${allowed.count}x (${where})`);
    }
  }
  for (const [f, apis] of Object.entries(SYNC_CHILD_ALLOWLIST)) {
    for (const [api, entry] of Object.entries(apis)) {
      assert.ok(typeof entry.reason === 'string' && entry.reason.length > 20, `SYNC-CHILD CENSUS: ${f} ${api} needs a written reason`);
      assert.ok(found[f]?.some((h) => h.api === api), `SYNC-CHILD CENSUS: stale allowance ${f} ${api} (a stale allowance is a hole waiting for a call)`);
    }
  }
  return { files, found };
}

test('SYNC-CHILD CENSUS: no synchronous child_process API anywhere in main or preload (allowlist: empty)', () => {
  const { files, found } = syncChildCensus(read);
  assert.deepEqual(found, {}, 'nothing found, nothing allowlisted');
  assert.deepEqual(SYNC_CHILD_ALLOWLIST, {}, 'the allowlist is minimal: empty');
  assert.ok(files.length > 50, `walked ${files.length} files`);
});

test('SYNC-CHILD CENSUS: the scanner sees every spelling, and ignores comments and strings', () => {
  const spellings = {
    "import { spawnSync } from 'node:child_process'; spawnSync('x');": ['spawnSync'],
    "import { execFileSync as run } from 'child_process'; run('x');": ['execFileSync'],
    "import * as cp from 'node:child_process'; cp.execSync('x');": ['execSync'],
    "import cp from 'node:child_process'; cp['spawnSync']('x');": ['spawnSync'],
    "import * as cp from 'node:child_process'; const k = 'spawn' + 'Sync'; cp[k]('x');": ['namespace-as-value'],
    "import * as cp from 'node:child_process'; const alias = cp; alias.spawn('x');": ['namespace-as-value'],
    "import * as cp from 'node:child_process'; helper(cp);": ['namespace-as-value'],
    "require('node:child_process').execFileSync('x');": ['execFileSync'],
    "const { spawnSync } = require('node:child_process');": ['spawnSync'],
    "const { execSync: sh } = require('child_process'); sh('x');": ['execSync'],
    "const cp = require('child_process'); cp.spawnSync('x');": ['spawnSync'],
    "const k = 'x'; require('child_process')[k]('y');": ['computed-name'],
    "process.binding('spawn_sync');": ['spawn_sync']
  };
  for (const [code, want] of Object.entries(spellings)) {
    for (const ext of ['ts', 'cjs']) {
      if (ext === 'cjs' && code.startsWith('import')) continue;
      assert.deepEqual(scanFile(`x.${ext}`, code).map((h) => h.api), want, `${ext}: ${code}`);
    }
  }
  const clean = [
    "// spawnSync('where') used to run here\n/* execFileSync */ const s = 'spawnSync is gone';",
    "import { spawn, execFile } from 'node:child_process'; import { existsSync, readFileSync } from 'node:fs'; spawn('x'); existsSync('y');",
    "import * as cp from 'node:child_process'; cp.spawn('x'); cp.execFile('y', [], () => {});"
  ];
  for (const code of clean) assert.deepEqual(scanFile('x.ts', code), [], code);
});

// ─── 2. Mutants: a new sync child in main dies at the census ───────────────────────────

const MUTANTS = [
  { name: 'spawnSync via a named import (the original killAll shape)', file: 'src/main/pty.ts',
    anchor: "import { ensureKilled, killTreesAsync } from './procKill';",
    add: "\nimport { spawnSync } from 'node:child_process';\nexport function rogue(): void { spawnSync('taskkill', ['/pid', '1', '/T', '/F'], { timeout: 10_000 }); }" },
  { name: 'execFileSync via require(...) (the nodeInstall shape)', file: 'src/main/nodeInstall.ts',
    anchor: "import { execFile } from 'node:child_process';",
    add: "\nexport const rogue = (p: string): string => require('node:child_process').execFileSync(p, ['--version'], { encoding: 'utf8' });" },
  { name: 'spawnSync destructured in a .cjs sidecar (the kg-core shape)', file: 'src/main/kg-core.cjs',
    anchor: "const childProcess = require('node:child_process');",
    add: "\nconst { spawnSync } = require('node:child_process');" },
  { name: 'execSync on a child_process namespace', file: 'src/main/index.ts',
    anchor: "ipcMain.handle('app:resetAll', async () => {",
    add: "\nimport * as cpNs from 'node:child_process';\nfunction rogueWhere(): string { return cpNs.execSync('where claude').toString(); }\n" },
  { name: 'a computed name on a namespace', file: 'src/main/shellEnv.ts',
    anchor: "export { isSafeCommandName };",
    add: "\nimport * as cpNs from 'node:child_process';\nexport const rogue = (): unknown => (cpNs as unknown as Record<string, (c: string) => unknown>)['spawn' + 'Sync']('where');" },
  { name: "execFileSync in src/shared (main imports it; Jim's probe E5)", file: 'src/shared/modelCatalog.ts', prepend: true,
    add: "import { execFileSync } from 'node:child_process';\nexport const rogue = (): unknown => execFileSync('where', ['x']);\n" }
];

for (const m of MUTANTS) {
  test(`SYNC-CHILD CENSUS mutant: ${m.name} in ${m.file} dies at the census`, () => {
    const real = read(m.file);
    let mutated;
    if (m.prepend) mutated = m.add + real;
    else {
      assert.equal(real.split(m.anchor).length - 1, 1, 'the mutant insertion point matches EXACTLY ONCE');
      mutated = real.replace(m.anchor, () => `${m.anchor}${m.add}`);
    }
    const overlay = (f) => (f === m.file ? mutated : read(f));
    syncChildCensus(read); // passes on the real tree...
    assert.throws(() => syncChildCensus(overlay), (e) => e instanceof assert.AssertionError && /SYNC-CHILD CENSUS/.test(e.message) && e.message.includes(m.file),
      '...and dies on the mutant, naming the file');
  });
}

test('SYNC-CHILD CENSUS mutant: an allowlisted call that disappears is a STALE allowance', () => {
  SYNC_CHILD_ALLOWLIST['src/main/pty.ts'] = { spawnSync: { count: 1, reason: 'a stale entry kept to prove the check bites' } };
  try {
    assert.throws(() => syncChildCensus(read), /stale allowance/);
  } finally {
    delete SYNC_CHILD_ALLOWLIST['src/main/pty.ts'];
  }
});

// ─── 3. Wiring: reset / changeHome / killAll ──────────────────────────────────────────

/** The body of the ipcMain.handle(<channel>, async ...) handler, parsed. */
function handlerBody(src, channel) {
  const sf = tsc.createSourceFile('index.ts', src, tsc.ScriptTarget.ES2022, true, tsc.ScriptKind.TS);
  let body = null;
  const go = (n) => {
    if (!body && tsc.isCallExpression(n) && n.expression.getText(sf) === 'ipcMain.handle'
      && tsc.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === channel) {
      const fn = n.arguments[1];
      assert.ok(fn && (tsc.isArrowFunction(fn) || tsc.isFunctionExpression(fn)), `${channel}: handler is a function`);
      assert.ok(fn.modifiers?.some((m) => m.kind === tsc.SyntaxKind.AsyncKeyword), `${channel}: handler is async`);
      body = fn.body.getText(sf);
    }
    tsc.forEachChild(n, go);
  };
  go(sf);
  assert.ok(body, `${channel} handler exists`);
  return body;
}

test('WIRING: reset awaits killAllAsync, still BEFORE hive.dispose and the rm', () => {
  const body = handlerBody(read('src/main/index.ts'), 'app:resetAll');
  const kill = body.indexOf('await ptyManager.killAllAsync()');
  assert.ok(kill > 0, 'reset awaits the async bulk kill');
  assert.ok(kill < body.indexOf('hive.dispose()'), 'kill before hive.dispose');
  assert.ok(kill < body.indexOf('rmSync(hiveDir'), 'kill before the rm');
  assert.ok(kill < body.indexOf('app.exit('), 'kill before the exit');
  assert.doesNotMatch(body, /killAll\(\)/);
});

test('WIRING: changeHome awaits killAllAsync and only THEN relaunches/exits', () => {
  const body = handlerBody(read('src/main/index.ts'), 'config:changeHome');
  const kill = body.indexOf('await ptyManager.killAllAsync()');
  assert.ok(kill > 0, 'changeHome awaits the async bulk kill');
  assert.ok(kill < body.indexOf('app.relaunch()') && kill < body.indexOf('app.exit(0)'), 'relaunch/exit after the kill resolved');
  assert.doesNotMatch(body, /killAll\(\)/);
});

test('WIRING: the synchronous killAll and hardKillTree are gone - no path can reach a sync kill', () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  assert.equal(typeof PtyManager.prototype.killAll, 'undefined', 'PtyManager.killAll is removed');
  assert.equal(typeof PtyManager.prototype.killAllAsync, 'function');
  assert.equal(loadTs('src/main/procKill.ts').hardKillTree, undefined, 'procKill.hardKillTree is removed');
  // No caller left anywhere in main (parsed: comments do not count).
  for (const f of [...walkSrc('src/main'), ...walkSrc('src/preload')]) {
    const sf = tsc.createSourceFile(f, read(f), tsc.ScriptTarget.ES2022, true, kindOf(f));
    const go = (n) => {
      if (tsc.isPropertyAccessExpression(n)) assert.ok(!['killAll', 'hardKillTree'].includes(n.name.text), `${f}: ${n.getText(sf)}`);
      if (tsc.isIdentifier(n) && n.text === 'hardKillTree') assert.fail(`${f}: hardKillTree`);
      tsc.forEachChild(n, go);
    };
    go(sf);
  }
});

test('killAllAsync (reset/changeHome shape): win32 kill is ONE async batched taskkill, then the ptys close, then it resolves', async (t) => {
  const cp = require('node:child_process');
  const realSpawn = cp.spawn, realSync = cp.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const spawns = [];
  const order = [];
  const { EventEmitter } = require('node:events');
  cp.spawn = (file, args) => { spawns.push({ file, args }); order.push('taskkill'); const p = new EventEmitter(); setTimeout(() => p.emit('close', 0), 5); return p; };
  cp.spawnSync = () => { throw new Error('spawnSync on the reset/changeHome path'); };
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; Object.defineProperty(process, 'platform', realPlatform); });
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const exits = [];
  for (const pid of [101, 102]) {
    const proc = { pid, kill: () => { order.push(`close ${pid}`); setTimeout(() => exits.forEach((e) => e.pid === pid && e.cb()), 1); }, onExit: (cb) => { exits.push({ pid, cb }); return { dispose() {} }; } };
    pm['sessions'].set(`s${pid}`, { id: `s${pid}`, proc });
  }
  const t0 = Date.now();
  await pm.killAllAsync();
  assert.deepEqual(spawns, [{ file: 'taskkill', args: ['/T', '/F', '/PID', '101', '/PID', '102'] }]);
  assert.deepEqual(order, ['taskkill', 'close 101', 'close 102'], 'the tree is swept BEFORE ConPTY closes');
  assert.equal(pm.list().length, 0);
  assert.ok(Date.now() - t0 < PtyManager.EXIT_WAIT_MS, 'resolved on the exits, not the cap');
});

// ─── 4. The shared async resolver ─────────────────────────────────────────────────────

const R = loadTs('src/main/commandResolver.ts');

function rig({ ttl = 60_000 } = {}) {
  let now = 1_000;
  const onDisk = new Set();
  const answers = new Map(); // command -> ResolvedCommand
  const lookups = [];
  let gate = null; // when set, lookups wait for it
  const r = new R.CommandResolver({
    now: () => now,
    missTtlMs: ttl,
    deps: () => ({ platform: 'win32', env: {}, exists: (p) => onDisk.has(p), exec: () => { throw new Error('no real exec'); } }),
    lookup: async (command) => {
      lookups.push(command);
      if (gate) await gate;
      return answers.get(command) ?? { path: command, found: false };
    }
  });
  return {
    r, lookups, onDisk, answers,
    advance: (ms) => { now += ms; },
    hold: () => { let open; gate = new Promise((res) => { open = res; }); return () => { gate = null; open(); }; }
  };
}

test('resolver: a HIT is cached and re-validated with exists() on every use', async () => {
  const g = rig();
  g.answers.set('claude', { path: 'C:\\npm\\claude.cmd', found: true });
  g.onDisk.add('C:\\npm\\claude.cmd');
  assert.deepEqual(await g.r.resolve('claude'), { path: 'C:\\npm\\claude.cmd', found: true });
  g.advance(10 * 60_000);
  assert.deepEqual(await g.r.resolve('claude'), { path: 'C:\\npm\\claude.cmd', found: true });
  assert.equal(g.lookups.length, 1, 'a hit that still exists is never looked up again');
  g.onDisk.delete('C:\\npm\\claude.cmd'); // uninstalled
  g.answers.set('claude', { path: 'claude', found: false });
  assert.deepEqual(await g.r.resolve('claude'), { path: 'claude', found: false });
  assert.equal(g.lookups.length, 2, 'a vanished hit is looked up again');
});

test('resolver: a MISS is cached, and re-checked once the TTL has passed', async () => {
  const g = rig({ ttl: 60_000 });
  assert.deepEqual(await g.r.resolve('agy'), { path: 'agy', found: false });
  g.advance(59_999);
  assert.deepEqual(await g.r.resolve('agy'), { path: 'agy', found: false });
  assert.equal(g.lookups.length, 1, 'a miss inside the TTL costs no child process');
  g.answers.set('agy', { path: 'C:\\agy\\bin\\agy.exe', found: true });
  g.onDisk.add('C:\\agy\\bin\\agy.exe');
  g.advance(1);
  assert.deepEqual(await g.r.resolve('agy'), { path: 'C:\\agy\\bin\\agy.exe', found: true }, 'after the TTL the install is seen');
  assert.equal(g.lookups.length, 2);
  assert.equal(R.MISS_TTL_MS, 60_000);
});

test('resolver: invalidate(name) and invalidate() drop cached answers at once', async () => {
  const g = rig();
  await g.r.resolve('codex');
  await g.r.resolve('npm');
  g.answers.set('codex', { path: 'C:\\npm\\codex.cmd', found: true });
  g.onDisk.add('C:\\npm\\codex.cmd');
  g.r.invalidate('codex');
  assert.equal((await g.r.resolve('codex')).found, true, 'the explicit invalidate beats the TTL');
  assert.equal((await g.r.resolve('npm')).found, false, 'other names keep their entry');
  assert.deepEqual(g.lookups, ['codex', 'npm', 'codex']);
  g.r.invalidate();
  await g.r.resolve('npm');
  assert.deepEqual(g.lookups, ['codex', 'npm', 'codex', 'npm'], 'invalidate() drops everything');
});

test('resolver: concurrent callers share ONE lookup; a lookup racing an invalidate is not cached', async () => {
  const g = rig();
  const open = g.hold();
  const all = [g.r.resolve('gemini'), g.r.resolve('gemini'), g.r.resolve('gemini')];
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(g.lookups, ['gemini'], 'three callers, one child process');
  open();
  const res = await Promise.all(all);
  assert.ok(res.every((x) => x.found === false && x.path === 'gemini'));

  const g2 = rig();
  const open2 = g2.hold();
  const stale = g2.r.resolve('kimi');
  g2.r.invalidate('kimi');
  g2.answers.set('kimi', { path: 'C:\\kimi.exe', found: true });
  g2.onDisk.add('C:\\kimi.exe');
  open2();
  await stale;
  assert.equal((await g2.r.resolve('kimi')).found, true, 'the pre-invalidate answer was not written back');
  assert.equal(g2.lookups.length, 2);
});

test('resolver: paths and unsafe names never start a child and are never cached', async () => {
  const g = rig();
  g.onDisk.add('C:\\tools\\x.exe');
  assert.deepEqual(await g.r.resolve('C:\\tools\\x.exe'), { path: 'C:\\tools\\x.exe', found: true });
  assert.deepEqual(await g.r.resolve('claude;calc'), { path: 'claude;calc', found: false });
  assert.deepEqual(g.lookups, []);
  const threw = new R.CommandResolver({ lookup: async () => { throw new Error('boom'); } });
  assert.deepEqual(await threw.resolve('claude'), { path: 'claude', found: false }, 'a failed lookup is a miss, never a throw');
});

/** A fake exec for the platform lookups: records the call, answers from `out`. */
function fakeDeps(platform, out, onDisk, env = {}) {
  const calls = [];
  return {
    calls,
    d: {
      platform, env, exists: (p) => onDisk.includes(p),
      exec: (file, args, opts, cb) => { calls.push({ file, args, opts }); const o = out(file, args); setImmediate(() => (o instanceof Error ? cb(o, '') : cb(null, o))); }
    }
  };
}

test('lookupCommandAsync (win32): async `where`, no shell, first PATHEXT hit (never the extensionless sh-shim)', async () => {
  const { calls, d } = fakeDeps('win32', () => 'C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n', ['C:\\npm\\claude', 'C:\\npm\\claude.cmd'], { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.deepEqual(await R.lookupCommandAsync('claude', d), { path: 'C:\\npm\\claude.cmd', found: true });
  assert.deepEqual(calls.map((c) => [c.file, c.args, c.opts.timeout, c.opts.windowsHide, c.opts.shell]), [['where', ['claude'], 0, true, undefined]],
    'win32: execFile timeout 0 - execP runs the 3 s time box itself and kills the TREE on expiry');
  const miss = fakeDeps('win32', () => Object.assign(new Error('exit 1'), { code: 1 }), ['C:\\AppData\\npm\\codex.cmd'], { APPDATA: 'C:\\AppData' });
  assert.deepEqual(await R.lookupCommandAsync('codex', miss.d), { path: 'C:\\AppData\\npm\\codex.cmd', found: true }, 'the install-dir candidates still apply');
  const none = fakeDeps('win32', () => '', [], {});
  assert.deepEqual(await R.lookupCommandAsync('nope', none.d), { path: 'nope', found: false });
});

test('lookupCommandAsync (POSIX): the fenced interactive login shell, rc-file chatter ignored', async () => {
  const { calls, d } = fakeDeps('darwin', () => 'Restored session: Mon\n__MD_SHELL_FENCE__/Users/u/.nvm/bin/claude\n__MD_SHELL_FENCE__', ['/Users/u/.nvm/bin/claude'], { SHELL: '/bin/zsh', HOME: '/Users/u' });
  assert.deepEqual(await R.lookupCommandAsync('claude', d), { path: '/Users/u/.nvm/bin/claude', found: true });
  assert.equal(calls[0].file, '/bin/zsh');
  assert.equal(calls[0].args[0], '-ilc');
  assert.match(calls[0].args[1], /which claude/);
});

test('resolveCliAsync is ONE function: providerModels re-exports the shared resolver (Jim\'s adapters unchanged)', async () => {
  const P = loadTs('src/main/providerModels.ts');
  assert.equal(P.resolveCliAsync, R.resolveCliAsync);
  const { d } = fakeDeps('win32', () => 'C:\\x\\agy\r\nC:\\x\\agy.exe\r\n', ['C:\\x\\agy', 'C:\\x\\agy.exe']);
  assert.equal(await R.resolveCliAsync(d, 'agy'), 'C:\\x\\agy.exe');
  assert.equal(await R.resolveCliAsync(d, 'Bad;Name'), null);
});

test('WIRING: every main-process resolver caller goes through the shared async resolver', () => {
  const pty = read('src/main/pty.ts');
  assert.match(pty, /resolver: Pick<CommandResolver, 'resolve'> = commandResolver;/);
  assert.match(pty, /async isCommandAvailable\(command: string\): Promise<boolean>/);
  assert.match(pty, /async spawn\(opts: SpawnOptions/);
  const idx = read('src/main/index.ts');
  assert.match(idx, /const resolvedCli = await resolveCommandAsync\(opts\.command\);/, 'codex remote');
  assert.match(idx, /ipcMain\.handle\('tools:status', async /, 'the setup catalog');
  assert.match(idx, /pendingInstallRelaunch\.delete\(id\);[\s\S]{0,400}invalidateCommandCache\(\);/, 'an installer exit drops the cached misses');
  assert.match(idx, /await ptyManager\.spawn\(opts, owner\)/);
  assert.match(read('src/main/hiddenClaude.ts'), /resolveCommandAsync\(b\)/, 'hidden claude');
  assert.doesNotMatch(read('src/main/shellEnv.ts'), /export function resolveCommand\b|captureFromLoginShell\(/, 'the sync resolver and capture are gone');
});

test('PtyManager.isCommandAvailable / commandPath go through the injectable async resolver', async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const asked = [];
  pm.resolver = { resolve: async (c) => { asked.push(c); return c === 'codex' ? { path: 'C:\\npm\\codex.cmd', found: true } : { path: c, found: false }; } };
  assert.equal(await pm.isCommandAvailable('codex'), true);
  assert.equal(await pm.isCommandAvailable('agy'), false);
  assert.equal(await pm.commandPath('codex'), 'C:\\npm\\codex.cmd');
  assert.equal(await pm.commandPath('agy'), null);
  assert.deepEqual(asked, ['codex', 'agy', 'codex', 'agy']);
});

test('ONE exec primitive: a hung `where` in the app resolver gets the MODELS-173 tree-safe time box (async taskkill /T /F)', async () => {
  const P = loadTs('src/main/providerModels.ts');
  assert.equal(P.TREE_KILL_TIMEOUT_MS, R.TREE_KILL_TIMEOUT_MS, 'providerModels re-exports the shared constant');
  const calls = [];
  const d = {
    platform: 'win32', env: {}, exists: () => false,
    exec: (file, args, opts, cb) => {
      calls.push({ file, args, timeout: opts.timeout });
      if (file === 'taskkill') { setImmediate(() => cb(null, 'SUCCESS')); return { pid: 2 }; }
      return { pid: 4242 }; // `where` hangs: never calls back
    }
  };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 3000 ? 5 : ms, ...a); // shrink the 3 s box
  let r;
  try { r = await R.lookupCommandAsync('claude', d); } finally { global.setTimeout = realSetTimeout; }
  assert.deepEqual(r, { path: 'claude', found: false, unknown: true }, 'a timed-out lookup is UNKNOWN, not a miss (RESOLVER-TIMEOUT-MISS)');
  assert.deepEqual(calls[0], { file: 'where', args: ['claude'], timeout: 0 }, 'win32: execFile timeout 0, execP times the run');
  assert.deepEqual(calls[1], { file: 'taskkill', args: ['/PID', '4242', '/T', '/F'], timeout: R.TREE_KILL_TIMEOUT_MS });
});

// ─── Jim's audit CHANGE 2: a USER-initiated check never trusts a cached miss ──────────

test('USER check: a miss cached by an earlier check is re-resolved, and the just-installed CLI is found', async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const g = rig();
  const pm = new PtyManager();
  pm.resolver = g.r;
  assert.equal(await pm.isCommandAvailable('codex'), false, 'not installed yet: a miss, now cached');
  g.answers.set('codex', { path: 'C:\npm\codex.cmd', found: true });
  g.onDisk.add('C:\npm\codex.cmd');
  g.advance(1_000);
  assert.equal(await pm.isCommandAvailable('codex'), false, 'a BACKGROUND check keeps trusting the miss inside the TTL');
  g.r.invalidate('codex'); // what the user paths do first (invalidateCommandCache(bin))
  assert.equal(await pm.isCommandAvailable('codex'), true, 'the user-initiated check sees the install at once');
  assert.deepEqual(g.lookups, ['codex', 'codex']);
});

test('WIRING: both user spawn checks drop the cached answer right before commandStatus(bin)', () => {
  // RESOLVER-TIMEOUT-MISS: the checks moved from isCommandAvailable (a boolean) to commandStatus
  // (found / missing / unknown); their handling of unknown is pinned in resolver-timeout-unknown-176.
  const idx = read('src/main/index.ts');
  assert.match(idx, /if \(bin && !opts\.noAutoInstall\) invalidateCommandCache\(bin\);[\s\S]{0,600}const binStatus = bin && !opts\.noAutoInstall \? await ptyManager\.commandStatus\(bin\) : 'found';/,
    'the agent spawn / auto-install check');
  assert.match(idx, /invalidateCommandCache\('npm'\);\r?\n\s+invalidateCommandCache\('node'\);[\s\S]{0,400}const npmStatus = await ptyManager\.commandStatus\('npm'\);/, 'and the npm/node rung check under it');
  assert.match(idx, /invalidateCommandCache\(bin\);[\s\S]{0,400}const engineStatus = await ptyManager\.commandStatus\(bin\);/, 'the engine check');
  assert.equal((idx.match(/isCommandAvailable\(/g) || []).length, 0, 'no caller keys a missing-CLI decision on the boolean any more');
  assert.equal((idx.match(/commandStatus\(/g) || []).length, 4, 'no other commandStatus caller to classify');
});

// ─── Jim's audit NIT: no pty spawn during the reset/changeHome await window ───────────

test('refuseNewSpawns: spawn refuses at once, and also when the refusal lands during its own awaits', async () => {
  const os = require('node:os');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const MSG = 'The app is resetting; agents cannot start now.';
  // Refused while the async lookup is in flight (the await window the NIT is about).
  pm.resolver = { resolve: async (c) => { pm.refuseNewSpawns(MSG); return { path: c, found: false }; } };
  assert.deepEqual(await pm.spawn({ id: 'a', cwd: os.tmpdir(), command: 'claude' }), { ok: false, error: MSG });
  const asked = [];
  pm.resolver = { resolve: async (c) => { asked.push(c); return { path: c, found: false }; } };
  assert.deepEqual(await pm.spawn({ id: 'b', cwd: os.tmpdir(), command: 'claude' }), { ok: false, error: MSG });
  assert.deepEqual(asked, [], 'once refused, nothing is even resolved');
  assert.equal(pm.list().length, 0);
});

test('WIRING: reset and changeHome refuse new spawns BEFORE the awaited kill; pty:spawn refuses up front', () => {
  const idx = read('src/main/index.ts');
  for (const ch of ['app:resetAll', 'config:changeHome']) {
    const body = handlerBody(idx, ch);
    const refuse = body.indexOf('ptyManager.refuseNewSpawns(');
    assert.ok(refuse > 0 && refuse < body.indexOf('await ptyManager.killAllAsync()'), `${ch}: refuse before the kill`);
  }
  assert.match(handlerBody(idx, 'pty:spawn'), /if \(ptyManager\.shutdownReason !== null\) return \{ ok: false, error: ptyManager\.shutdownReason \};\r?\n\s+return spawnAgentCore\(/);
});
