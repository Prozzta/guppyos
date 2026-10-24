'use strict';
/**
 * AGY-TEARDOWN (Oscar's finding, reproduced on 1.1.101 by Andy 2026-10-24): an explicit PTY kill
 * left a descendant that is not on the pseudo-console alive. On Windows kill() and killByOwner()
 * closed the ConPTY first, which ended the root, and the tree sweep ensureKilled ran 4 s later was
 * `taskkill /T` on a dead pid: it found nothing. agy's inner agy.exe runs on its own conhost, so it
 * lived on. Now the tree is swept while intact and the ConPTY closed after (killAllAsync's order).
 *
 * REAL processes, headless: a PtyManager PTY runs a node root that starts a DETACHED inner node
 * (no console, like agy's inner child: off the pseudo-console). The inner polls for a `go` file and
 * gives up after 60 s, so a failed run never leaks for long; the finally releases it either way.
 *
 * Named mutants, each must fail this file:
 *   M1 kill() closes the ConPTY before the sweep (the 1.1.101 order)
 *   M2 killByOwner() closes the ConPTY before the sweep (the 1.1.101 order)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { tempDir } = require('./tools/test-temp.cjs');

if (process.platform !== 'win32') {
  require('./tools/inert.cjs').announceInert('AGY-TEARDOWN tree sweep order', 'POSIX keeps SIGHUP plus the group sweep; the ConPTY order is Windows only');
  return;
}

const PTYF = 'src/main/pty.ts';
const { PtyManager } = loadTs(PTYF);
const DIR = tempDir('agyt-');
fs.writeFileSync(path.join(DIR, 'root.js'), [
  "const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');",
  'const dir = process.argv[2];',
  "const c = spawn(process.execPath, [path.join(__dirname, 'inner.js'), dir], { windowsHide: true, stdio: 'ignore', detached: true });",
  "fs.writeFileSync(path.join(dir, 'root.json'), JSON.stringify({ root: process.pid, inner: c.pid }));",
  'setInterval(() => {}, 1000);'
].join('\n'));
fs.writeFileSync(path.join(DIR, 'inner.js'), [
  "const fs = require('fs'); const path = require('path'); const dir = process.argv[2]; const t0 = Date.now();",
  "fs.writeFileSync(path.join(dir, 'inner.json'), JSON.stringify({ pid: process.pid }));",
  "setInterval(() => { if (fs.existsSync(path.join(dir, 'go')) || Date.now() - t0 > 60000) process.exit(0); }, 20);"
].join('\n'));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Past ensureKilled's 4 s grace plus its taskkill: the old order never ends the inner at ANY time.
const DEADLINE_MS = 7_000;
let seq = 0;

/** Spawn a root plus its off-console inner in a PTY, end it with `end(m, id, owner)`, and return
 *  whether the inner was gone within the deadline. */
async function run(Pty, end) {
  const dir = fs.mkdtempSync(path.join(DIR, 'run-'));
  const m = new Pty();
  const owner = { isDestroyed: () => false, send: () => {} };
  const id = `agyt-${++seq}`;
  let inner = 0;
  try {
    const r = await m.spawn({ id, cwd: dir, command: process.execPath, args: [path.join(DIR, 'root.js'), dir], cols: 80, rows: 24, env: {} }, owner);
    assert.ok(r.ok, `spawn: ${r.error}`);
    for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'inner.json')); i++) await sleep(25);
    inner = JSON.parse(fs.readFileSync(path.join(dir, 'inner.json'), 'utf8')).pid;
    const root = JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8')).root;
    assert.equal(m.list()[0].pid, root, 'the node root is the PTY process');
    assert.ok(alive(inner), 'the inner child is running before the kill');
    end(m, id, owner);
    const t0 = Date.now();
    while (alive(inner) && Date.now() - t0 < DEADLINE_MS) await sleep(100);
    return { innerGone: !alive(inner), rootGone: !alive(root) };
  } finally {
    fs.writeFileSync(path.join(dir, 'go'), '');   // release a leaked inner at once
    for (let i = 0; inner && i < 40 && alive(inner); i++) await sleep(25);
  }
}

const K = {};
K.kill = async (Pty) => {
  const r = await run(Pty, (m, id) => assert.equal(m.kill(id).ok, true));
  assert.ok(r.rootGone, 'KILL: the PTY root is gone');
  assert.ok(r.innerGone, `KILL ENDS THE WHOLE TREE: a descendant off the pseudo-console is still alive ${DEADLINE_MS} ms after kill()`);
};
K.owner = async (Pty) => {
  const r = await run(Pty, (m, _id, owner) => m.killByOwner(owner));
  assert.ok(r.rootGone, 'OWNER: the PTY root is gone');
  assert.ok(r.innerGone, `KILLBYOWNER ENDS THE WHOLE TREE: a descendant off the pseudo-console is still alive ${DEADLINE_MS} ms after killByOwner()`);
};

test('kill(): an explicit kill ends the PTY root AND its descendant off the pseudo-console', () => K.kill(PtyManager));
test('killByOwner() (a floor window closing): ends the root AND its descendant off the pseudo-console', () => K.owner(PtyManager));

// ─── MUTANT CENSUS ───────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

// The 1.1.101 body of each kill site: close the ConPTY, then the late sweep of the (dead) root.
const OLD_ORDER = 'const pid = s.proc.pid; s.proc.kill(); ensureKilled(pid);';
const MUTANTS = [
  { name: 'M1 kill() closes the ConPTY before the sweep', edits: [['      this.closeTree(s);\n      // kill() deletes', `      ${OLD_ORDER}\n      // kill() deletes`]],
    killer: 'kill', dies: /KILL ENDS THE WHOLE TREE/ },
  { name: 'M2 killByOwner() closes the ConPTY before the sweep', edits: [['        try { this.closeTree(s); } catch', `        try { ${OLD_ORDER} } catch`]],
    killer: 'owner', dies: /KILLBYOWNER ENDS THE WHOLE TREE/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const { PtyManager: P } = loadTs.fromText(PTYF, mutateText(PTYF, m.edits, m.name));
      await assert.rejects(() => K[m.killer](P), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
