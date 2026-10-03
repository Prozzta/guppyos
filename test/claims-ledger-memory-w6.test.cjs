'use strict';
/**
 * CLAIM-LEDGER W6, gate G6.6 (second half): the `ledger` command's memory part lands as a claim.
 * At the effective level 'writer' memory.md is a generated view, so the memory part is ONE claim
 * through the endpoint's note verb with origin 'ledger-route' (god 6c4d4e ruling 3):
 *   - over 400 characters refuses the WHOLE op before anything is written, and says to split it;
 *   - a lesson is a pinned 'lesson' claim; memory.md is never touched;
 *   - the claim id is recorded for the op, so a retry notes nothing twice;
 *   - a refused claim is a 'partial' reply; the same op finishes it, the card is not re-applied;
 *   - below 'writer' (or with no ledger wired) the memory part is appended to memory.md as before.
 * End to end with W1's real ClaimStore and handleClaimVerb. All text is invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-ledger-w6-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
const STORES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const ROOT = path.join(__dirname, '..');
const L = loadTs(path.join(ROOT, 'src/main/ledger.ts'));
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { handleClaimVerb } = loadTs(path.join(ROOT, 'src/main/claims/endpoint.ts'));

const MEMORY = '# Invented memory\n\n## How I work (standing lessons)\n- an invented lesson\n\n## 2026-10-01 notes\n- an invented note\n';
let n = 0;
function fixture(level = 'writer', { refuseNotes = 0 } = {}) {
  const root = path.join(JAIL, `hive-${++n}`);
  const agentDir = path.join(root, 'agents', 'ag-1');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory.md'), MEMORY);
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-userdata`, KEY_RECORD_FILE)), now: () => new Date('2026-10-03T10:00:00Z'), log: () => {}, alert: () => {} });
  STORES.push(store);
  const d = { store, level: () => level };
  const calls = [];
  let refuse = refuseNotes;
  const state = { tasks: [{ id: 'CARD-1', title: 'invented', status: 'todo', dependsOn: [], priority: 1, createdAt: 'x' }], patches: 0 };
  const deps = {
    agentId: 'ag-1', agentDir,
    isRecipient: (to) => to === 'god',
    readTasks: () => state.tasks.map((t) => ({ ...t })),
    addTask: () => false,
    patchTask: (id, patch) => { const i = state.tasks.findIndex((x) => x.id === id); if (i < 0) return false; state.tasks[i] = { ...state.tasks[i], ...patch, id }; state.patches += 1; return true; },
    now: () => new Date('2026-10-03T10:00:00Z'),
    // as main wires it (index.ts ledgerMemoryClaim): the note verb, origin 'ledger-route'
    memoryClaim: {
      level,
      note: async (args) => {
        calls.push(args);
        if (refuse > 0) { refuse -= 1; return { ok: false, error: 'an invented refusal' }; }
        const r = await handleClaimVerb(d, 'ag-1', { cmd: 'note', args }, 'ledger-route');
        return { ok: r.ok, ...(r.json && r.json.id ? { id: r.json.id } : {}), ...(r.error ? { error: r.error } : {}) };
      }
    }
  };
  const claims = () => {
    const dir = path.join(agentDir, 'memory', 'claims');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.t === 'claim');
  };
  const outbox = () => { try { return fs.readdirSync(path.join(agentDir, 'outbox')).filter((f) => f.endsWith('.json')); } catch { return []; } };
  const memory = () => fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8');
  return { deps, state, calls, claims, outbox, memory };
}
const op = (name, memory, extra = {}) => ({ op: name, card: { id: 'CARD-1', patch: { status: 'doing' }, appendNote: 'an invented note' }, message: { to: 'god', act: 'inform', subject: 'invented', body: 'invented' }, memory, ...extra });

test('writer: the memory part is one fact claim (origin ledger-route, source self); memory.md is untouched', async () => {
  const f = fixture();
  const r = await L.applyLedgerOp(op('w-1', { append: '- 2026-10-03 an invented fact about the gizmo\n' }), f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.match(r.body.line, /^ok op=w-1 card=CARD-1:doing msg=ledger-w-1\.json memory=claim \S+$/);
  assert.equal(f.memory(), MEMORY);
  const c = f.claims();
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'fact');
  assert.equal(c[0].text, '- 2026-10-03 an invented fact about the gizmo');
  assert.ok(!c[0].legacy && (c[0].source === undefined || c[0].source === 'self'), JSON.stringify(c[0]));
  assert.ok(r.body.line.endsWith(c[0].id));
});

test('writer: a lesson is a pinned lesson claim, and needs no How I work section in the generated memory.md', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.deps.agentDir, 'memory.md'), '<!-- generated -->\n# a generated view\n');
  const r = await L.applyLedgerOp(op('w-2', { append: '- an invented standing lesson', lesson: true }), f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.match(r.body.line, /memory=claim \S+ \(lesson\)$/);
  const c = f.claims();
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'lesson');
  assert.equal(c[0].pin, true);
});

test('writer: over 400 characters refuses the WHOLE op before any write, and says to split it (never cut)', async () => {
  const f = fixture();
  const long = `- ${'an invented clause, '.repeat(21)}`;
  assert.ok([...long.trim()].length > 400);
  const r = await L.applyLedgerOp(op('w-3', { append: long }), f.deps);
  assert.equal(r.status, 400);
  assert.match(r.body.line, /refused: memory\.append is \d+ characters.*at most 400 characters \(never cut\): split it/);
  assert.equal(f.state.patches, 0, 'no card write');
  assert.deepEqual(f.outbox(), [], 'no message');
  assert.equal(f.calls.length, 0, 'no claim attempt');
  assert.equal(f.claims().length, 0);
  assert.equal(f.memory(), MEMORY);
  // exactly 400 is accepted (code points, as the store counts them)
  const at400 = `- ${'x'.repeat(397)}é`;
  assert.equal([...at400].length, 400);
  assert.equal((await L.applyLedgerOp(op('w-3b', { append: at400 }), f.deps)).status, 200);
});

test('writer: a retry of the same op notes nothing twice', async () => {
  const f = fixture();
  const o = op('w-4', { append: '- an invented fact noted once' });
  assert.equal((await L.applyLedgerOp(o, f.deps)).status, 200);
  const again = await L.applyLedgerOp(o, f.deps);
  assert.equal(again.status, 200);
  assert.match(again.body.line, /\(already applied\)$/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.claims().length, 1);
});

test('writer: a refused claim is a partial reply; the same op finishes it without re-applying the card or message', async () => {
  const f = fixture('writer', { refuseNotes: 1 });
  const o = op('w-5', { append: '- an invented fact refused once' });
  const first = await L.applyLedgerOp(o, f.deps);
  assert.equal(first.status, 500);
  assert.match(first.body.line, /^partial: card=CARD-1:doing msg=ledger-w-5\.json; memory failed \(the claim was refused: an invented refusal\)\. Run the same op again/);
  assert.equal(f.state.patches, 1);
  const second = await L.applyLedgerOp(o, f.deps);
  assert.equal(second.status, 200, second.body.line);
  assert.equal(f.state.patches, 1, 'the card is not patched twice');
  assert.deepEqual(f.outbox(), ['ledger-w-5.json']);
  assert.equal(f.claims().length, 1);
  assert.equal(f.memory(), MEMORY);
});

for (const level of ['reader', 'shadow', 'off']) {
  test(`below writer (${level}): the memory part is appended to memory.md as before, and no claim is noted`, async () => {
    const f = fixture(level);
    const r = await L.applyLedgerOp(op(`l-${level}`, { append: '- an invented note for memory.md' }), f.deps);
    assert.equal(r.status, 200);
    assert.match(r.body.line, /memory=\+\d+B$/);
    assert.ok(f.memory().endsWith('- an invented note for memory.md\n'));
    assert.equal(f.calls.length, 0);
    // and below writer a long note is not limited to 400 (memory.md is still the agent's own)
    const long = `- ${'an invented clause, '.repeat(30)}`;
    assert.equal((await L.applyLedgerOp(op(`l2-${level}`, { append: long }), f.deps)).status, 200);
  });
}

test('no ledger wired (memoryClaim null): unchanged behaviour, and the reply is synchronous', () => {
  const f = fixture();
  const r = L.applyLedgerOp(op('n-1', { append: '- an invented note' }), { ...f.deps, memoryClaim: null });
  assert.ok(!(r instanceof Promise));
  assert.equal(r.status, 200);
  assert.ok(f.memory().endsWith('- an invented note\n'));
});

test('main wiring: the ledger handler passes the note verb with origin ledger-route; hooks awaits an async reply', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  assert.match(idx, /memoryClaim: ledgerMemoryClaim\(agentId\)/);
  assert.match(idx, /handleClaimVerb\(d, agentId, \{ cmd: 'note', args \}, 'ledger-route'\)/);
  assert.doesNotMatch(idx.slice(idx.indexOf('function ledgerMemoryClaim')), /w6-internal/);
  const hooks = fs.readFileSync(path.join(ROOT, 'src/main/hooks.ts'), 'utf8');
  assert.match(hooks, /Promise\.resolve\(handler\(agentId, body\)\)\.then/);
});
