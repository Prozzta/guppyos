'use strict';

/**
 * RENDERER-PROFILE, RENDERED (test/electron-harness/renderer-profile-main.cjs), option A.
 * A renderer stuck allocating in `runawayAllocator`, whose probe was ARMED while it was healthy,
 * yields:
 * - Performance.getMetrics;
 * - the paused JS stack naming the loop, and its heap read while paused;
 * - a CPU profile naming the loop, written as a parseable .cpuprofile.
 * All of it is time-boxed, with main never blocked.
 *
 * The same loop with the probe NOT armed (the 1.1.67 situation) times out at 'arm', gives up
 * and detaches. An idle page profiles and still answers afterwards (not left paused). A
 * `debugger;` statement on an armed page is resumed by the probe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createSandbox, removeSandbox } = require('./electron-harness/run.cjs');

const MARKER = '__RENDERERPROFILE_RESULT__';

function run() {
  const electron = require('electron');
  const sandbox = createSandbox('rprof-');
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [join(__dirname, 'electron-harness', 'renderer-profile-main.cjs'), '--sandbox', sandbox], {
      cwd: join(__dirname, '..'), env: { ...process.env, MUNDER_DEV: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      removeSandbox(sandbox).then(() => {
        const at = out.lastIndexOf(MARKER);
        if (at < 0) { reject(new Error(`no result (exit ${code})\n${out.slice(-2000)}\n${err.slice(-2000)}`)); return; }
        resolve(JSON.parse(out.slice(at + MARKER.length).split('\n')[0]));
      }, reject);
    });
  });
}

test('RENDERED: an ARMED probe names the looping function of a renderer stuck in a busy allocating loop', { timeout: 180_000 }, async (t) => {
  const r = await run();
  assert.equal(r.ok, true, r.error);
  console.log(JSON.stringify(r));

  await t.test('busy + armed: metrics, stack, heap, profile, file; time-boxed; main never blocked', () => {
    const b = r.busy;
    assert.equal(b.armed, true);
    // RPROF-LOAD (gate #4): this arm NAMES the loop; its budget is a hang guard, not the product's 5 s.
    assert.equal(b.captureTimeoutMs, 25_000, 'the busy arm runs with the hang-guard budget');
    assert.equal(b.profile.profile, 'ok', JSON.stringify(b.profile));
    assert.ok(b.profile.metrics && b.profile.metrics.JSHeapUsedSize > 50, `Performance.getMetrics from the busy renderer: ${JSON.stringify(b.profile.metrics)}`);
    assert.ok(b.profile.stack && b.profile.stack[0].startsWith('runawayAllocator'), `paused inside the loop: ${JSON.stringify(b.profile.stack)}`);
    assert.ok(b.profile.jsHeapUsedMb > 50, 'heap read while paused');
    // LOAD-INDEPENDENT (1.1.72 gate: the full suite measured 32% where alone it is ~63%). The probe
    // must NAME the loop, not reach a share: the loop is the page's only named function, so it is the
    // top app frame whatever the CPU share. Time and main-thread gaps are hang guards only.
    // TEST-FLAKE-RENDERER-PROFILE: the probe NAMES the loop through the exact channel, the paused
    // stacks. Under CPU load V8's sampler charges a JIT-compiled loop's ticks to its caller (the
    // full suite measured 0% on the loop, all on the setTimeout arrow), so the profile's top app
    // frame cannot carry this assertion; the product's stuckIn is taken from the stacks for that reason.
    assert.equal(b.profile.stuckIn?.source, 'stacks', `the stuck frame comes from the paused stacks: ${JSON.stringify(b.profile.stuckIn)}`);
    assert.ok(b.profile.stuckIn.fn.startsWith('runawayAllocator'), `the probe names the loop: ${JSON.stringify(b.profile.stuckIn)}`);
    // The profile still samples the busy page's own code (the loop, or its caller when the sampler
    // charges the caller); its top app frame and the disagreement flag are always printed.
    assert.ok(b.profile.topInclusive.some((e) => /^\S+ busy\.html:\d+/.test(e.fn) && !e.fn.startsWith('(root)')), `the profile samples the busy page's own code: ${JSON.stringify(b.profile.topInclusive)}`);
    t.diagnostic(`profile top app: ${JSON.stringify(b.profile.topApp?.[0] ?? null)}; profileDisagrees: ${!!b.profile.profileDisagrees}`);
    assert.ok(b.profile.samples > 0, `real samples: ${b.profile.samples}`);
    assert.ok(b.profile.ms < 30_000, `time-boxed (hang guard): ${b.profile.ms} ms`);
    // LOAD-FLAKES-FOLLOWUPS (Andy RPROF note): the production box is 5 s; an armed busy capture that
    // no longer fits it would show only as production timeouts. Always reported; a failure only on a
    // machine declared quiet (MUNDER_QUIET_TIMING_CHECKS=1), since under load it is a timing flake.
    t.diagnostic(`armed busy capture: ${b.profile.ms} ms (production box 5000 ms)`);
    if (process.env.MUNDER_QUIET_TIMING_CHECKS === '1') assert.ok(b.profile.ms < 5_000, `on a quiet machine an armed busy capture fits the production 5 s box: ${b.profile.ms} ms`);
    assert.ok(b.fileNodes > 0, 'the .cpuprofile was written and parses');
    assert.ok(b.worstGapMs < 30_000, `main not blocked (hang guard): worst gap ${b.worstGapMs} ms`);
    // RPROF Finding 2: the ROW alone names the loop, with locations.
    assert.match(b.profile.stack[0], /^runawayAllocator busy\.html:\d+:\d+$/, 'the paused frame has file:line:col');
    assert.ok(b.profile.stacks.length >= 2, `several paused stacks: ${b.profile.stacks.length}`);
    assert.ok(b.profile.stackApp[0].fn.startsWith('runawayAllocator') && b.profile.stackApp[0].stacks === b.profile.stacks.length, `in every stack: ${JSON.stringify(b.profile.stackApp)}`);
  });

  await t.test('busy + NOT armed (the 1.1.67 situation): times out at arm, gives up, detaches', () => {
    const u = r.unarmed;
    assert.equal(u.profile.profile, 'timeout', JSON.stringify(u.profile));
    assert.equal(u.profile.stage, 'arm');
    // RPROF-LOAD: the PRODUCTION default box, load-independently: this arm passes no timeoutMs, and a
    // stuck renderer cannot arm, so it spends the whole default (load can only make it longer).
    assert.equal(u.captureTimeoutMs, null, 'the unarmed arm keeps the production default');
    assert.ok(u.profile.ms >= 4_900, `the 5 s PROFILE_TIMEOUT_MS box was spent, not a shorter one: ${u.profile.ms} ms`);
    assert.equal(u.attachedAfter, false, 'never leaves a dead session attached');
    assert.ok(u.profile.ms < 30_000, `time-boxed (hang guard): ${u.profile.ms} ms`);
    assert.ok(u.worstGapMs < 30_000, `main not blocked (hang guard): worst gap ${u.worstGapMs} ms`);
  });

  await t.test('idle + armed: no stack (nothing to pause), a profile, and the page still answers', () => {
    const i = r.idle;
    assert.equal(i.captureTimeoutMs, 25_000, 'the idle arm runs with the hang-guard budget');
    assert.equal(i.profile.profile, 'ok', JSON.stringify(i.profile));
    // GATE-179: nothing of Electron's own runs on the idle page while it is captured (its load-time
    // security check raced the capture under load and was the stack).
    assert.equal(i.securityWarnings, 0, 'Electron\'s security check is off on the harness pages');
    assert.equal(i.profile.stack, null, `an idle page has nothing to pause: ${JSON.stringify(i.profile.stack)}`);
    assert.equal(i.profile.stacks, undefined, 'no extra pauses spent on an idle renderer');
    assert.equal(i.answers, 'pong', 'not left paused');
    assert.equal(i.attachedAfter, true, 'the armed session stays for the next spike');
  });

  await t.test('a `debugger;` statement on an armed page is resumed (a foreign pause)', () => {
    assert.equal(r.foreign.armed, true);
    assert.equal(r.foreign.got, 'continued');
    assert.equal(r.foreign.foreignResumes, 1);
  });
});

test('RPROF-LOAD pins: the production budget is 5 s, the app passes no other, and a give-up is a visible row', () => {
  const fs = require('node:fs');
  const loadTs = require('./load-ts.cjs');
  assert.equal(loadTs('src/main/rendererRecovery.ts').PROFILE_TIMEOUT_MS, 5_000);
  const idx = fs.readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  // The one production capture uses the default budget (no timeoutMs), and its row spreads the
  // whole result: a timeout logs profile 'timeout', the stage it stopped in, error and ms.
  assert.match(idx, /void probe\.capture\(\{ write: \(json\) => saveRendererProfile\(join\(app\.getPath\('userData'\), 'renderer-profiles'\), pid, json\) \}\)/);
  assert.match(idx, /hive\.appendLog\(\{ kind: 'renderer-memory-profile', pid, mb: mbNow, foreignResumes: probe\.foreignResumes, \.\.\.r \}\)/);
  const rr = fs.readFileSync(join(__dirname, '..', 'src', 'main', 'rendererRecovery.ts'), 'utf8');
  assert.match(rr, /return \{ \.\.\.out, profile: \/\^\(pause-send\|resume\|profiler-start\|profiler-stop\)\$\/\.test\(why\) \? 'timeout' : 'failed', stage, error: why, ms: Date\.now\(\) - t0, gaveUp: true \};/);
});
