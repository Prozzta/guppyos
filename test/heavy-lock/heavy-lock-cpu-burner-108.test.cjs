'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-LOCK-SH-SCRIPT-NOT-DENIED-108: two load scripts got past the heavy lock as light calls and
 * ran beside a suite that held the slot.
 *  - Sele, 04:04:36Z: `cat > loadall.sh <<E ... E` then `sh loadall.sh > /dev/null 2>&1 &`. The body
 *    is a while loop that starts 32 `node -e "for(;;){}" &`, plus single-file node --test cells.
 *  - Creed, 07:52:40Z: `bash run.sh`. It starts 32 CPU spinners and 16 file/spawn churners in loops.
 * The classifier read both scripts and found nothing heavy. Nothing classed an endless `node -e`
 * loop, or a loop of backgrounded processes, as load.
 * Each sighted shape is now an exclusive bench (a held, non-provisional class).
 * Only pure strings are classified here: nothing is run. The scripts are written in a jailed temp dir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const { HookServer } = loadTs('src/main/hooks.ts');

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-burner108-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A readable single-file test, so a node --test cell in a script is light on its own (Sele's cells). */
function cellFile(d) {
  fs.writeFileSync(path.join(d, 'cell.test.cjs'), "require('node:test')('x', () => {});\n");
}

function bench(M, cmd, ctx, tag) {
  const c = M.classifyCommand(cmd, 0, ctx);
  assert.equal(c.heavy, true, `${tag}: ${JSON.stringify(cmd)} is heavy (classed ${JSON.stringify(c)})`);
  assert.notEqual(c.provisional, true, `${tag}: ${JSON.stringify(cmd)} is held for what it runs, not only because it is unreadable`);
  assert.equal(c.kind, 'bench', `${tag}: ${JSON.stringify(cmd)} is a bench`);
  assert.equal(M.heavyExclusive(c), true, `${tag}: ${JSON.stringify(cmd)} runs alone (exclusive)`);
  return c;
}

const BURNERS = [
  'node -e "for(;;){}"',
  'node -e "for(;;){}" &',
  "node -e 'for (;;) {}'",
  'node --eval "while(true){}"',
  "node --eval 'while (true) { Math.sqrt(2) }'",
  'node -e "while(1);"',
  "node -e 'let x = 0; while (1) x++'",
  'node --eval="for(;;);"',
  "node -e='while(true){}'",
  'node -p "for(;;){}"',
  'C:/Dunder/_tools/node-v24.22.2-win-x64/node.exe -e "for(;;){}"',
];

const LOOPS = [
  'for i in 1 2 3 4; do yes > /dev/null & done',
  'for i in {1..32}; do yes > /dev/null & done',
  'for i in $(seq 32); do gzip -9 < /dev/zero > /dev/null & done; wait',
  'i=0; while [ $i -lt 32 ]; do sh -c "yes > /dev/null" & i=$((i+1)); done',
  'until false; do yes > /dev/null & done',
  'for i in 1 2; do yes > /dev/null & yes > /dev/null & done',
  'for i in a b c d\ndo\n  sh spin.sh &\ndone',
];

// Each guarantee in its own function, so the census can name the one a mutant breaks.
const K = {
  forever(M) { for (const cmd of BURNERS.filter((c) => /for ?\(/.test(c))) bench(M, cmd, {}, 'AN ENDLESS FOR(;;) IN NODE -E IS A BENCH'); },
  whileTrue(M) { for (const cmd of BURNERS.filter((c) => /while ?\((true|1)\)/.test(c))) bench(M, cmd, {}, 'AN ENDLESS WHILE(TRUE|1) IN NODE -E IS A BENCH'); },
  loops(M) { for (const cmd of LOOPS) bench(M, cmd, {}, 'A SHELL LOOP THAT BACKGROUNDS 4 OR MORE PROCESSES IS A BENCH'); },
  four(M) { bench(M, 'for i in 1 2 3 4; do yes > /dev/null & done', {}, 'FOUR BACKGROUNDED ROUNDS ARE ENOUGH'); },
  unbounded(M) {
    for (const cmd of ['while true; do yes > /dev/null & done', 'for f in *.bin; do gzip -9 "$f" & done']) bench(M, cmd, {}, 'AN UNBOUNDED LOOP THAT BACKGROUNDS IS A BENCH');
  },
  sele(M, d) {
    cellFile(d);
    const body = [
      'i=0',
      'while [ $i -lt 32 ]; do node -e "for(;;){}" & i=$((i+1)); done',
      'node --test --test-name-pattern=afterEnd cell.test.cjs',
      'node --test --test-name-pattern=afterEnd cell.test.cjs',
    ].join('\n');
    const ctx = HookServer.heavyScriptCtx(d);
    bench(M, `cat > loadall.sh <<E\n${body}\nE\nsh loadall.sh > /dev/null 2>&1 &`, ctx, "SELE'S LOADALL.SH (HEREDOC, RUN IN THE SAME CALL) IS A BENCH");
  },
  creed(M, d) {
    fs.writeFileSync(path.join(d, 'run.sh'), [
      '#!/bin/bash',
      'for i in $(seq 32); do',
      "  node -e 'for(;;){}' &",
      'done',
      'for i in $(seq 16); do',
      '  ( while true; do echo x > churn$i.txt; rm -f churn$i.txt; done ) &',
      'done',
      'sleep 60',
    ].join('\n'));
    bench(M, 'bash run.sh', HookServer.heavyScriptCtx(d), "CREED'S RUN.SH (A FILE ON DISK) IS A BENCH");
  },
  churners(M, d) {
    // Creed's churners alone, with no node at all: the loop rule, not the node -e rule.
    fs.writeFileSync(path.join(d, 'churn.sh'), 'for i in $(seq 16); do\n  ( while true; do echo x > c$i.txt; rm -f c$i.txt; done ) &\ndone\n');
    bench(M, 'bash churn.sh', HookServer.heavyScriptCtx(d), 'A SCRIPT OF BACKGROUNDED CHURN LOOPS IS A BENCH');
  },
  // Not widened: code and loops that end, or start fewer than 4 at once, stay light.
  light(M) {
    for (const cmd of [
      'node -e "for (let i = 0; i < 3; i++) {}"',
      'node -e "while (x) { x-- }"',
      'node -e "while (10) {}"',
      "node -e \"console.log('for(;;){}')\"",
      'node -e "// while(true)"',
      'node -e "1"',
      'for i in 1 2 3; do yes > /dev/null & done; wait',
      'for f in a b c d e; do echo $f; done',
      'while true; do sleep 5; done',
      'yes > /dev/null &',
      'for i in 1 2 3 4; do echo $i; done &',
    ]) {
      const c = M.classifyCommand(cmd, 0, {});
      assert.equal(c.heavy, false, `NOT WIDENED: ${JSON.stringify(cmd)} stays light (classed ${JSON.stringify(c)})`);
    }
  },
};

test('NODE -E: an endless for(;;) loop is an exclusive bench', () => K.forever(HJ));
test('NODE -E: an endless while(true) / while(1) loop is an exclusive bench', () => K.whileTrue(HJ));
test('SHELL: a loop that backgrounds 4 or more processes is an exclusive bench', () => { K.loops(HJ); K.four(HJ); K.unbounded(HJ); });
test("SIGHTED: Sele's heredoc loadall.sh run in the same call", (t) => K.sele(HJ, dir(t)));
test("SIGHTED: Creed's bash run.sh (32 spinners + 16 churners)", (t) => K.creed(HJ, dir(t)));
test('SHELL: backgrounded churn loops with no node in them', (t) => K.churners(HJ, dir(t)));
test('NOT WIDENED: code and loops that end, or start fewer than 4 processes, stay light', () => K.light(HJ));
