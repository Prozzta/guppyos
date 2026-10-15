'use strict';
// TES-BUBBLES-188: the 1.1.87 TES floor kept the restore note 'starting up' in its clouds for
// minutes (for good on a Codex agent with no early hook), never spoke the pack's own lines, and
// drew the clouds of seated people far above their heads at the Speck desks.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const BOOT = loadTs('src/shared/bootAction.ts');
const MODEL = loadTs('src/renderer/src/scene/themes/bubbleModel.ts');

const BOOT_AT = 1_000_000;
const rec = (classification, extra = {}) => ({
  v: 1, agentId: 'dwight', incarnation: 'pty-dwight#6', lifecycle: 'LIVE', classification,
  classifiedSince: BOOT_AT + 42_000, reason: 'quiescent', evidence: { sampledAt: BOOT_AT + 42_000 }, ...extra
});
// The restore shape, exactly as useHive/useRestoreTeam build it.
const restored = () => ({ id: 'dwight', name: 'Dwight', status: 'idle', ...BOOT.bootShape('starting up', BOOT_AT) });

test('(a) the restore shape is {status:"idle", action:"starting up"} and remembers its boot note', () => {
  const a = restored();
  assert.equal(a.status, 'idle');
  assert.equal(a.action, 'starting up');
  assert.deepEqual(a.bootAction, { text: 'starting up', at: BOOT_AT });
});

test('(a) the first settled IDLE reading after the boot retires the note: the cloud says idle', () => {
  const before = restored();
  assert.equal(MODEL.activityThought(before, rec('IDLE')).text, 'starting up', 'the 1.1.87 symptom, before the store settles it');
  const [after] = BOOT.settleBootActions([before], rec('IDLE'));
  assert.equal(after.action, 'idle');
  assert.equal(after.bootAction, undefined);
  assert.equal(MODEL.activityThought(after, rec('IDLE')).text, 'idle');
});

test('(a) a settled BUSY reading retires it to the working "…" (empty text), not the boot note', () => {
  const [after] = BOOT.settleBootActions([restored()], rec('BUSY_PROGRESSING', { reason: 'pty-traffic' }));
  assert.equal(after.action, '');
  assert.equal(MODEL.activityThought(after, rec('BUSY_PROGRESSING')).text, '');
});

test('(a) nothing else retires it: an older incarnation, an unsettled reading, another agent', () => {
  const agents = [restored()];
  for (const r of [
    rec('IDLE', { classifiedSince: BOOT_AT - 1 }),
    rec('UNKNOWN', { reason: 'no-pty' }),
    rec('IDLE', { lifecycle: 'ARCHIVED' }),
    rec('CRASHED'),
    rec('IDLE', { agentId: 'jim' })
  ]) assert.equal(BOOT.settleBootActions(agents, r), agents, `${r.classification}/${r.lifecycle}/${r.agentId}`);
});

test('(a) a real action that replaced the note is never clobbered', () => {
  const agents = [{ ...restored(), action: 'using Bash', status: 'working' }];
  assert.equal(BOOT.settleBootActions(agents, rec('IDLE')), agents);
});

test('(a) every restore and spawn writes the boot shape, and the store settles it on each liveness reading', () => {
  for (const [file, text] of [
    ['src/renderer/src/hooks/useHive.ts', "...bootShape('starting up')"],
    ['src/renderer/src/hooks/useRestoreTeam.ts', "...bootShape(worktreeGone ? 'worktree gone — using base repo' : 'starting up')"],
    ['src/renderer/src/components/AddAgentModal.tsx', "...bootShape(resuming && spawnRes.resumeNotFound ? 'session not found — fresh start' : 'starting up')"]
  ]) {
    const src = readSource(file);
    assert.ok(src.includes(text), `${file} builds its restore shape with bootShape`);
    assert.doesNotMatch(src, /action: [^\n]*'starting up'/, `${file} has no bare 'starting up' action left`);
  }
  const store = readSource('src/renderer/src/store/store.ts');
  const at = store.indexOf('applyLiveness: (rec) =>');
  assert.ok(at > 0, 'the store defines applyLiveness');
  const apply = store.slice(at, store.indexOf('bumpToolCount:', at));
  assert.match(apply, /settleBootActions\(s\.agents, /, 'applyLiveness settles boot notes');
});

// ── (b) the pack's own lines ─────────────────────────────────────────────────

const path = require('node:path');
const ts = require('typescript');
const H = require('./fixtures/themes/pack-helpers.cjs');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const C = loadTs('src/renderer/src/scene/themes/coffeeProps.ts');
const TES_DIR = path.join(__dirname, '..', 'themes', 'tes');
const TES_LINES = require('../themes/tes/lines.json').lines;
const plain = (k) => TES_LINES[k].filter((s) => typeof s === 'string' && !s.includes('{'));
const FLOOR = 'src/renderer/src/scene/themes/StationFloor.tsx';

function crewSaysFn() {
  const source = readSource(FLOOR);
  const file = ts.createSourceFile(FLOOR, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const decl = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'crewSays');
  assert.ok(decl, 'StationFloor defines crewSays');
  const out = ts.transpileModule(`${decl.getText(file)}\nmodule.exports = crewSays;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', out)(mod, mod.exports);
  return mod.exports;
}

test('(b) the TES pack loads its lines.json through manifest.text.lines', () => {
  const r = P.readPack(P.memoryFiles(H.readPackDir(TES_DIR)));
  assert.ok(r.value, JSON.stringify(r.diagnostics));
  const lines = r.value.lines;
  assert.ok(lines, 'PackData carries the pack lines');
  assert.deepEqual(lines.gossip, plain('gossip'));
  assert.deepEqual(lines.water, plain('water'));
  assert.equal(lines.suckUp.some((s) => s.includes('{')), false, 'no {placeholder} line survives');
  assert.equal('exchanges' in lines, false, 'only plain string categories');
});

test('(b) a pack without a lines file, or with a broken one, keeps the generic lines and only warns', () => {
  const files = H.readPackDir(TES_DIR);
  const manifest = JSON.parse(files['theme.json']);
  delete manifest.text;
  const none = P.readPack(P.memoryFiles({ ...files, 'theme.json': JSON.stringify(manifest) }));
  assert.ok(none.value);
  assert.equal(none.value.lines, undefined);
  const broken = P.readPack(P.memoryFiles({ ...files, 'lines.json': '{nope' }));
  assert.ok(broken.value, 'a broken lines file never sinks the pack');
  assert.equal(broken.value.lines, undefined);
  assert.ok(broken.diagnostics.some((d) => d.level === 'warn' && /lines file/.test(d.message)));
});

test('(b) TES chat and errand stops speak the pack lines; without a pack the generic ones', () => {
  const crewSays = crewSaysFn();
  const L = loadTs('src/renderer/src/scene/themes/packLines.ts');
  const pick = L.linePicker(P.readPack(P.memoryFiles(H.readPackDir(TES_DIR))).value.lines);
  const chat = [], errand = [];
  for (let at = 1; at <= 200; at++) {
    chat.push(...crewSays([{ kind: 'chat', id: 'andy', with: 'jim', at }], pick));
    errand.push(...crewSays([{ kind: 'errand', id: 'andy', at }], pick));
  }
  const chatPool = new Set([...plain('gossip'), ...plain('cheer')]);
  const errandPool = new Set(['water', 'window', 'dispenser', 'fridge', 'shelf', 'bin', 'idle'].flatMap(plain));
  assert.ok(chat.every((s) => chatPool.has(s.text)), 'every chat line is a pack gossip/cheer line');
  assert.ok(errand.every((s) => errandPool.has(s.text)), 'every errand line is a pack errand/idle line');
  assert.ok(new Set(chat.map((s) => s.text)).size > 5 && new Set(errand.map((s) => s.text)).size > 10, 'the lines vary');
  assert.ok(errand.some((s) => plain('idle').includes(s.text)), 'an idle thought now and then');
  assert.deepEqual(crewSays([{ kind: 'errand', id: 'a', at: 7 }], pick), crewSays([{ kind: 'errand', id: 'a', at: 7 }], pick), 'stable per event');
  assert.deepEqual(crewSays([{ kind: 'chat', id: 'a', with: 'b', at: 1 }]).map((s) => s.text), ['quick sync', 'quick sync']);
  assert.deepEqual(crewSays([{ kind: 'errand', id: 'a', at: 1 }]).map((s) => s.text), ['stepping away']);
  assert.deepEqual(crewSays([{ kind: 'gaveUp', id: 'a', at: 1 }], pick).map((s) => s.text), ['back to work']);
});

test('(b) the coffee beats speak the pack coffee lines when it has them', () => {
  const L = loadTs('src/renderer/src/scene/themes/packLines.ts');
  const pick = L.linePicker({ brewing: ['tea, Earl Grey, hot'], refill: ['topping up'], coffee: ['raktajino'] });
  const walker = (o) => ({ id: 'a', x: 50, y: 60, dir: 'down', seated: false, cup: false, mug: null, coffee: null, homeSit: false, sip: 0, status: 'idle', ...o });
  const brewing = { spot: [1, 1], phase: 'brewing', t: 100, until: 0 };
  const fake = (people, events = []) => ({ walkers: () => people, mugAt: () => [0, 0], events, t: 1000 });
  assert.equal(C.coffeeProps(fake([walker({ coffee: brewing })]), pick)[0].text, 'tea, Earl Grey, hot');
  assert.equal(C.coffeeProps(fake([walker({ coffee: brewing, cup: true })]), pick).find((x) => x.kind === 'say').text, 'topping up');
  const sip = { spot: [1, 1], phase: 'sipping', t: 0, until: 9000 };
  assert.equal(C.coffeeProps(fake([walker({ coffee: sip, cup: true })], [{ kind: 'sip', id: 'a', at: 900 }]), pick).find((x) => x.kind === 'say').text, 'raktajino');
  assert.equal(C.coffeeProps(fake([walker({ coffee: brewing })]))[0].text, 'brewing a fresh one ☕', 'generic without a pack');
});

test('(b) the floor hands the pack lines to the crew and coffee speech', () => {
  const src = readSource(FLOOR);
  assert.match(src, /const packLines = linePicker\(pack\.lines\);/);
  assert.match(src, /bubbles\.consumeSays\(crewSays\(freshEvents, packLines\), sayCursor\);/);
  assert.match(src, /const coffee = coffeeProps\(crew, packLines\);/);
});
