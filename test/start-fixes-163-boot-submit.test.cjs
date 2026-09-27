'use strict';

/**
 * START-FIXES-163 (3) — boot-submit logging only. One of the three fixes the Human approved from Jim's WHY-162.
 *
 *   (1) PHANTOM RESUME KEY. A resumed Claude emits its start-up OTel metric under a
 *       fresh process session id that has no transcript. The 30 s beat copied it into
 *       the registry as the --resume key, so a quick restart came up FRESH and lost its
 *       context (4 of 54 starts, god on 1.1.62). Now a sample id only fills an empty
 *       key or one whose transcript exists; the replaced id is kept, and a key with no
 *       transcript resumes the previous one, logging a resume-miss row either way.
 *   (2) NON-CLAUDE AGENTS NEVER READ CLAUDE TRANSCRIPTS (the Human's rule). Codex/AGY
 *       ids can never match a Claude record, yet the usage fallback parsed all 546 MB
 *       of C:/PrzEdit for each of them on the first beat of every start (~5-6 s
 *       main-process freeze). Every per-agent reader refuses unless provider is
 *       exactly 'claude'.
 *   (3) BOOT-SUBMIT LOGGING ONLY. A boot-submit row per attempt, per Enter write and
 *       for the thrown case; the renderer no longer swallows the error. The submit
 *       behaviour itself is unchanged.
 *
 * Every test that touches ~/.claude redirects HOME first and asserts it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sandboxHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sf163-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before touching ~/.claude');
  return home;
}


// ── (3) boot-submit logging only ────────────────────────────────────────────────────────

const OWN = loadTs('src/main/automaticSubmit.ts');
const { AutomaticSubmitOwner, GAP_MS } = OWN;

function claudeWorld({ enterFails = false, pickerAtEnter = false } = {}) {
  const w = { vt: 0, timers: [], seq: 0, writes: [], records: [], staged: false };
  w.deps = {
    resolvePty: () => 'pty-god',
    incarnation: () => 1,
    humanGeneration: () => 0,
    write: (_id, data) => {
      w.writes.push(data);
      if (data === '\r') return enterFails ? { ok: false, error: 'EPIPE' } : { ok: true };
      w.staged = true;
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => (pickerAtEnter && w.staged ? 'picker' : null),
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'UNKNOWN' }),
    readScreen: () => Promise.resolve(null),
    capacity: { admit: () => null, revalidate: () => ({ verdict: 'ALLOW', reason: 'x' }), confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => w.vt,
    setTimer: (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; },
    onEnterWrite: (r) => w.records.push(r)
  };
  w.owner = new AutomaticSubmitOwner(w.deps);
  w.submit = async () => {
    const p = w.owner.submit({ requestId: 'boot:god:1', agentId: 'god', admissionClass: 'BOOT_SEQUENCE', text: 'orient\nyourself' });
    let done = false; let value;
    p.then((v) => { done = true; value = v; });
    for (let i = 0; i < 2000; i += 1) {
      await new Promise((r) => setImmediate(r));
      if (done) return value;
      if (!w.timers.length) throw new Error('stuck');
      w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = w.timers.shift();
      w.vt = Math.max(w.vt, next.at);
      next.fn();
    }
    throw new Error('did not settle');
  };
  return w;
}

test('(3) the owner reports each Enter write (ok, failed) with its gap; none when no Enter is written', async () => {
  const ok = claudeWorld();
  assert.deepEqual(await ok.submit(), { kind: 'COMMITTED' });
  assert.equal(ok.records.length, 1);
  assert.deepEqual(ok.records[0], { requestId: 'boot:god:1', agentId: 'god', ptyId: 'pty-god', admissionClass: 'BOOT_SEQUENCE', ok: true, gapMs: GAP_MS, reentry: false });

  const failed = claudeWorld({ enterFails: true });
  const out = await failed.submit();
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'ENTER_WRITE_FAILED');
  assert.equal(failed.records.length, 1);
  assert.equal(failed.records[0].ok, false);
  assert.equal(failed.records[0].error, 'EPIPE');

  const picker = claudeWorld({ pickerAtEnter: true });
  const p = await picker.submit();
  assert.equal(p.kind, 'INTERFERED');
  assert.equal(p.reason, 'PICKER_LATCHED_AFTER_STAGE');
  assert.deepEqual(picker.records, [], 'INTERFERED before the Enter: no Enter was written, so no Enter row');
});

test('(3) LOGGING ONLY: the same submits write exactly the same bytes and settle the same with or without the hook', async () => {
  for (const opts of [{}, { enterFails: true }, { pickerAtEnter: true }]) {
    const a = claudeWorld(opts);
    const b = claudeWorld(opts);
    delete b.deps.onEnterWrite;
    b.owner = new AutomaticSubmitOwner(b.deps);
    assert.deepEqual(await a.submit(), await b.submit(), JSON.stringify(opts));
    assert.deepEqual(a.writes, b.writes, JSON.stringify(opts));
  }
  // A throwing diagnostics hook can never change an outcome.
  const c = claudeWorld();
  c.deps.onEnterWrite = () => { throw new Error('boom'); };
  c.owner = new AutomaticSubmitOwner(c.deps);
  assert.deepEqual(await c.submit(), { kind: 'COMMITTED' });
  // Claude keeps no post-Enter verification (the behaviour change is explicitly NOT made).
  assert.equal(loadTs('src/shared/providerAutomation.ts').automaticVerifySubmit('claude'), false);
});

test('(3) wiring: boot-submit rows per attempt/outcome, per Enter write, THREW in main and renderer; no swallowed catch', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const boot = r\.admissionClass === 'BOOT_SEQUENCE'\s*\? \{ kind: 'boot-submit', agentId: r\.agentId, requestId: r\.requestId, attempt:/);
  assert.match(idx, /if \(boot\) hive\.appendLog\(\{ \.\.\.boot, outcome: o\.kind, reason: o\.reason \?\? null/);
  assert.match(idx, /if \(boot\) hive\.appendLog\(\{ \.\.\.boot, outcome: 'THREW'/);
  assert.match(idx, /\}\)\.then\(\(outcome\) => \{[\s\S]*?return outcome;/, 'every outcome passes through unchanged');
  assert.match(idx, /outcome: 'ENTER_WRITE', ok: r\.ok, reason: r\.error \?\? null, gapMs: r\.gapMs/);
  assert.match(idx, /ipcMain\.on\('autoSubmit:bootSubmitThrew'/);
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /admissionClass: 'BOOT_SEQUENCE', text, settleMs, attempt: attempt \+ 1 \}/);
  assert.match(hive, /window\.cth\.logBootSubmitThrew\?\.\(GOD_ID, message\)/);
  assert.doesNotMatch(hive, /catch \{ \/\* PTY may have died during startup \*\/ \}/, 'the orientation error is no longer swallowed');
  assert.match(read('src/preload/index.ts'), /ipcRenderer\.send\('autoSubmit:bootSubmitThrew', agentId, message\)/);
});
