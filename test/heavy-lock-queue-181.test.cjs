'use strict';

/**
 * HEAVY-LOCK-SELF-WAIT (1.1.81), with HEAVY-LOCK-MISSED-RUNS-177 (the env `$(...)` escape) and
 * HEAVY-LOCK-SCRIPT-WRAPPER folded in (the same file and classifier).
 *
 * The lock was deny-only: "run it later", never WHEN. Agents wrote pollers; a poller in the same call
 * as a suite waited on that call's own slot (Jim, 2026-10-02 20:31Z, 10 min, orphan-kept). Now:
 *   - a denied agent is QUEUED once, FIFO, and told so;
 *   - a freed slot is RESERVED for the oldest live waiter (5 min) and it is NOTIFIED;
 *     nobody else may take it meanwhile; an unused reservation passes on;
 *   - fleet.json shows the queue.
 * And the classifier sees `env $(...) node test/tools/run-tests.cjs` and a suite in `bash suite.sh`.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const H = { heavy: true, kind: 'suite' };

function rig(M = HJ, limit = 1, extra = {}) {
  let now = 1_000_000; let lim = limit; const logs = []; const notes = []; const gone = new Set();
  const l = new M.HeavyJobLock({
    limit: () => lim, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), alive: (a) => !gone.has(a), ...extra
  });
  return { l, logs, notes, gone, tick: (ms) => { now += ms; }, setLimit: (v) => { lim = v; }, now: () => now };
}

const K = {};

// ─── the queue ───────────────────────────────────────────────────────────────────────────────

K.fifoReserveNotify = (M = HJ) => {
  const x = rig(M);
  assert.equal(x.l.acquire('a', H, 'node test/tools/run-tests.cjs', 'a1', false).allow, true);
  const db = x.l.acquire('b', H, 'npm ci', 'b1', false);
  const dc = x.l.acquire('c', H, 'npm run build', 'c1', false);
  assert.match(db.reason, /You are QUEUED \(position 1\)/);
  assert.match(dc.reason, /You are QUEUED \(position 2\)/);
  assert.match(x.l.acquire('b', H, 'npm ci', 'b2', false).reason, /position 1\)/, 'QUEUED ONCE: A RETRY KEEPS ITS PLACE');
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => [w.agentId, w.position]), [['b', 1], ['c', 2]], 'QUEUED ONCE: A RETRY KEEPS ITS PLACE');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'THE OLDEST WAITER IS RESERVED AND NOTIFIED');
  assert.equal(x.notes[0].until, x.now() + M.HEAVY_RESERVE_MS);
  const d = x.l.acquire('c', H, 'npm run build', 'c2', false);
  assert.equal(d.allow, false, 'NOBODY ELSE TAKES A RESERVED SLOT');
  assert.match(d.reason, /no job is running \(reserved for b until \d\d:\d\d:\d\dZ\)/);
  assert.deepEqual(x.l.acquire('b', H, 'npm ci', 'b3', false), { allow: true, acquired: true }, 'THE RESERVED AGENT TAKES ITS SLOT');
  assert.equal(x.logs.find((r) => r.action === 'acquire' && r.agentId === 'b').reserved, true);
  x.l.callDone('b', 'b3');
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c'], 'THEN THE NEXT WAITER');
};
test('FIFO: denied agents are queued once; a freed slot is reserved for the oldest and it is told; others are kept out', () => K.fifoReserveNotify());

K.reservationExpires = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.l.callDone('a', 'a1');
  x.tick(M.HEAVY_RESERVE_MS - 1);
  assert.equal(x.l.acquire('c', H, 'npm ci', 'c2', false).allow, false, 'still b\'s');
  x.tick(1);
  assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => r.agentId), ['c'], 'AN UNUSED RESERVATION PASSES ON');
  assert.ok(x.logs.some((r) => r.action === 'reserve-expired' && r.agentId === 'b'));
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c']);
};
test('an unused reservation expires after 5 min and passes to the next waiter', () => K.reservationExpires());

K.goneWaiterSkipped = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.gone.add('b');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.notes.map((n) => n.a), ['c'], 'A GONE WAITER IS SKIPPED');
  assert.ok(x.logs.some((r) => r.action === 'queue-dropped' && r.agentId === 'b'));
};
test('a waiter whose PTY is gone is skipped', () => K.goneWaiterSkipped());

test('a reserved agent whose PTY exits drops its reservation; the next waiter gets the slot', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.l.callDone('a', 'a1');
  x.l.agentGone('b');
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c']);
  assert.ok(x.logs.some((r) => r.action === 'reserve-dropped' && r.agentId === 'b'));
  x.l.agentGone('c');
  assert.deepEqual(x.l.queueSnapshot(), { waiters: [], reserved: [] });
});

test('a raised limit serves the queue before a newcomer; Off keeps no queue', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.setLimit(2);
  assert.equal(x.l.acquire('n', H, 'npm ci', 'n1', false).allow, false, 'the free slot went to b first');
  assert.deepEqual(x.notes.map((n) => n.a), ['b']);
  x.setLimit('off');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.l.queueSnapshot(), { waiters: [], reserved: [] });
});

test('the re-entrant holder is unchanged, and a holder is never queued', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  assert.deepEqual(x.l.acquire('a', H, 'npm run build', 'a2', false), { allow: true, acquired: false });
  assert.deepEqual(x.l.queueSnapshot().waiters, []);
});

test('the deny text: queued, told, and no polling (the old "run it later" is gone)', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  const d = x.l.acquire('b', H, 'npm ci', 'b1', false);
  assert.doesNotMatch(d.reason, /run it later/);
  assert.match(d.reason, /do not poll for the slot/);
  assert.equal(x.logs.find((r) => r.action === 'deny').position, 1);
});

// ─── the classifier escapes ──────────────────────────────────────────────────────────────────

K.envSubstitution = (M = HJ) => {
  assert.equal(M.classifyCommand('env $(echo -u X) node test/tools/run-tests.cjs').heavy, true, 'ENV $(...) OPTIONS DO NOT HIDE THE SUITE');
  assert.equal(M.classifyCommand("env $(env | grep -oE '^HIVE_[A-Z_]*' | sed 's/^/-u /') HOME=/tmp node test/tools/run-tests.cjs").kind, 'suite');
  assert.equal(M.classifyCommand('env $(echo -u X) node test/one.test.cjs').heavy, false, 'still light for one file');
};
test('MISSED-RUNS (3rd escape): `env $(...) node test/tools/run-tests.cjs` is a suite', () => K.envSubstitution());

function scripts(files) {
  return { readScript: (p, cd) => files[cd ? `${cd}|${p}` : p] ?? null };
}

K.scriptWrapper = (M = HJ) => {
  const ctx = scripts({ 'suite.sh': '#!/bin/bash\nset -e\nfor v in $(env | grep -oE x); do unset $v; done\nnode test/tools/run-tests.cjs > log 2>&1\n', 'light.sh': 'echo hi\nnode test/one.test.cjs\n', './gate.sh': 'npm ci\n' });
  const c = M.classifyCommand('bash suite.sh', 0, ctx);
  assert.equal(c.heavy, true, 'A SUITE IN A SCRIPT FILE IS SEEN');
  assert.match(c.why, /\(in suite\.sh\)$/);
  assert.equal(M.classifyCommand('sh -x ./gate.sh', 0, ctx).kind, 'install');
  assert.equal(M.classifyCommand('./gate.sh', 0, ctx).kind, 'install', 'a script run directly');
  assert.equal(M.classifyCommand('bash light.sh', 0, ctx).heavy, false);
  assert.equal(M.classifyCommand('bash missing.sh', 0, ctx).heavy, false, 'unreadable: not heavy');
  assert.equal(M.classifyCommand('bash suite.sh').heavy, false, 'no reader: the pure default is unchanged');
  assert.equal(M.classifyHeavy('Bash', { command: 'bash suite.sh' }, ctx).heavy, true);
};
test('SCRIPT-WRAPPER: `bash suite.sh`, `sh -x ./gate.sh` and `./gate.sh` are classified by the script\'s text', () => K.scriptWrapper());

K.cdFollowed = (M = HJ) => {
  const ctx = scripts({ 'C:/Dunder/_work/x|suite.sh': 'node test/tools/run-tests.cjs\n' });
  assert.equal(M.classifyCommand('cd C:/Dunder/_work/x && bash suite.sh', 0, ctx).heavy, true, 'CD IS FOLLOWED');
  assert.equal(M.classifyCommand('bash suite.sh', 0, ctx).heavy, false);
};
test('`cd X && bash suite.sh` reads X/suite.sh', () => K.cdFollowed());

test('scriptReaderFor: resolves against the cwd and an earlier cd, refuses $-paths, caps the size', () => {
  const seen = [];
  const files = { 'C:/w/suite.sh': 'A', 'C:/w/sub/s.sh': 'B', 'D:/abs/t.sh': 'C', 'C:/w/big.sh': 'x'.repeat(HJ.HEAVY_SCRIPT_MAX_BYTES + 1) };
  const ctx = HJ.scriptReaderFor('C:/w/', (abs) => { seen.push(abs); const t = files[abs]; return t === undefined ? null : { size: t.length, text: () => t }; });
  assert.equal(ctx.readScript('suite.sh'), 'A');
  assert.equal(ctx.readScript('s.sh', 'sub'), 'B');
  assert.equal(ctx.readScript('t.sh', 'D:/abs'), 'C');
  assert.equal(ctx.readScript('"suite.sh"'), 'A');
  assert.equal(ctx.readScript('$HOME/x.sh'), null);
  assert.equal(ctx.readScript('x.sh', '~/y'), null);
  assert.equal(ctx.readScript('big.sh'), null, 'over the cap: not read');
});

test('the hook reader: a real file in a temp dir, by a Git Bash /x/ path too; a directory is not a script', () => {
  const HS = loadTs('src/main/hooks.ts').HookServer;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl181-'));
  try {
    fs.writeFileSync(path.join(dir, 'suite.sh'), 'node test/tools/run-tests.cjs\n');
    const ctx = HS.heavyScriptCtx(dir);
    assert.match(ctx.readScript('suite.sh'), /run-tests/);
    if (process.platform === 'win32') {
      const posix = '/' + dir[0].toLowerCase() + dir.slice(2).replace(/\\/g, '/');
      assert.match(HS.heavyScriptCtx(null).readScript(`${posix}/suite.sh`), /run-tests/);
    }
    assert.equal(ctx.readScript('.'), null);
    assert.equal(HS.heavyScriptCtx(dir).readScript('nope.sh'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── the wiring ──────────────────────────────────────────────────────────────────────────────

K.wiring = (idx = readSource('src/main/index.ts'), hooks = readSource('src/main/hooks.ts')) => {
  assert.match(idx, /alive: \(agentId\) => \[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\),\n  notify: \(agentId, kind, until\) => notifyHeavySlotFree\(agentId, kind, until\)\n\}\);/);
  assert.match(idx, /hive\.send\(\{ to: agentId, act: 'inform', requires_reply: false, subject, body, wake: 'now' \} as Partial<HiveMessage>, 'system'\);/, 'THE NOTICE WAKES (SYSTEM SENDER + WAKE NOW)');
  assert.match(idx, /control\.steer\(agentId, `\$\{subject\}\.`\);/, 'AND REACHES A BUSY AGENT');
  assert.match(idx, /const subject = `HEAVY SLOT FREE: the \$\{kind\} you were denied can run now; the slot is reserved for you until \$\{at\}`;/);
  assert.match(hooks, /const scripts = HookServer\.heavyScriptCtx\(p\.cwd\);\n      let cls = classifyHeavy\(p\.tool_name, p\.tool_input, scripts\);/, 'THE HOOK READS SCRIPTS AT PRETOOLUSE');
  assert.match(hooks, /const k = classifyCommand\(c, 0, scripts\);/);
  assert.match(hooks, /classifyHeavy\(p\.tool_name, p\.tool_input, HookServer\.heavyScriptCtx\(p\.cwd\)\)\.heavy\) \{/, 'AND THE SAME AT POSTTOOLUSE, SO THE SLOT IS FREED');
};
test('wiring: the notice on both rails (wake-proof mail + steer); the hook classifies scripts at Pre and Post', () => K.wiring());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const HJF = 'src/main/heavyJob.ts';
const MUTANTS = [
  { name: 'others may take a reserved slot', file: HJF, module: true,
    edits: [['if (!reserved && this.holders.size + this.reservations.size >= limit) {', 'if (!reserved && this.holders.size >= limit) {']],
    killer: 'fifoReserveNotify', dies: /NOBODY ELSE TAKES A RESERVED SLOT/ },
  { name: 'LIFO instead of FIFO', file: HJF, module: true,
    edits: [['const w = this.waiters.shift()!;', 'const w = this.waiters.pop()!;']],
    killer: 'fifoReserveNotify', dies: /THE OLDEST WAITER IS RESERVED AND NOTIFIED/ },
  { name: 'the reserved agent is never told', file: HJF, module: true,
    edits: [['      try { this.d.notify?.(w.agentId, w.kind, until); } catch { /* best effort: the reservation stands */ }\n', '']],
    killer: 'fifoReserveNotify', dies: /THE OLDEST WAITER IS RESERVED AND NOTIFIED/ },
  { name: 'a retry queues the agent again', file: HJF, module: true,
    edits: [['    if (i >= 0) return i + 1;\n    this.waiters.push', '    this.waiters.push']],
    killer: 'fifoReserveNotify', dies: /QUEUED ONCE: A RETRY KEEPS ITS PLACE/ },
  { name: 'a reservation never expires', file: HJF, module: true,
    edits: [['      if (t < r.until) continue;', '      if (t < r.until || r.until > 0) continue;']],
    killer: 'reservationExpires', dies: /AN UNUSED RESERVATION PASSES ON/ },
  { name: 'a gone waiter is reserved anyway', file: HJF, module: true,
    edits: [["      if (this.d.alive && !this.d.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' }); continue; }\n", '']],
    killer: 'goneWaiterSkipped', dies: /A GONE WAITER IS SKIPPED/ },
  { name: 'env $(...) ends the option run (as 1.1.80)', file: HJF, module: true,
    edits: [["(ws[i].startsWith('-') || ws[i].startsWith('$(') || /^", "(ws[i].startsWith('-') || /^"]],
    killer: 'envSubstitution', dies: /ENV \$\(\.\.\.\) OPTIONS DO NOT HIDE THE SUITE/ },
  { name: 'script files are not read (as 1.1.80)', file: HJF, module: true,
    edits: [['  if (!ctx.readScript || depth >= 2) return { heavy: false };', '  if (ctx || depth >= 0) return { heavy: false };']],
    killer: 'scriptWrapper', dies: /A SUITE IN A SCRIPT FILE IS SEEN/ },
  { name: 'cd is not followed', file: HJF, module: true,
    edits: [["      here = { ...here, cd: /^([A-Za-z]:[\\\\/]|[\\\\/]|~)/.test(to) || !here.cd ? to : `${here.cd.replace(/[\\\\/]+$/, '')}/${to}` };\n", '']],
    killer: 'cdFollowed', dies: /CD IS FOLLOWED/ },
  { name: 'the notice is plain worker mail (held by READS-QUIET)', file: 'src/main/index.ts',
    edits: [["requires_reply: false, subject, body, wake: 'now' } as Partial<HiveMessage>, 'system');", "requires_reply: false, subject, body } as Partial<HiveMessage>, agentId);"]],
    killer: 'wiring', dies: /THE NOTICE WAKES \(SYSTEM SENDER \+ WAKE NOW\)/ },
  { name: 'PostToolUse classifies without the script reader (the slot is never freed)', file: 'src/main/hooks.ts', hooks: true,
    edits: [['classifyHeavy(p.tool_name, p.tool_input, HookServer.heavyScriptCtx(p.cwd)).heavy) {', 'classifyHeavy(p.tool_name, p.tool_input).heavy) {']],
    killer: 'wiring', dies: /AND THE SAME AT POSTTOOLUSE, SO THE SLOT IS FREED/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const text = mutateText(m.file, m.edits, m.name);
      const run = m.module ? () => K[m.killer](loadTs.fromText(m.file, text))
        : m.hooks ? () => K[m.killer](undefined, text)
        : () => K[m.killer](text);
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
