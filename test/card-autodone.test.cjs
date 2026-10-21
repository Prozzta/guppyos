/**
 * CARD-AUTODONE-ON-BUILD: only god marks a card done. A builder's or auditor's `status: done`
 * is dropped from its ledger op (the rest lands), the reply says `status kept`; an op that sets
 * no status shows the current one as `(unchanged)`, so an echo never reads as a flip.
 *
 * Why: on 2026-10-21 five cards flipped to done the moment a builder reported, before the INT
 * landed; the reply line of a note-only op then echoed `card=X:done`, which looked like the op
 * had set it. The protocol example itself taught the `patch: { status: done }` shape.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { normaliseEol } = require('./read-source.cjs');

const ROOT = path.join(__dirname, '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'card-autodone-'));
test.after(() => { fs.rmSync(JAIL, { recursive: true, force: true }); });

const L = loadTs('src/main/ledger.ts');

function fixture(agentId, isGod, status = 'doing') {
  const agentDir = fs.mkdtempSync(path.join(JAIL, 'agent-'));
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# memory\n\n## How I work (standing lessons)\n- l1\n\n## notes\n- n\n');
  const state = { tasks: [{ id: 'C-1', title: 'card', status, assignee: agentId, dependsOn: [], priority: 1, createdAt: 'x' }], patches: [] };
  const deps = {
    agentId, agentDir, isGod,
    isRecipient: (to) => ['god', 'jim', 'broadcast'].includes(to),
    readTasks: () => state.tasks.map((t) => ({ ...t })),
    addTask: (t) => { if (state.tasks.some((x) => x.id === t.id)) return false; state.tasks.push(t); return true; },
    patchTask: (id, patch) => { const i = state.tasks.findIndex((x) => x.id === id); if (i < 0) return false; state.patches.push(patch); state.tasks[i] = { ...state.tasks[i], ...patch, id }; return true; },
    now: () => new Date('2026-10-21T20:00:00.000Z')
  };
  const outbox = () => { try { return fs.readdirSync(path.join(agentDir, 'outbox')).filter((f) => f.endsWith('.json')); } catch { return []; } };
  return { deps, state, outbox, memory: () => fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8') };
}
const card = (f) => f.state.tasks.find((t) => t.id === 'C-1');
const KEPT = "(status kept: done is god's)";

test("t1: a builder's patch {status: done} is dropped: result appended, status kept, the rest lands, the retry is identical", () => {
  const f = fixture('creed', false);
  const op = { op: 'b1', card: { id: 'C-1', patch: { status: 'done' }, appendResult: 'built @ abc; Jim audits' }, message: { to: 'god', act: 'done', subject: 's', body: 'b' }, memory: { append: '- built' } };
  const r = L.applyLedgerOp(op, f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.equal(r.body.line, `ok op=b1 card=C-1:doing ${KEPT} msg=ledger-b1.json memory=+7B`);
  assert.equal(card(f).status, 'doing');
  assert.match(card(f).result, /built @ abc/);
  assert.equal(f.state.patches.length, 1);
  assert.ok(!('status' in f.state.patches[0]), 'patchTask never sees the status key');
  assert.equal(f.outbox().length, 1, 'the message still lands');
  assert.match(f.memory(), /- built/);
  const again = L.applyLedgerOp(op, f.deps);
  assert.equal(again.body.line, `ok op=b1 card=C-1:doing ${KEPT} msg=ledger-b1.json memory=+7B (already applied)`);
  assert.equal(f.state.patches.length, 1);
});

test("t2: god's patch {status: done} lands and the line says done", () => {
  const f = fixture('god', true);
  const r = L.applyLedgerOp({ op: 'g1', card: { id: 'C-1', patch: { status: 'done' }, appendNote: 'INT landed' } }, f.deps);
  assert.equal(r.body.line, 'ok op=g1 card=C-1:done');
  assert.equal(card(f).status, 'done');
  assert.equal(f.state.patches[0].status, 'done');
});

test('t3: a note-only op never carries a status to patchTask and the line marks the echo (unchanged)', () => {
  const f = fixture('uhera', false, 'done');
  const r = L.applyLedgerOp({ op: 'n1', card: { id: 'C-1', appendNote: 'a note' } }, f.deps);
  assert.equal(r.body.line, 'ok op=n1 card=C-1:done (unchanged)');
  assert.deepEqual(Object.keys(f.state.patches[0]), ['notes']);
  const g = fixture('god', true, 'blocked');
  assert.equal(L.applyLedgerOp({ op: 'n2', card: { id: 'C-1', appendResult: 'r' } }, g.deps).body.line, 'ok op=n2 card=C-1:blocked (unchanged)');
});

test("t4: a builder's create with status done is created as todo, line says status kept; god's create keeps done", () => {
  const f = fixture('creed', false);
  const r = L.applyLedgerOp({ op: 'c1', card: { id: 'NEW-1', create: { title: 'new', status: 'done' }, appendNote: 'n' } }, f.deps);
  assert.equal(r.body.line, `ok op=c1 card=NEW-1:todo ${KEPT}`);
  const t = f.state.tasks.find((x) => x.id === 'NEW-1');
  assert.equal(t.status, 'todo');
  assert.match(t.notes, /n$/);
  const g = fixture('god', true);
  assert.equal(L.applyLedgerOp({ op: 'c2', card: { id: 'NEW-2', create: { title: 'new', status: 'done' } } }, g.deps).body.line, 'ok op=c2 card=NEW-2:done');
  assert.equal(g.state.tasks.find((x) => x.id === 'NEW-2').status, 'done');
});

test("t5: doing, blocked and todo are still the builder's to set (no over-reach); an absent isGod dep means not god", () => {
  for (const s of ['doing', 'blocked', 'todo']) {
    const f = fixture('creed', false, s === 'todo' ? 'doing' : 'todo');
    assert.equal(L.applyLedgerOp({ op: `s-${s}`, card: { id: 'C-1', patch: { status: s } } }, f.deps).body.line, `ok op=s-${s} card=C-1:${s}`);
    assert.equal(card(f).status, s);
  }
  const f = fixture('creed', undefined);
  delete f.deps.isGod;
  assert.equal(L.applyLedgerOp({ op: 'x', card: { id: 'C-1', patch: { status: 'done' } } }, f.deps).body.line, `ok op=x card=C-1:doing ${KEPT}`);
});

test('t6: main wires isGod from the hive registry; ask closure still only READS a done card (mailLedger unchanged)', () => {
  const idx = normaliseEol(fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8'));
  assert.match(idx, /patchTask: \(id, patch\) => hive\.patchTask\(id, patch, 'ledger'\),\n\s*isGod: hive\.isGod\(agentId\),/);
  const ml = normaliseEol(fs.readFileSync(path.join(ROOT, 'src/main/mailLedger.ts'), 'utf8'));
  assert.match(ml, /c\.status === 'done'/, 'ask closure keys on the card being done');
  assert.ok(!/patchTask\(|status: 'done'/.test(ml), 'mailLedger never writes a card status');
});

test('t7: the protocol text no longer teaches builders to patch done, and says who does', () => {
  const hive = normaliseEol(fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8'));
  const start = hive.indexOf('## The ledger command');
  assert.ok(start > 0);
  const section = hive.slice(start, hive.indexOf('## Rules of the road', start));
  assert.ok(!section.includes('"status": "done"'), 'no done patch in the example');
  assert.ok(section.includes('"appendResult": "built @ <sha>; Jim audits"'));
  assert.ok(section.includes('Only god sets \\`status: done\\`'));
  assert.ok(section.includes('(unchanged)'));
});

// ── mutants (each must go red under the tests above; shown here by direct check) ──────────
function mutant(from, to) {
  const file = 'src/main/ledger.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  assert.ok(src.includes(from), `mutant anchor present: ${from}`);
  return loadTs.fromText(file, src.replace(from, to));
}
const GATE = "const doneKept = askedStatus === 'done' && !deps.isGod;";
test("MUTANT M1 (no sender gate): a builder's done lands (t1/t4 catch it)", () => {
  const M = mutant(GATE, 'const doneKept = false;');
  const f = fixture('creed', false);
  M.applyLedgerOp({ op: 'm1', card: { id: 'C-1', patch: { status: 'done' } } }, f.deps);
  assert.equal(card(f).status, 'done');
});
test('MUTANT M2 (no unchanged suffix): the echo reads as a flip (t3 catches it)', () => {
  const M = mutant('`card=${card.id}:${current()} (unchanged)`', '`card=${card.id}:${current()}`');
  const f = fixture('uhera', false, 'done');
  assert.equal(M.applyLedgerOp({ op: 'm2', card: { id: 'C-1', appendNote: 'n' } }, f.deps).body.line, 'ok op=m2 card=C-1:done');
});
test('MUTANT M3 (gate every status): a builder cannot even set doing (t5 catches it)', () => {
  const M = mutant(GATE, 'const doneKept = !!askedStatus && !deps.isGod;');
  const f = fixture('creed', false, 'todo');
  M.applyLedgerOp({ op: 'm3', card: { id: 'C-1', patch: { status: 'doing' } } }, f.deps);
  assert.equal(card(f).status, 'todo');
});
