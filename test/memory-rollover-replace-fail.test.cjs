'use strict';
/**
 * CL-HARNESS-ROLLOVER-RENAME-CRASH: the final replace (tmp -> memory.md) can fail and stay failed.
 * On this PC Bitdefender's CMD heuristic (CMD:Heur.BZC.PZQ.Pantera) flags some rollover tmp files and
 * holds them for quarantine, so the rename is refused with EPERM for minutes. The archive append has
 * already happened by then. A failed replace must leave things as a raced abort does: memory.md as it
 * was, the archive append undone (or the next spawn archives the same older notes twice), no tmp
 * left where it can be removed, a visible result instead of a throw, and the hive logs a row.
 * Invented text only. The failure is injected through the module's rename test hook, throwing the
 * EPERM the antivirus hold produced (measured: it stayed EPERM for 30 s and more).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/main/memoryRollover.ts');

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
/** Make the replace fail as the held file did: the rename throws EPERM. */
function failReplace(t) {
  M.rolloverTestHooks.rename = (from, to) => {
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM', syscall: 'rename' });
  };
  t.after(() => { M.rolloverTestHooks.rename = undefined; });
}

test('a failed replace returns (no throw), keeps memory.md, undoes a NEW archive, and the next rollover archives once', (t) => {
  const dir = tmp(t, 'rollfail-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  const before = fs.readFileSync(file, 'utf8');
  failReplace(t);
  let r;
  assert.doesNotThrow(() => { r = M.rolloverMemory(dir); }, 'a failed replace is a result, not a throw');
  assert.equal(r.rotated, false);
  assert.equal(r.replaceFailed, 'EPERM', `the failure code is reported: ${JSON.stringify(r)}`);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'memory.md is exactly as it was');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive-')), [], 'the new archive was undone');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.rollover-')), [], 'no tmp left behind');
  M.rolloverTestHooks.rename = undefined;
  const r2 = M.rolloverMemory(dir);
  assert.equal(r2.rotated, true, 'the next rollover (next spawn) succeeds');
  const arch = fs.readFileSync(r2.archive, 'utf8');
  assert.equal(arch.split('<!-- rolled ').length - 1, 1, 'one rolled block, not two');
  assert.equal(arch.split('fact-0\n').length - 1, 1, 'fact-0 archived once');
});

test('a failed replace restores an EXISTING archive to its previous bytes', (t) => {
  const dir = tmp(t, 'rollfail-');
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const archive = path.join(dir, 'memory-archive-2026-09-27.md');
  fs.writeFileSync(archive, '# Memory archive - earlier\n\ninvented older notes\n');
  const before = fs.readFileSync(archive, 'utf8');
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  failReplace(t);
  const r = M.rolloverMemory(dir, now);
  assert.equal(r.rotated, false);
  assert.ok(r.replaceFailed);
  assert.equal(fs.readFileSync(archive, 'utf8'), before);
});

/** Every invented fact-<i> of bigMemory(n) is in memory.md or an archive: count the missing ones. */
function missingFacts(dir, n) {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  let missing = 0;
  for (let i = 0; i < n; i++) if (!all.includes(` fact-${i}\n`)) missing++;
  return missing;
}

test('Andy M1: when another rollover appended to the archive since ours, a failed replace leaves the archive (no note lost) and says so', (t) => {
  const dir = tmp(t, 'rollfail-');
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  // A's replace fails; inside it, B (another process on the same dir) rolls the same memory.md over successfully.
  let inner = null;
  M.rolloverTestHooks.rename = () => {
    M.rolloverTestHooks.rename = undefined;
    inner = M.rolloverMemory(dir);
    throw Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'rename' });
  };
  t.after(() => { M.rolloverTestHooks.rename = undefined; });
  const a = M.rolloverMemory(dir);
  assert.equal(inner.rotated, true, 'B rolled over');
  assert.equal(a.replaceFailed, 'EPERM');
  assert.equal(a.undoFailed, 'archive-changed', 'A did not truncate B\'s append');
  assert.equal(missingFacts(dir, 90), 0, 'no note is lost (a duplicate is safe, a loss is not)');
});

test('Andy S1: a failed tmp WRITE is undone and reported like a failed replace', (t) => {
  const dir = tmp(t, 'rollfail-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.rollover-${process.pid}.tmp`); // a directory where the tmp file goes: the write fails
  let r;
  assert.doesNotThrow(() => { r = M.rolloverMemory(dir); });
  assert.equal(r.rotated, false);
  assert.ok(r.replaceFailed && r.replaceFailed !== 'undefined', JSON.stringify(r));
  assert.equal(r.undoFailed, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive-')), [], 'the new archive was undone');
});

test('Andy S2: a failed (partial) archive APPEND is undone back to the archive\'s previous bytes, not thrown', (t) => {
  const dir = tmp(t, 'rollfail-');
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const archive = path.join(dir, 'memory-archive-2026-09-27.md');
  fs.writeFileSync(archive, '# Memory archive - earlier\n\ninvented older notes\n');
  const archiveBefore = fs.readFileSync(archive, 'utf8');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  const before = fs.readFileSync(file, 'utf8');
  M.rolloverTestHooks.append = (f, data, enc) => {
    fs.appendFileSync(f, data.slice(0, Math.floor(data.length / 2)), enc); // half of it lands, then the disk is full
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', syscall: 'write' });
  };
  t.after(() => { M.rolloverTestHooks.append = undefined; });
  let r;
  assert.doesNotThrow(() => { r = M.rolloverMemory(dir, now); });
  assert.equal(r.replaceFailed, 'ENOSPC');
  assert.equal(r.undoFailed, undefined);
  assert.equal(fs.readFileSync(archive, 'utf8'), archiveBefore, 'the partial append is gone');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('Andy S3: an undo that cannot be done is reported (undoFailed), not silent', (t) => {
  const dir = tmp(t, 'rollfail-');
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const archive = path.join(dir, 'memory-archive-2026-09-27.md');
  fs.writeFileSync(archive, '# Memory archive - earlier\n\ninvented older notes\n');
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  M.rolloverTestHooks.rename = () => {
    fs.chmodSync(archive, 0o444); // the archive can no longer be truncated back
    throw Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'rename' });
  };
  t.after(() => { M.rolloverTestHooks.rename = undefined; try { fs.chmodSync(archive, 0o644); } catch { /* gone */ } });
  const r = M.rolloverMemory(dir, now);
  assert.equal(r.replaceFailed, 'EPERM');
  assert.ok(r.undoFailed && r.undoFailed !== 'archive-changed', `the undo's own error is reported: ${JSON.stringify(r)}`);
});

test('the hive logs a failed replace (and a failed undo) as a row, not only a console warning', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(src, /else if \(r\.replaceFailed\) this\.appendLog\(\{ kind: 'memory-rollover-failed', agentId: meta\.id, bytesBefore: r\.bytesBefore, code: r\.replaceFailed, \.\.\.\(r\.undoFailed \? \{ undoFailed: r\.undoFailed \} : \{\}\) \}\)/);
  assert.match(src, /else if \(r\.raced\) this\.appendLog\(\{ kind: 'memory-rollover-raced', agentId: meta\.id, bytesBefore: r\.bytesBefore, \.\.\.\(r\.undoFailed \? \{ undoFailed: r\.undoFailed \} : \{\}\) \}\)/);
});
