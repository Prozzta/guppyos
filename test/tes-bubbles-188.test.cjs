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

// (c) The cloud hangs from the sprite as drawn, and neighbours part sideways before anyone towers.
const OFFSET_Y = -38; // ThoughtBubble: the cloud's bottom sits this far above its anchor
const FW = 32, FH = 32;

test('(c) a seated cloud keeps the standing gap above the drawn head, in every seat pose', () => {
  const A = loadTs('src/renderer/src/scene/themes/cloudAnchor.ts');
  const K = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const gapOf = (drawn) => drawn.y - (A.cloudAnchor(drawn, FW, FH).y + OFFSET_Y);
  const standing = A.drawnSprite({ x: 464, y: 226, seated: false }, null, FW, FH, 0);
  const want = gapOf(standing);
  assert.equal(want, 6, 'standing: the cloud bottom is 6 px above the head');
  // The Speck desks: a chair whose drawn sitter is 16-30 px off the walker's point in 1.1.87.
  const chair = { chair: { top: 216, x0: 432, x1: 464 } };
  for (const dir of ['down', 'up', 'left', 'right']) {
    const pose = K.seatPose(chair, dir, FW, FH, null);
    const p = { x: 448, y: 226, seated: true, seat: { x: 448, y: 226 } };
    const drawn = A.drawnSprite(p, pose, FW, FH, 0);
    assert.deepEqual(drawn, { x: Math.round(pose.x - FW / 2), y: Math.round(pose.y) }, `${dir}: drawn at the seat pose`);
    assert.equal(gapOf(drawn), want, `${dir}: the same gap as standing`);
    assert.equal(A.cloudAnchor(drawn, FW, FH).x, drawn.x + FW / 2, `${dir}: centred on the drawn frame`);
    assert.notEqual(A.cloudAnchor(drawn, FW, FH).y, p.y, `${dir}: not the walker's point`);
  }
});

test('(c) the floor draws the sprite and hangs the cloud from the same drawn point', () => {
  const src = readSource(FLOOR);
  assert.match(src, /const drawn = drawnSprite\(p, pose, fw, fh, clock\);\s+s\.sprite\.position\.set\(drawn\.x, drawn\.y\);/);
  assert.match(src, /anchor: cloudAnchor\(drawn, fw, fh\)/);
  assert.match(src, /anchors\.push\(\{ id: p\.id, \.\.\.anchor \}\);/);
  assert.doesNotMatch(src, /anchors\.push\(\{ id: p\.id, x: p\.x, y: p\.y \}\)/, 'never the walker point');
});

function bubbleLayerWith(widths) {
  const made = [];
  class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } destroy() {} }
  class ThoughtBubble {
    constructor() { this.container = new Container(); this.text = null; this.lift = 0; this.pos = null; made.push(this); }
    show(text) { this.text = text; } hide() { this.text = null; } startLinger() { this.text = null; }
    setBounds() {} setZoom() {} update() {} destroy() {}
    setLift(px) { this.lift = px; }
    setPosition(px, py, slide = 0) { this.pos = [px + slide, py]; this.slide = slide; }
    getLayout(px, py) { if (this.text === null) return null; const w = widths[this.text], h = 16; return { x: px - w / 2, y: py + OFFSET_Y - h, w, h }; }
    rect() { const w = widths[this.text], h = 16; return { x: this.pos[0] - w / 2, y: this.pos[1] + OFFSET_Y - h - this.lift, w, h }; }
  }
  const out = ts.transpileModule(readSource('src/renderer/src/scene/themes/BubbleLayer.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const req = (id) => {
    if (id === 'pixi.js') return { Container };
    if (id === '../office/ThoughtBubble') return { ThoughtBubble };
    if (id === '../office/MessageEnvelope') return { MessageEnvelope: class {} };
    if (id === './bubbleModel') return MODEL;
    throw new Error(`unexpected module ${id}`);
  };
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  return { layer: new mod.exports.BubbleLayer({ width: 960, height: 640 }), made };
}

const apart = (a, b) => a.x + a.w + 4 <= b.x || b.x + b.w + 4 <= a.x || a.y + a.h + 4 <= b.y || b.y + b.h + 4 <= a.y;

test('(c) the Speck1/Speck2/Captain clouds part sideways, none towers, each stays over its head', () => {
  // The 1.1.87 render: the Captain (god) and both Speck desks, anchors at the drawn sprites' foot lines.
  const { layer, made } = bubbleLayerWith({ 'captain log': 58, 'Speck one': 68, 'Speck two': 58 });
  const seats = [['god', 'captain log', 464, 192], ['dwight', 'Speck one', 448, 242], ['jim', 'Speck two', 480, 242]];
  for (const [id, text] of seats) layer.setThought(id, { text });
  layer.update(16, seats.map(([id, , x, y]) => ({ id, x, y })), 1);
  const rects = made.map((b) => b.rect());
  made.forEach((b, i) => assert.equal(b.lift, 0, `${seats[i][0]}: not lifted`));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(apart(rects[i], rects[j]), `${seats[i][0]}/${seats[j][0]} do not overlap`);
  rects.forEach((r, i) => assert.ok(r.x + 6 <= seats[i][2] && seats[i][2] <= r.x + r.w - 6, `${seats[i][0]}: still over its head`));
  assert.ok(made.some((b) => b.slide !== 0), 'the slide is handed to the cloud, so its tail can keep to the head');
});

test('(c) what sliding cannot part is still lifted clear', () => {
  const { layer, made } = bubbleLayerWith({ one: 60, two: 60 });
  layer.setThought('a', { text: 'one' });
  layer.setThought('b', { text: 'two' });
  layer.update(16, [{ id: 'a', x: 300, y: 300 }, { id: 'b', x: 302, y: 300 }], 1);
  const [ra, rb] = made.map((b) => b.rect());
  assert.ok(apart(ra, rb), 'the pair never overlaps');
  assert.ok(made.some((b) => b.lift > 0), 'one is lifted');
});
