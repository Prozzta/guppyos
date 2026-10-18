'use strict';
/**
 * ZT-I2-CONDENSE (god f2315f): the hidden Haiku condense (reflect.ts) is retired. The same
 * deterministic rollover that runs at spawn now also runs at an agent's Stop hook when memory.md
 * is over MEMORY_STOP_ROLLOVER_BYTES, which covers god and any agent that never respawns.
 *
 * Condition (1): a note appended while the rollover replaces memory.md is never lost, whether the
 * writer goes by path (a fresh memory.md appears), holds a handle opened before the move, or writes
 * just after the new file is in place. Condition (2): a long-lived agent at 65 KB rolls over at
 * Stop, not mid-turn and not on a subagent's Stop. Invented text only; temp folders only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/main/memoryRollover.ts');
const HOOKS = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const ROOT = path.join(__dirname, '..');

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const HEAD = '# Memory - Invented (inv-x)\n\n_Append durable facts, decisions, and context below._\n';
function bigMemory(sections, perSection = 900) {
  let s = HEAD;
  for (let i = 0; i < sections; i++) s += `\n## 2026-09-${String(1 + (i % 28)).padStart(2, '0')} note ${i}\n- ${'x'.repeat(perSection)} fact-${i}\n`;
  return s;
}
/** Everything the folder holds in .md files (memory.md and the archives). */
function allText(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
function missingFacts(dir, n) {
  const all = allText(dir);
  let missing = 0;
  for (let i = 0; i < n; i++) if (!all.includes(` fact-${i}\n`)) missing++;
  return missing;
}
function leftovers(dir) {
  return fs.readdirSync(dir).filter((n) => n.includes('.rollover-') || n.endsWith('.tmp') || n.includes('.aside'));
}
function clearHooks(t) {
  t.after(() => { for (const k of Object.keys(M.rolloverTestHooks)) M.rolloverTestHooks[k] = undefined; });
}

test('ZT-I2 (1a): a note appended by path between the re-check and the replace is kept in memory.md', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  clearHooks(t);
  // The replace's first rename is the moment after the re-check: a writer lands its note right then.
  M.rolloverTestHooks.rename = (from, to) => {
    M.rolloverTestHooks.rename = undefined;
    fs.appendFileSync(file, '- WINDOW-NOTE-1\n');
    fs.renameSync(from, to);
  };
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, true, JSON.stringify(r));
  assert.match(fs.readFileSync(file, 'utf8'), /WINDOW-NOTE-1\n/, 'the note is in the new memory.md');
  assert.equal(missingFacts(dir, 90), 0);
  assert.deepEqual(leftovers(dir), []);
});

test('ZT-I2 (1b): during the replace, a held-handle write and a by-path write (a fresh memory.md) are both kept', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  clearHooks(t);
  let seen = false;
  M.rolloverTestHooks.afterAside = (f, aside) => {
    seen = true;
    fs.appendFileSync(aside, '- HELD-HANDLE-NOTE\n');   // a writer that opened memory.md before the move
    fs.appendFileSync(f, '- FRESH-FILE-NOTE\n');         // a writer by path: memory.md is created afresh
  };
  const r = M.rolloverMemory(dir);
  assert.ok(seen, 'the replace moves memory.md aside before placing the new one');
  assert.equal(r.rotated, true, JSON.stringify(r));
  const kept = fs.readFileSync(file, 'utf8');
  assert.match(kept, /HELD-HANDLE-NOTE\n/);
  assert.match(kept, /FRESH-FILE-NOTE\n/);
  assert.ok(kept.indexOf('HELD-HANDLE-NOTE') < kept.indexOf('FRESH-FILE-NOTE'), 'in the order they were written');
  assert.ok(Buffer.byteLength(kept) < M.MEMORY_ROLLOVER_BYTES, 'and memory.md is still rolled');
  assert.equal(missingFacts(dir, 90), 0);
  assert.deepEqual(leftovers(dir), []);
});

test('ZT-I2 (1c): a held-handle write that lands just after the new memory.md is placed is kept', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  clearHooks(t);
  let seen = false;
  M.rolloverTestHooks.afterPlace = (f, asides) => {
    seen = true;
    fs.appendFileSync(asides[0], '- LATE-HANDLE-NOTE\n');
  };
  const r = M.rolloverMemory(dir);
  assert.ok(seen);
  assert.equal(r.rotated, true, JSON.stringify(r));
  assert.match(fs.readFileSync(file, 'utf8'), /LATE-HANDLE-NOTE\n/);
  assert.deepEqual(leftovers(dir), []);
});

test('ZT-I2 (1d): a rewrite (not an append) during the replace is kept and the rollover abandoned', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  clearHooks(t);
  M.rolloverTestHooks.rename = (from, to) => {
    M.rolloverTestHooks.rename = undefined;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('fact-89', 'REWRITTEN-89'));
    fs.renameSync(from, to);
  };
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, false);
  assert.equal(r.raced, true, JSON.stringify(r));
  const kept = fs.readFileSync(file, 'utf8');
  assert.match(kept, /REWRITTEN-89/, 'the rewrite survives');
  assert.match(kept, /fact-0\n/, 'memory.md is the whole rewritten file');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive-')), [], 'the archive append was undone');
  assert.deepEqual(leftovers(dir), []);
});

test('ZT-I2 (1e): a held new file (antivirus EPERM on placing it) leaves memory.md as it was, plus any note written meanwhile', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  const before = fs.readFileSync(file, 'utf8');
  clearHooks(t);
  M.rolloverTestHooks.afterAside = (f) => { fs.appendFileSync(f, '- MEANWHILE-NOTE\n'); };
  M.rolloverTestHooks.link = (from, to) => {
    if (from.includes('.rollover-') && from.endsWith('.tmp')) throw Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'link' });
    fs.linkSync(from, to);
  };
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, false);
  assert.equal(r.replaceFailed, 'EPERM', JSON.stringify(r));
  assert.equal(fs.readFileSync(file, 'utf8'), `${before}- MEANWHILE-NOTE\n`);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive-')), [], 'the archive append was undone');
  assert.deepEqual(leftovers(dir), []);
});

// ─── Condition (2): the long-lived agent, rolled over at its Stop ──────────────────────────────

async function longLived(t, id, bytes) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zti2-hive-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const rows = [];
  const appendLog = hive.appendLog.bind(hive);
  hive.appendLog = (row) => { rows.push(row); appendLog(row); };
  const dir = hive.agentHome(id);
  // The agent has run for days without a respawn: its memory.md grew well past the spawn limit.
  const file = path.join(dir, 'memory.md');
  let text = fs.readFileSync(file, 'utf8');
  for (let i = 0; Buffer.byteLength(text) < bytes; i++) text += `\n## 2026-10-${String(1 + (i % 28)).padStart(2, '0')} note ${i}\n- ${'y'.repeat(900)} ll-fact-${i}\n`;
  fs.writeFileSync(file, text);
  const facts = (text.match(/ ll-fact-\d+\n/g) || []);
  const stub = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const s = new HOOKS.HookServer(stub, () => null, () => ({}), undefined, undefined, undefined, () => {});
  s.setMemoryUpkeepListener((agentId) => hive.rolloverMemoryAtStop(agentId));
  return { hive, s, dir, file, rows, facts };
}

test('ZT-I2 (2): god, never respawned, at 65 KB rolls over at its Stop; not mid-turn, not on a subagent Stop', async (t) => {
  const { s, dir, file, rows, facts } = await longLived(t, 'god', 65 * 1024);
  const size0 = fs.statSync(file).size;
  assert.ok(size0 > M.MEMORY_STOP_ROLLOVER_BYTES && size0 < 66 * 1024, `fixture is 65 KB: ${size0}`);
  await s.handle({ hook_event_name: 'PreToolUse', agent_id: 'god', tool_name: 'Bash' });
  await s.handle({ hook_event_name: 'PostToolUse', agent_id: 'god', tool_name: 'Bash' });
  assert.equal(fs.statSync(file).size, size0, 'nothing is cut mid-turn');
  await s.handle({ hook_event_name: 'Stop', agent_id: 'god', provider_agent_id: 'sub-1' });
  assert.equal(fs.statSync(file).size, size0, 'a subagent\'s Stop is not the turn end');
  await s.handle({ hook_event_name: 'Stop', agent_id: 'god' });
  const after = fs.statSync(file).size;
  assert.ok(after < M.MEMORY_ROLLOVER_BYTES, `rolled over at Stop: ${size0} -> ${after}`);
  const all = allText(dir);
  assert.equal(facts.filter((f) => !all.includes(f)).length, 0, 'every note is in memory.md or the archive');
  const row = rows.find((r) => r.kind === 'memory-rollover');
  assert.ok(row && row.agentId === 'god' && row.at === 'stop', JSON.stringify(rows));
});

test('ZT-I2 (2): under the Stop limit (63 KB) the Stop leaves memory.md alone; spawn keeps its 32 KB limit', async (t) => {
  const { s, file, rows } = await longLived(t, 'oscar', 63 * 1024);
  const size0 = fs.statSync(file).size;
  await s.handle({ hook_event_name: 'Stop', agent_id: 'oscar' });
  assert.equal(fs.statSync(file).size, size0);
  assert.equal(rows.filter((r) => String(r.kind).startsWith('memory-rollover')).length, 0);
  assert.equal(M.MEMORY_STOP_ROLLOVER_BYTES, 64 * 1024);
  assert.equal(M.MEMORY_ROLLOVER_BYTES, 32 * 1024);
});

test('ZT-I2 (2): an unknown agent id at Stop touches nothing', async (t) => {
  const { hive } = await longLived(t, 'andy', 10 * 1024);
  assert.equal(hive.rolloverMemoryAtStop('nobody'), null);
  assert.equal(hive.rolloverMemoryAtStop('../andy'), null);
});

test('ZT-I2 (1): main runs the Stop rollover through the per-agent ledger queue, so a ledger memory append never interleaves', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /hookServer\.setMemoryUpkeepListener\(\(agentId\) => \{ void ledgerQueue\(agentId, \(\) => hive\.rolloverMemoryAtStop\(agentId\)\)/);
  const at = src.indexOf('hookServer.setMemoryUpkeepListener(');
  const q = src.indexOf('const ledgerQueue = perAgentQueue()');
  assert.ok(q >= 0 && q < at, 'the same queue the ledger handler uses, defined before');
});
