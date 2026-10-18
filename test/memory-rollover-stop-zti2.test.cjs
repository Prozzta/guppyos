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
/** What a rollover left that the next one must put back: .settled-<n> files are expected (Andy NIT-1),
 *  and must hold nothing past <n>. */
function leftovers(dir) {
  for (const n of fs.readdirSync(dir)) {
    const s = /^memory\.md\.rollover-\d+\.settled-(\d+)(?:-\d+)?$/.exec(n);
    if (s) assert.equal(fs.statSync(path.join(dir, n)).size, Number(s[1]), `${n}: nothing unread`);
  }
  return fs.readdirSync(dir).filter((n) => (n.includes('.rollover-') || n.endsWith('.tmp') || n.includes('.aside')) && !/\.settled-\d+(-\d+)?$/.test(n));
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

// ─── Andy's audit of febacf37: a leftover aside is never overwritten, and is put back ─────────

/** Every file in the folder, whatever its name (a note anywhere on disk is not lost). */
function allBytes(dir) {
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
function originals(text) { return (text.match(/ORIGINAL note \d+\n/g) || []).length; }
/** Andy's probe: a leftover aside with 400 ORIGINAL notes (a restore that failed half-way) and a fresh memory.md over the limit. */
function probe(t, pid = process.pid) {
  const dir = tmp(t, 'zti2-aside-');
  const file = path.join(dir, 'memory.md');
  const aside = `${file}.rollover-${pid}.aside`;
  let o = HEAD;
  for (let i = 0; i < 400; i++) o += `- ORIGINAL note ${i}\n`;
  fs.writeFileSync(aside, o);
  fs.writeFileSync(file, bigMemory(14));
  return { dir, file, aside };
}

test('Andy MUST-1 (his probe): a leftover aside is put back, never overwritten: all 400 ORIGINAL notes kept', (t) => {
  const { dir, file, aside } = probe(t);
  clearHooks(t);
  const r = M.rolloverMemory(dir, Date.now(), 8 * 1024);
  assert.equal(r.rotated, true, JSON.stringify(r));
  assert.deepEqual(r.recovered, [path.basename(aside)]);
  assert.equal(originals(allText(dir)), 400, 'every ORIGINAL note is in memory.md or an archive');
  assert.equal(missingFacts(dir, 14), 0, 'and every note of the fresh memory.md');
  const all = allText(dir);
  assert.ok(all.indexOf('ORIGINAL note 399') < all.indexOf(' fact-0\n'), 'the leftover is older: its notes come first');
  assert.deepEqual(leftovers(dir), []);
});

test('Andy MUST-1: a move never lands on an existing name, even when the leftover cannot be put back yet', (t) => {
  const { dir, file, aside } = probe(t);
  clearHooks(t);
  // Placing the leftover fails (an antivirus holds it): the recovery stops half-way.
  M.rolloverTestHooks.link = (from, to) => {
    if (from === aside && to === file) throw Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'link' });
    fs.linkSync(from, to);
  };
  const r = M.rolloverMemory(dir, Date.now(), 8 * 1024);
  assert.equal(r.recoverFailed, 'EPERM', JSON.stringify(r));
  assert.equal(originals(allBytes(dir)), 400, 'the ORIGINAL notes are still on disk (memory.md went to a NEW name, not over them)');
  assert.ok(fs.existsSync(`${aside}-2`), 'memory.md was moved to the next free name');
  M.rolloverTestHooks.link = undefined;
  const r2 = M.rolloverMemory(dir, Date.now(), 8 * 1024);
  assert.ok(r2.recovered && r2.recovered.length >= 2, JSON.stringify(r2));
  assert.equal(originals(allText(dir)) >= 400, true, 'all back in memory.md or an archive (a duplicate is safe)');
  for (let i = 0; i < 400; i++) assert.ok(allText(dir).includes(`ORIGINAL note ${i}\n`), `note ${i}`);
  assert.equal(missingFacts(dir, 14), 0);
  assert.deepEqual(leftovers(dir), []);
});

test('Andy SHOULD-1: after a restart (another pid, gone) a leftover aside with memory.md absent becomes memory.md, even under the limit', (t) => {
  const { dir, file, aside } = probe(t, 4194301);
  fs.rmSync(file);
  clearHooks(t);
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, false);
  assert.deepEqual(r.recovered, [path.basename(aside)]);
  assert.equal(originals(fs.readFileSync(file, 'utf8')), 400);
  assert.deepEqual(leftovers(dir), []);
});

test('Andy SHOULD-1: a live process\'s aside is not touched (its rollover may be running)', (t) => {
  const { dir, aside } = probe(t, process.ppid);
  const before = fs.readFileSync(aside, 'utf8');
  clearHooks(t);
  const r = M.rolloverMemory(dir, Date.now(), 8 * 1024);
  assert.equal(r.rotated, true);
  assert.equal(r.recovered, undefined);
  assert.equal(fs.readFileSync(aside, 'utf8'), before);
});

test('Andy SHOULD-1: only moved files are put back: a dead rollover\'s .tmp rewrite (a copy) and a folder are left alone', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, HEAD + '- the live notes\n');
  const stray = `${file}.rollover-4194301.tmp`;
  fs.writeFileSync(stray, HEAD + '- a half-written rewrite\n');
  const folder = `${file}.rollover-4194301.aside`;
  fs.mkdirSync(folder);
  clearHooks(t);
  const r = M.rolloverMemory(dir);
  assert.equal(r.recovered, undefined, JSON.stringify(r));
  assert.equal(r.recoverFailed, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), HEAD + '- the live notes\n', 'memory.md as it was');
  assert.ok(fs.existsSync(stray) && fs.statSync(folder).isDirectory());
});

test('Andy NIT-1: a write through an old handle after the rollover is kept: the next rollover appends it, then removes the file', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  clearHooks(t);
  let settled = null;
  M.rolloverTestHooks.afterPlace = (f, asides) => { settled = asides[0]; };
  const fd = fs.openSync(file, 'a');   // a writer that holds memory.md open across the rollover
  t.after(() => { try { fs.closeSync(fd); } catch { /* closed */ } });
  assert.equal(M.rolloverMemory(dir).rotated, true);
  const parked = fs.readdirSync(dir).filter((n) => /\.settled-\d+$/.test(n));
  assert.equal(parked.length, 1, `the replaced file waits as .settled (${settled})`);
  fs.writeSync(fd, '- LATE-THROUGH-OLD-HANDLE\n');
  fs.closeSync(fd);
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, false);
  assert.deepEqual(r.recovered, parked);
  assert.match(fs.readFileSync(file, 'utf8'), /LATE-THROUGH-OLD-HANDLE\n$/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.rollover-')), [], 'read once more, then removed');
});

test('Andy NIT-2: no hard links: the rename fallback is reported; EXDEV is no longer taken for it', (t) => {
  const dir = tmp(t, 'zti2-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  clearHooks(t);
  M.rolloverTestHooks.link = () => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP', syscall: 'link' }); };
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, true, JSON.stringify(r));
  assert.equal(r.noLink, true);
  assert.equal(missingFacts(dir, 90), 0);
  const dir2 = tmp(t, 'zti2-');
  const file2 = path.join(dir2, 'memory.md');
  fs.writeFileSync(file2, bigMemory(90));
  const before = fs.readFileSync(file2, 'utf8');
  M.rolloverTestHooks.link = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV', syscall: 'link' }); };
  const r2 = M.rolloverMemory(dir2);
  assert.equal(r2.replaceFailed, 'EXDEV', JSON.stringify(r2));
  assert.equal(r2.noLink, undefined);
  assert.equal(fs.readFileSync(file2, 'utf8'), before, 'memory.md as it was');
});

test('Andy SHOULD-1 / NIT-2 rows: the hive logs a recovery and a no-link rollover, at spawn and at Stop', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(src, /const r = rolloverMemory\(dir, Date\.now\(\), MEMORY_STOP_ROLLOVER_BYTES\);\s*this\.logRolloverSide\(id, r, 'stop'\);/);
  assert.match(src, /const r = rolloverMemory\(dir\);\s*this\.logRolloverSide\(meta\.id, r, 'spawn'\);/);
  assert.match(src, /if \(r\.recovered\?\.length \|\| r\.recoverFailed\) this\.appendLog\(\{ kind: 'memory-rollover-recovered', agentId, at, files: r\.recovered \?\? \[\]/);
  assert.match(src, /if \(r\.noLink\) this\.appendLog\(\{ kind: 'memory-rollover-nolink', agentId, at \}\);/);
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
