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
    assert.equal(b.profile.profile, 'ok', JSON.stringify(b.profile));
    assert.ok(b.profile.metrics && b.profile.metrics.JSHeapUsedSize > 50, `Performance.getMetrics from the busy renderer: ${JSON.stringify(b.profile.metrics)}`);
    assert.ok(b.profile.stack && b.profile.stack[0].startsWith('runawayAllocator'), `paused inside the loop: ${JSON.stringify(b.profile.stack)}`);
    assert.ok(b.profile.jsHeapUsedMb > 50, 'heap read while paused');
    const incl = b.profile.topInclusive.find((e) => e.fn.startsWith('runawayAllocator'));
    assert.ok(incl && incl.pct >= 50, `the profile names the loop: ${JSON.stringify(b.profile.topInclusive)}`);
    assert.ok(b.profile.samples > 100, `real samples: ${b.profile.samples}`);
    assert.ok(b.profile.ms <= 5_500, `time-boxed: ${b.profile.ms} ms`);
    assert.ok(b.fileNodes > 0, 'the .cpuprofile was written and parses');
    assert.ok(b.worstGapMs < 1_000, `main never blocked: worst gap ${b.worstGapMs} ms`);
  });

  await t.test('busy + NOT armed (the 1.1.67 situation): times out at arm, gives up, detaches', () => {
    const u = r.unarmed;
    assert.equal(u.profile.profile, 'timeout', JSON.stringify(u.profile));
    assert.equal(u.profile.stage, 'arm');
    assert.equal(u.attachedAfter, false, 'never leaves a dead session attached');
    assert.ok(u.profile.ms <= 5_500);
    assert.ok(u.worstGapMs < 1_000, `main never blocked: worst gap ${u.worstGapMs} ms`);
  });

  await t.test('idle + armed: no stack (nothing to pause), a profile, and the page still answers', () => {
    const i = r.idle;
    assert.equal(i.profile.profile, 'ok', JSON.stringify(i.profile));
    assert.equal(i.profile.stack, null);
    assert.equal(i.answers, 'pong', 'not left paused');
    assert.equal(i.attachedAfter, true, 'the armed session stays for the next spike');
  });

  await t.test('a `debugger;` statement on an armed page is resumed (a foreign pause)', () => {
    assert.equal(r.foreign.armed, true);
    assert.equal(r.foreign.got, 'continued');
    assert.equal(r.foreign.foreignResumes, 1);
  });
});
