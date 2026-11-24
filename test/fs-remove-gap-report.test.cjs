'use strict';
require('./tools/own-job.cjs');
/**
 * FLAKE-FS-REMOVE-GAP-RACE-CHILD-FAILED-108: a race process that ends without a result says how it
 * ended.
 *
 * fs-remove-gap's CONTROL went red once under suite load with "RACE FAILED: no result: Command
 * failed: <the command line>" and nothing more. The text was cut after 200 characters, and the
 * command line alone is that long: the exit code and the child's stderr came after the cut. So the
 * one occurrence could not say whether the child threw (a stack on stderr) or was ended from
 * outside (no stderr).
 *
 * This file starts one race process through many() that dies before it runs anything, by a
 * --require fixture in NODE_OPTIONS, and reads what many() reports for it. It is light: one child
 * per cell, no race.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { many } = require('./fs-remove-gap-race.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-gap-report-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Run one race process that loads `body` first (and dies in it); returns the failed racer's text. */
async function dead(name, body) {
  const fixture = path.join(ROOT, `${name}.cjs`);
  fs.writeFileSync(fixture, body);
  const before = process.env.NODE_OPTIONS;
  const exeBefore = process.env.FS_GAP_EXE;
  delete process.env.FS_GAP_EXE;
  // forward slashes: NODE_OPTIONS reads a backslash as an escape
  process.env.NODE_OPTIONS = `${before ? before + ' ' : ''}--require "${fixture.replace(/\\/g, '/')}"`;
  let res;
  try { res = await many(['sync'], 1, 1, 1); }
  finally {
    if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
    if (exeBefore !== undefined) process.env.FS_GAP_EXE = exeBefore;
  }
  const t = res.totals.sync;
  assert.equal(t.races, 1);
  assert.equal(t.failed, 1, 'the dead racer is a failed race');
  const keys = Object.keys(t.errors);
  assert.equal(keys.length, 1, JSON.stringify(keys));
  return keys[0];
}

test('a racer that throws before its result: the exit code and the END of its stderr are in the report', async () => {
  // 3000 characters of stderr first: the reason of a real crash is at the end of a stack, not the start
  const text = await dead('throws', `process.stderr.write('x'.repeat(3000) + '\\nFS-GAP-REPORT-LAST-STDERR-LINE\\n'); process.exit(3);\n`);
  assert.match(text, /^RACE FAILED: no result: exit 3\b/, `THE EXIT CODE COMES FIRST: ${text.slice(0, 300)}`);
  assert.ok(text.includes('FS-GAP-REPORT-LAST-STDERR-LINE'), `THE END OF THE CHILD'S STDERR IS KEPT: ${text.slice(0, 300)}`);
});

test('a racer that ends with no stderr (what a kill from outside leaves) says so: it cannot be read as a throw', async () => {
  const text = await dead('silent', 'process.exit(1);\n');
  assert.match(text, /^RACE FAILED: no result: exit 1\b/, text.slice(0, 300));
  assert.ok(text.includes('stderr: (empty)'), `AN EMPTY STDERR IS SAID, not left out: ${text.slice(0, 300)}`);
});

/*
 * FS-REMOVE-GAP-RACE-FAILED-PID-JOURNAL-108: a failed racer's line names the child's pid and spawn time and
 * looks that pid up in the run's stops journal (own-procs stopsNaming) and in the run's <starts>.kills rows.
 *
 * A Stop-Process -Force ends its target with exit 4294967295 and no output, which is what the one Electron
 * sighting left (fs-remove-gap CONTROL, a jswalk racer); with no pid in the line, the run's records could not
 * say whether a neighbour's stop script was handed that pid. Here the racer is made up: a --require fixture
 * that writes its own pid, appends journal rows for itself (as a neighbour's stop would) and exits 1 with no
 * output. The journal is a made-up <starts>.stops (and its .kills beside it) put on this process under the
 * key the run's preload uses, then put back.
 *
 * MUTANT (teeth): in many(), hand noResult the parent's pid (process.pid) instead of the child's: both cells
 * go red (the pid in the line is not the racer's, and the journal lookups miss its rows).
 */
const BACKSTOP_KEY = Symbol.for('guppy.file-backstop');
async function deadInRun(name, rows) {
  const stops = path.join(ROOT, `${name}.stops`);
  const kills = path.join(ROOT, `${name}.kills`);
  const pidFile = path.join(ROOT, `${name}.pid`);
  // one row for another pid: the lookup is by the child's pid, not "any row"
  fs.writeFileSync(stops, `${JSON.stringify({ t: Date.now(), pid: 1, ppid: 0, name: 'other.exe', created: 1, rule: 'other', file: 'other.test.cjs', by: 1 })}\n`);
  fs.writeFileSync(kills, `${JSON.stringify({ pid: 1, file: 'other.test.cjs', via: 'process.kill', targets: [1], t: Date.now() })}\n`);
  const J = JSON.stringify;
  const body = `const fs = require('fs'); const p = process.pid; fs.writeFileSync(${J(pidFile)}, String(p));\n` + (rows
    ? `fs.appendFileSync(${J(stops)}, JSON.stringify({ t: Date.now(), pid: p, ppid: 7, name: 'electron.exe', created: 11, rule: 'FS-GAP-REPORT-RULE', file: 'fs-gap-report-neighbour.test.cjs', by: 4242 }) + '\\n');\n`
      + `fs.appendFileSync(${J(kills)}, JSON.stringify({ pid: 4243, file: 'fs-gap-report-killer.test.cjs', via: 'taskkill', targets: [p], t: Date.now() }) + '\\n');\n`
    : '') + 'process.exit(1);\n';
  const had = Object.prototype.hasOwnProperty.call(process, BACKSTOP_KEY);
  const prev = process[BACKSTOP_KEY];
  process[BACKSTOP_KEY] = { stops, file: 'fs-remove-gap-report.test.cjs' };
  let text;
  try { text = await dead(name, body); } finally { if (had) process[BACKSTOP_KEY] = prev; else delete process[BACKSTOP_KEY]; }
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, `the fixture ran and wrote its pid: ${pid}`);
  return { text, pid };
}

test('a failed racer names its pid and spawn time, and the stop-script and kill rows that name that pid', async () => {
  const t0 = Date.now();
  const { text, pid } = await deadInRun('handed', true);
  assert.match(text, /^RACE FAILED: no result: exit 1\b/, text.slice(0, 300));
  const m = text.match(/ \[race child pid=(\d+) started=(\S+) ended=(\S+)\]/);
  assert.ok(m, `THE CHILD'S PID AND SPAWN TIME ARE IN THE LINE: ${text}`);
  assert.equal(Number(m[1]), pid, `THE PID IS THE RACER'S: ${text}`);
  const started = Date.parse(m[2]);
  const ended = Date.parse(m[3]);
  assert.ok(started >= t0 - 1000 && started <= ended, `started=${m[2]} ended=${m[3]} (test began ${new Date(t0).toISOString()})`);
  assert.ok(text.includes(` [own-procs stops: pid ${pid} was handed to a stop script (handed, not proven stopped): electron.exe created=11 ppid=7 rule=FS-GAP-REPORT-RULE by fs-gap-report-neighbour.test.cjs (pid 4242)`),
    `THE STOPS JOURNAL ROW FOR THE PID IS IN THE LINE: ${text}`);
  assert.ok(text.includes(` [kills: pid ${pid} was named by a kill (taskkill) from fs-gap-report-killer.test.cjs (pid 4243) at `), `THE KILLS ROW FOR THE PID IS IN THE LINE: ${text}`);
  assert.ok(!/other\.test\.cjs/.test(text), `a row for another pid is not listed: ${text}`);
});

test('a failed racer whose pid no stop script and no kill was handed says so, with the row counts', async () => {
  const { text, pid } = await deadInRun('unnamed', false);
  assert.match(text, new RegExp(` \\[race child pid=${pid} started=\\S+ ended=\\S+\\]`), `THE CHILD'S PID IS IN THE LINE: ${text}`);
  assert.ok(text.includes(` [own-procs stops: none of 1 rows names pid ${pid}; a row means handed to a stop script, not stopped]`), `NO STOPS ROW IS SAID: ${text}`);
  assert.ok(text.includes(` [kills: none of 1 rows names pid ${pid} since its spawn;`), `NO KILLS ROW IS SAID: ${text}`);
});
