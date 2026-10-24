'use strict';
require('./tools/own-job.cjs');
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
  assert.equal(MODEL.activityThought(before, rec('IDLE')).text, 'idle', 'not even before the store settles it (d)');
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
const BUBBLE = 'src/renderer/src/scene/office/ThoughtBubble.ts';

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
  assert.match(src, /bubbles\.consumeSays\(crewSays\(freshEvents, packLines(, talk)?\), sayCursor\);/);
  assert.match(src, /const coffee = coffeeProps\(crew, packLines\);/);
});

// (c) The cloud hangs from the sprite as drawn, and neighbours part sideways before anyone towers.
const OFFSET_Y = -38; // ThoughtBubble: the cloud's bottom sits this far above its anchor
const FW = 32, FH = 32;

test('(c) at the real Captain and Speck chairs, on the real sheet, a seated cloud clears the opaque head by the standing gap', () => {
  const A = loadTs('src/renderer/src/scene/themes/cloudAnchor.ts');
  const K = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
  assert.equal(Number(/const OFFSET_Y = (-?\d+);/.exec(readSource(BUBBLE))[1]), OFFSET_Y, 'the cloud offset this test assumes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(TES_DIR)));
  const pk = P.finishPack(r.value, H.decodeImages(TES_DIR, T.normPath, r.value.images), r.diagnostics).value;
  const R = pk.manifest.spriteRenderer, fw = R.frameWidth, fh = R.frameHeight, sheet = pk.store.get(pk.sheet);
  assert.deepEqual([sheet.width, sheet.height, fw, fh], [96, 256, FW, FH], 'themes/tes/art/characters-sheet (1).png');
  // The topmost opaque pixel row of a frame: where the drawn head really starts.
  const headTop = (col, row) => {
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) if (sheet.data[((row * fh + y) * sheet.width + col * fw + x) * 4 + 3] > 0) return y;
    return null;
  };
  const stand = { down: R.rows.down, up: R.rows.up, left: R.rows.left, right: R.rows.right };
  const sit = { down: R.rows.sitDown, up: R.rows.sitUp, left: R.rows.sitLeft, right: R.rows.sitRight };
  const cols = sheet.width / fw;
  assert.deepEqual([stand.down, stand.up, sit.down, sit.up].map((row) => [0, 1, 2].map((c) => headTop(c, row))), [[4, 1, 5], [4, 1, 5], [4, 1, 5], [4, 1, 5]]);
  assert.deepEqual([stand.left, stand.right, sit.left, sit.right].map((row) => [0, 1, 2].map((c) => headTop(c, row))), [[4, 2, 5], [4, 2, 5], [4, 2, 5], [4, 2, 5]]);
  // The gap from the cloud's bottom (ThoughtBubble: OFFSET_Y above the anchor) down to the opaque head.
  const gapOf = (drawn, top) => drawn.y + top - (A.cloudAnchor(drawn, fw, fh).y + OFFSET_Y);
  const plan = K.buildScenePlan({ ...pk.scene, store: pk.store });
  for (const name of ['Captain', 'Speck1', 'Speck2']) {
    const seat = pk.scene.seatOrder.find((s) => s.name === name);
    const ch = K.chairOf(seat, plan.sorted);
    assert.ok(ch && ch.chair, `${name}: the floor finds its chair`);
    for (const dir of ['down', 'up', 'left', 'right']) {
      for (let col = 0; col < cols; col++) {
        const fit = dir === 'left' || dir === 'right' ? K.sideFit(pk.store, ch.chair.B, { sheet, sx: col * fw, sy: sit[dir] * fh, fw, fh }, dir) : null;
        const pose = K.seatPose(ch, dir, fw, fh, fit);
        const drawn = A.drawnSprite({ x: seat.x, y: seat.y, seated: true, seat }, pose, fw, fh, 0);
        const standing = A.drawnSprite({ x: seat.x, y: seat.y, seated: false }, null, fw, fh, 0);
        const what = `${name} ${dir} col ${col}`;
        assert.deepEqual(drawn, { x: Math.round(pose.x - fw / 2), y: Math.round(pose.y) }, `${what}: drawn at the seat pose`);
        const seated = gapOf(drawn, headTop(col, sit[dir])), upright = gapOf(standing, headTop(col, stand[dir]));
        assert.equal(seated, upright, `${what}: the same gap above the head as standing`);
        assert.ok(seated >= 6 && seated <= 11, `${what}: just clear of the head (${seated} px), neither on it nor floating`);
        assert.equal(A.cloudAnchor(drawn, fw, fh).x, drawn.x + fw / 2, `${what}: centred on the drawn frame`);
      }
    }
  }
});

test('(c) the floor draws the sprite and hangs the cloud from the same drawn point', () => {
  const src = readSource(FLOOR);
  // int-1.1.88: with TES-CHAIRS-188 a sprite in a chair (seated or on the seat step) is drawn at the step's slide
  assert.match(src, /const drawn = seat && sd \? slide\(seat, sd\.k\) : drawnSprite\(p, pose, fw, fh, clock\);\s+s\.sprite\.position\.set\(drawn\.x, drawn\.y\);/);
  assert.match(src, /anchor: cloudAnchor\(drawn, fw, fh\)/);
  assert.match(src, /anchors\.push\(\{ id: p\.id, \.\.\.anchor \}\);/);
  assert.doesNotMatch(src, /anchors\.push\(\{ id: p\.id, x: p\.x, y: p\.y \}\)/, 'never the walker point');
});

// The world's transform the layer is handed each frame (here world and screen are the same).
const VIEW = { scale: 1, x: 0, y: 0, resolution: 1 };

function bubbleLayerWith(widths) {
  const made = [];
  class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } destroy() {} }
  class ThoughtBubble {
    constructor() { this.container = new Container(); this.text = null; this.lift = 0; this.pos = null; made.push(this); }
    show(text) { this.text = text; } hide() { this.text = null; } startLinger() { this.text = null; }
    setBounds() {} setView() {} update() {} destroy() {}
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
  layer.update(16, seats.map(([id, , x, y]) => ({ id, x, y })), VIEW);
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
  layer.update(16, [{ id: 'a', x: 300, y: 300 }, { id: 'b', x: 302, y: 300 }], VIEW);
  const [ra, rb] = made.map((b) => b.rect());
  assert.ok(apart(ra, rb), 'the pair never overlaps');
  assert.ok(made.some((b) => b.lift > 0), 'one is lifted');
  assert.ok(ra.x + 6 <= 300 && 300 <= ra.x + ra.w - 6, `a keeps 6 px of itself over its head (${ra.x}..${ra.x + ra.w})`);
  assert.ok(rb.x + 6 <= 302 && 302 <= rb.x + rb.w - 6, `b keeps 6 px of itself over its head (${rb.x}..${rb.x + rb.w})`);
});

// The real ThoughtBubble on a stand-in pixi: a label measures 7 px a character, 14 px high.
function realBubble() {
  class Container {
    constructor() { this.x = 0; this.y = 0; this.alpha = 1; this.visible = true; this.children = []; this.scale = { set: () => {} }; }
    addChild(...c) { this.children.push(...c); return c[0]; } destroy() {}
  }
  class Graphics extends Container {
    constructor() { super(); this.circles = []; }
    clear() { this.circles = []; return this; } roundRect() { return this; } fill() { return this; } stroke() { return this; }
    circle(x, y, r) { this.circles.push({ x, y, r }); return this; }
  }
  class Text extends Container { constructor(o) { super(); this.text = o.text; } get width() { return this.text.length * 7; } get height() { return 14; } }
  const out = ts.transpileModule(readSource(BUBBLE), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const shade = new Proxy({}, { get: () => '#000000' });
  const req = (id) => ({ 'pixi.js': { Container, Graphics, Text }, '@/design/tokens': { colors: new Proxy({}, { get: () => shade }) }, './ToolBubble': { toolIcon: () => '*' } })[id];
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  const b = new mod.exports.ThoughtBubble();
  b.setBounds(960, 640);
  b.setView(VIEW);
  // Where the tail leaves the cloud and where its tip is, in world px (world and screen are the same here).
  return { b, tailX: () => b.container.x + b.tip.circles[0].x, tailIn: () => b.tail.circles[0].x };
}

test('(c) a slid cloud\'s tail stays over the head; it never leaves the cloud', () => {
  const { b, tailX, tailIn } = realBubble();
  b.show('hello there');
  b.setPosition(300, 200);
  const home = tailX();
  for (const slide of [-20, -10, -4, 4, 10]) {
    b.setPosition(300, 200, slide);
    assert.ok(Math.abs(tailX() - home) <= 0.5, `slide ${slide}: the tail stays at ${home} (it is at ${tailX()})`);
  }
  for (const slide of [-60, 60]) {
    b.setPosition(300, 200, slide);
    assert.ok(tailIn() >= 8 && tailIn() <= b.bgW - 8, `slide ${slide}: the tail keeps inside the cloud`);
  }
});

test('(c) unslid, the tail points at the head too, even on the narrow thinking dots (TES-BUBBLE-TAIL-SHARP-189)', () => {
  const { b, tailX, tailIn } = realBubble();
  for (const line of ['', 'a longer line of work']) {
    b.show(line);
    for (const slide of [0, 12]) {
      b.setPosition(300, 200, slide);
      assert.ok(Math.abs(tailX() - 300) <= 0.5, `'${line}' slide ${slide}: the tip is over the head (${tailX()})`);
      assert.ok(tailIn() >= 0 && tailIn() <= b.bgW, `'${line}' slide ${slide}: the tail leaves from under the cloud`);
    }
  }
});

// (b2) Exchanges: both forms read, played in turns between the two, by station, and often.
const X = () => loadTs('src/renderer/src/scene/themes/exchanges.ts');
const CAPTAIN = { id: 'god', role: 'captain' }, HELM = { id: 'dwight', role: 'helm' }, ANY = { id: 'andy', role: null }, ANY2 = { id: 'pam', role: null };
const HELD = new Set(['captain', 'helm', 'navigation']);

test('(b2) the exchange reader takes the viewer\'s arrays and {lines, roles} objects, and skips the malformed', () => {
  const ex = X().readExchanges([
    ['Intriguing.', '…you said that already.'],
    { lines: ['Mr Speck, status?', 'All green.', '…check it again.'], roles: ['Captain', 'science', 'captain'] },
    { lines: ['one', 'two'], roles: ['captain'] },            // roles of the wrong length: dropped, lines kept
    ['only one'], ['a {placeholder}', 'b'], { lines: 'nope' }, 7, ['1', '2', '3', '4', '5']
  ]);
  assert.deepEqual(ex, [
    { lines: ['Intriguing.', '…you said that already.'] },
    { lines: ['Mr Speck, status?', 'All green.', '…check it again.'], roles: ['captain', 'science', 'captain'] },
    { lines: ['one', 'two'] }
  ]);
  assert.deepEqual(X().readExchanges(undefined), []);
});

test('(b2) the TES pack carries its exchanges, and lines still holds only plain categories', () => {
  const r = P.readPack(P.memoryFiles(H.readPackDir(TES_DIR)));
  const raw = require('../themes/tes/lines.json').lines.exchanges;
  assert.equal(r.value.exchanges.length, raw.length);
  assert.ok(r.value.exchanges.every((e) => e.lines.length >= 2 && e.lines.length <= 4));
  assert.equal('exchanges' in r.value.lines, false);
});

test('(b2) an exchange alternates between the two, a beat apart, the same one for the same key', () => {
  const { exchangeSays, EXCHANGE_BEAT_MS } = X();
  const ex = [{ lines: ['A1', 'B1', 'A2', 'B2'] }];
  const says = exchangeSays(ex, ANY, ANY2, HELD, 'k');
  assert.deepEqual(says.map((s) => [s.id, s.text, s.delay]), [['andy', 'A1', 0], ['pam', 'B1', EXCHANGE_BEAT_MS], ['andy', 'A2', 2 * EXCHANGE_BEAT_MS], ['pam', 'B2', 3 * EXCHANGE_BEAT_MS]]);
  assert.equal(new Set(says.map((s) => s.key)).size, 4, 'each line its own key');
  const many = X().readExchanges(require('../themes/tes/lines.json').lines.exchanges);
  assert.deepEqual(exchangeSays(many, ANY, ANY2, HELD, 'x'), exchangeSays(many, ANY, ANY2, HELD, 'x'));
});

test('(b2) roles: the captain\'s lines only from the Captain, a station\'s own lines preferred, the other order tried', () => {
  const { exchangeSays, exchangeFit } = X();
  const ex = [
    { lines: ['Status?', 'Green.'], roles: ['captain', 'helm'] },
    { lines: ['Coffee?', 'Always.'], roles: ['crew', 'crew'] },
    { lines: ['Scan it.', 'Scanning.', 'Well?'], roles: ['science', 'crew', 'science'] }
  ];
  assert.equal(exchangeFit(ex[0], ANY, ANY2, HELD), -1, 'a crewman never says the captain\'s line');
  assert.equal(exchangeFit(ex[2], ANY, ANY2, HELD), 0, 'a crewman may play an unheld station throughout');
  assert.equal(exchangeFit({ lines: ['a', 'b', 'c'], roles: ['science', 'crew', 'medical'] }, ANY, ANY2, HELD), -1, 'but one station only');
  let named = 0;
  for (let i = 0; i < 200; i++) {
    const says = exchangeSays(ex, HELM, CAPTAIN, HELD, `k${i}`);   // the helm opened the chat: the Captain still opens 'Status?'
    if (says[0].text === 'Status?') { named++; assert.deepEqual(says.map((s) => s.id), ['god', 'dwight']); }
    else assert.equal(says[0].text, 'Coffee?');
  }
  assert.ok(named > 120, `the exchange naming their stations is preferred (${named}/200)`);
  assert.equal(exchangeSays([ex[0]], ANY, ANY2, HELD, 'k'), null, 'none fits: the caller keeps its own line');
});

test('(b2) a chat plays an exchange through crewSays, and the floor wires chat, hold and bridge talk', () => {
  const crewSays = crewSaysFn();
  const played = [{ key: 'k#0', id: 'a', text: 'A1', ttl: 2400, delay: 0 }, { key: 'k#1', id: 'b', text: 'B1', ttl: 2400, delay: 2400 }];
  assert.deepEqual(crewSays([{ kind: 'chat', id: 'a', with: 'b', at: 1 }], undefined, () => played), played);
  assert.deepEqual(crewSays([{ kind: 'chat', id: 'a', with: 'b', at: 1 }], undefined, () => null).map((s) => s.text), ['quick sync', 'quick sync'], 'no exchange fits: the old line');
  const src = readSource(FLOOR);
  assert.match(src, /bubbles\.consumeSays\(crewSays\(freshEvents, packLines, talk\), sayCursor\);/);
  assert.match(src, /chatHold: EXCHANGE_HOLD_MS/);
  assert.match(src, /const bridgeSpeakers = \(\) => crew\.walkers\(\)\.filter\(\(p\) => !p\.coffee\)\.map\(speaker\);/);
  assert.match(src, /const bridgeSays = bridgeTalk\.tick\(dt, bridgeSpeakers\);[^\n]*\n\s*if \(bridgeSays\.length\) bubbles\.consumeSays\(bridgeSays, sayCursor\);/);
  assert.match(readSource('src/renderer/src/scene/themes/crew.ts'), /p\.talk = q\.talk = this\.t \+ this\.chatHold;/);
});

test('(b2) a later line waits for its beat in the bubble layer', () => {
  const { layer, made } = bubbleLayerWith({ A1: 40, B1: 40 });
  layer.consumeSays([{ key: 'k#0', id: 'a', text: 'A1', ttl: 2400, delay: 0 }, { key: 'k#1', id: 'b', text: 'B1', ttl: 2400, delay: 2400 }], MODEL.createSayCursor());
  const anchors = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 300, y: 100 }];
  layer.update(16, anchors, VIEW);
  assert.deepEqual(made.map((b) => b.text), ['A1'], 'only the opener so far');
  for (let t = 0; t < 2400; t += 100) layer.update(100, anchors, VIEW);
  assert.equal(made[1]?.text, 'B1', 'the answer on its beat');
});

test('(b2) the bridge talks often: a talk every 20-40 s across ten minutes, never the same two twice running', () => {
  const { BridgeTalk, readExchanges } = X();
  let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ex = readExchanges(require('../themes/tes/lines.json').lines.exchanges);
  const talk = new BridgeTalk(ex, HELD, rand);
  const people = [CAPTAIN, HELM, { id: 'jim', role: 'navigation' }, ANY, ANY2, { id: 'kevin', role: null }];
  let talks = 0, prev = new Set();
  for (let t = 0; t < 600_000; t += 50) {
    const says = talk.tick(50, people);
    if (!says.length) continue;
    talks++;
    const ids = new Set(says.map((s) => s.id));
    assert.ok([...ids].every((id) => !prev.has(id)), 'nobody speaks in two talks running');
    prev = ids;
  }
  assert.ok(talks >= 15 && talks <= 30, `talks in ten minutes: ${talks}`);
  assert.deepEqual(new BridgeTalk([], HELD, rand).tick(60_000, people), [], 'a pack without exchanges never talks');
});

test('(b2) the bridge builds its speakers only when a talk is due, not every frame', () => {
  const { BridgeTalk, readExchanges } = X();
  let seed = 9; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const talk = new BridgeTalk(readExchanges(require('../themes/tes/lines.json').lines.exchanges), HELD, rand);
  let built = 0, talks = 0;
  const people = () => { built++; return [CAPTAIN, HELM, ANY, ANY2]; };
  for (let t = 0; t < 600_000; t += 16) if (talk.tick(16, people).length) talks++;
  assert.ok(talks >= 15, `it still talks (${talks})`);
  assert.equal(built, talks, 'one build per talk');
  const quiet = talk.tick(16, people), again = talk.tick(16, people);
  assert.equal(quiet, again, 'a quiet frame returns the one shared empty list');
});

// (d) Clouds come and go: a change shows one for a few seconds, a long state now and then; most of
// the time most people show none. 'needs you' stays up. The boot note never shows at all.

test('(d) the gate: a change shows a cloud for CLOUD_SHOW_MS, then quiet; a call shows at once; needs-you stays', () => {
  const { createCloudGate, cloudShows, CLOUD_SHOW_MS, CLOUD_QUIET_MS, CLOUD_RESURFACE_MS } = MODEL;
  assert.ok(CLOUD_SHOW_MS >= 2000 && CLOUD_SHOW_MS <= 4000, 'a few seconds');
  assert.ok(CLOUD_RESURFACE_MS[0] >= 20_000 && CLOUD_RESURFACE_MS[1] <= 40_000 && CLOUD_QUIET_MS >= 15_000);
  const g = createCloudGate(), r = () => 0.5;
  const w = (text, status = 'working') => ({ status, text });
  assert.equal(cloudShows(g, 0, w('using Bash'), r), false, 'what is there at first sight is not a change');
  assert.equal(cloudShows(g, 1000, w('using Read'), r), true, 'a new action');
  assert.equal(cloudShows(g, 1000 + CLOUD_SHOW_MS - 1, w('using Read'), r), true);
  assert.equal(cloudShows(g, 1000 + CLOUD_SHOW_MS, w('using Read'), r), false, 'then it goes');
  assert.equal(cloudShows(g, 5000, w('using Edit'), r), false, 'another action inside the quiet waits');
  assert.equal(cloudShows(g, 6000, w('compacting context', 'compacting'), r), true, 'a compaction shows at once');
  assert.equal(cloudShows(g, 9000 + CLOUD_SHOW_MS, w('compacting context', 'compacting'), r), false);
  for (let t = 20_000; t < 600_000; t += 1000) assert.equal(cloudShows(g, t, w('needs you', 'blocked'), r), true, 'needs-you stays up');
  for (const status of ['crashed', 'stuck']) {
    const s = createCloudGate();
    cloudShows(s, 0, w('using Bash'), r);
    for (let t = 1000; t < 300_000; t += 1000) assert.equal(cloudShows(s, t, w(status, status), r), true, `${status} stays up`);
  }
  const queued = createCloudGate();
  cloudShows(queued, 0, w('using Bash'), r);
  assert.equal(cloudShows(queued, 1000, w('using Read'), r), true);
  assert.equal(cloudShows(queued, 2000, w('waiting', 'waiting'), r), true, 'still the action\'s show');
  assert.equal(cloudShows(queued, 1000 + CLOUD_SHOW_MS, w('waiting', 'waiting'), r), false, 'a place in the heavy queue is no call: it does not show again at once');
  const sight = createCloudGate();
  for (let t = 0; t < 10_000; t += 16) assert.equal(cloudShows(sight, t, w('using Bash'), r), false, `first sight does not pop up a frame later (${t} ms)`);
  const idle = createCloudGate();
  cloudShows(idle, 0, w('using Bash'), r);
  let shown = 0;
  for (let t = 1000; t < 600_000; t += 100) shown += cloudShows(idle, t, w('idle', 'idle'), r) ? 1 : 0;
  assert.equal(shown, 0, 'an idle cloud never shows (the crew speak for themselves)');
  const long = createCloudGate();
  cloudShows(long, 0, w('compiling'), r);
  const ups = [];
  for (let t = 0; t < 300_000; t += 100) { const on = cloudShows(long, t, w('compiling'), r); if (on && !(ups.length && ups[ups.length - 1].end === t - 100)) ups.push({ start: t, end: t }); else if (on) ups[ups.length - 1].end = t; }
  assert.ok(ups.length >= 5 && ups.length <= 15, `a long state re-surfaces now and then (${ups.length} in 5 min)`);
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i].start - ups[i - 1].end >= CLOUD_RESURFACE_MS[0] - 100, 'never closer than the resurface gap');
  const mid = CLOUD_RESURFACE_MS[0] + 0.5 * (CLOUD_RESURFACE_MS[1] - CLOUD_RESURFACE_MS[0]);
  for (let i = 1; i < ups.length; i++) assert.ok(Math.abs(ups[i].start - ups[i - 1].end - mid) <= 200, `the gap is counted from the end of the last show (${ups[i].start - ups[i - 1].end} ms, rand 0.5: ${mid})`);
});

test('(d) crashed and stuck (liveness) say so over any hook status', () => {
  const agent = { status: 'working', action: 'using Bash' };
  assert.deepEqual(MODEL.activityThought(agent, rec('CRASHED')), { status: 'crashed', text: 'crashed' });
  assert.deepEqual(MODEL.activityThought(agent, rec('STUCK_WAKE')), { status: 'stuck', text: 'stuck' });
  assert.equal(MODEL.activityThought(agent, rec('BUSY_PROGRESSING')).text, 'using Bash');
});

test('(d) the boot note never shows, before or after the store settles it', () => {
  const before = restored();
  for (const status of ['idle', 'working', 'thinking']) {
    const t = MODEL.activityThought({ ...before, status }, rec(status === 'idle' ? 'IDLE' : 'BUSY_PROGRESSING'));
    assert.notEqual(t.text, 'starting up', `${status}: not the boot note`);
  }
  assert.equal(MODEL.activityThought({ ...before, action: 'using Bash', status: 'working' }).text, 'using Bash', 'a real action still shows');
});

function simLayer() {
  const made = new Map();
  class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } destroy() {} }
  class ThoughtBubble {
    constructor() { this.container = new Container(); this.text = null; this.linger = 0; }
    show(text) { this.text = text; this.linger = 0; } hide() { this.text = null; this.linger = 0; }
    startLinger() { if (this.text !== null) { this.text = null; this.linger = 1500; } }
    setBounds() {} setView() {} setLift() {} setPosition() {} getLayout() { return null; } destroy() {}
    update(dt) { this.linger = Math.max(0, this.linger - dt * 1000); }
    up() { return this.text !== null || this.linger > 0; }
  }
  const out = ts.transpileModule(readSource('src/renderer/src/scene/themes/BubbleLayer.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  let last = null;
  const Bubble = class extends ThoughtBubble { constructor() { super(); made.set(last, this); } };
  const req = (id) => ({ 'pixi.js': { Container }, '../office/ThoughtBubble': { ThoughtBubble: Bubble }, '../office/MessageEnvelope': { MessageEnvelope: class {} }, './bubbleModel': MODEL })[id];
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  let seed = 188; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const layer = new mod.exports.BubbleLayer({ width: 960, height: 640 }, rand);
  return { layer, rand, upOf: (id) => made.get(id)?.up() ?? false, setThought: (id, th) => { last = id; layer.setThought(id, th); } };
}

/** The layer on stand-in bubbles that log every call, with the time it came at. */
function loggedLayer() {
  class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } destroy() {} }
  let now = 0;
  class ThoughtBubble {
    constructor() { this.container = new Container(); this.text = null; this.log = []; }
    show(text) { this.text = text; this.log.push(['show', text, now]); }
    hide() { this.text = null; this.log.push(['hide', null, now]); }
    startLinger() { this.text = null; this.log.push(['linger', null, now]); }
    setBounds() {} setView() {} setLift() {} setPosition() {} getLayout() { return null; } update() {} destroy() {}
  }
  const out = ts.transpileModule(readSource('src/renderer/src/scene/themes/BubbleLayer.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const req = (id) => ({ 'pixi.js': { Container }, '../office/ThoughtBubble': { ThoughtBubble }, '../office/MessageEnvelope': { MessageEnvelope: class {} }, './bubbleModel': MODEL })[id];
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  const layer = new mod.exports.BubbleLayer({ width: 960, height: 640 }, () => 0.5);
  const anchors = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 300, y: 100 }];
  const run = (ms) => { for (let t = 0; t < ms; t += 16) { now += 16; layer.update(16, anchors, VIEW); } };
  return { layer, run, bubble: (id) => layer.thoughts.get(id)?.bubble, now: () => now };
}

test("(d) in the layer, a quiet agent's cloud goes after CLOUD_SHOW_MS and comes back, with no new thought", () => {
  const { CLOUD_SHOW_MS, CLOUD_RESURFACE_MS } = MODEL;
  const { layer, run, bubble, now } = loggedLayer();
  layer.setThought('a', { status: 'working', text: 'using Bash' });
  run(1000);
  assert.deepEqual(bubble('a').log, [], 'what is there at first sight waits its turn');
  layer.setThought('a', { status: 'working', text: 'using Read' });
  const shownAt = now();
  assert.deepEqual(bubble('a').log, [['show', 'using Read', shownAt]], 'a new action shows');
  run(CLOUD_SHOW_MS + 100);   // the agent goes quiet: only the per-frame gate can take it down
  assert.deepEqual(bubble('a').log.slice(1).map(([kind]) => kind), ['linger'], 'it lingers and fades as on the office floor, never cut off');
  const goneAt = bubble('a').log[1][2];
  assert.ok(goneAt - shownAt >= CLOUD_SHOW_MS && goneAt - shownAt <= CLOUD_SHOW_MS + 16, `it goes after CLOUD_SHOW_MS (${goneAt - shownAt} ms)`);
  run(CLOUD_RESURFACE_MS[1] + 1000);
  const back = bubble('a').log.slice(2);
  assert.equal(back[0] && back[0][0], 'show', 'the lasting state comes back by itself');
  assert.ok(back[0][2] - goneAt >= CLOUD_RESURFACE_MS[0], 'not before the resurface gap');
  assert.ok(bubble('a').log.every(([kind]) => kind !== 'hide'), 'never hidden outright');
});

test("(d) a removed agent's queued line never brings its cloud back", () => {
  const { layer, run, bubble } = loggedLayer();
  layer.setThought('b', { status: 'working', text: 'using Bash' });
  layer.say('b', 'Aye, Captain.', { delay: 500 });
  layer.say('a', 'Make it so.', { delay: 500 });
  layer.remove('b');
  run(1500);
  assert.equal(bubble('b'), undefined, 'no bubble for the departed');
  assert.equal(bubble('a').log[0][1], 'Make it so.', 'the other line still plays');
});

test('(d) a floor of 7 for 30 minutes: each shows a cloud under a quarter of the time, needs-you stays up', () => {
  const { layer, rand, upOf, setThought } = simLayer();
  const X = loadTs('src/renderer/src/scene/themes/exchanges.ts');
  const talk = new X.BridgeTalk(X.readExchanges(require('../themes/tes/lines.json').lines.exchanges), new Set(['captain', 'helm', 'navigation']), rand);
  const ids = ['god', 'dwight', 'jim', 'andy', 'pam', 'kevin', 'creed'];
  const state = Object.fromEntries(ids.map((id) => [id, { status: 'working', text: 'using Bash', next: 0 }]));
  state.creed.status = 'blocked'; state.creed.text = 'needs you';
  const cursor = MODEL.createSayCursor(), up = Object.fromEntries(ids.map((id) => [id, 0]));
  const T = 30 * 60_000, DT = 50;
  for (let t = 0; t < T; t += DT) {
    for (const id of ids) {
      const s = state[id];
      if (id !== 'creed' && t >= s.next) {   // a busy agent: a new tool every 1-8 s, now and then thinking, waiting or idle
        const roll = rand();
        s.status = roll < 0.05 ? 'waiting' : roll < 0.15 ? 'idle' : roll < 0.35 ? 'thinking' : 'working';
        s.text = s.status === 'thinking' ? '' : s.status === 'waiting' ? 'waiting' : s.status === 'idle' ? 'idle' : `using ${['Bash', 'Read', 'Edit', 'Grep'][Math.floor(rand() * 4)]}`;
        s.next = t + 1000 + rand() * 7000;
      }
      setThought(id, { status: s.status, text: s.text });
    }
    layer.consumeSays(talk.tick(DT, ids.map((id) => ({ id, role: id === 'god' ? 'captain' : null }))), cursor);
    layer.update(DT, ids.map((id, i) => ({ id, x: 40 * i, y: 100 })), VIEW);
    for (const id of ids) if (upOf(id)) up[id] += DT;
  }
  const share = Object.fromEntries(ids.map((id) => [id, up[id] / T]));
  for (const id of ids.filter((id) => id !== 'creed')) assert.ok(share[id] < 0.25, `${id} shows a cloud ${(share[id] * 100).toFixed(1)}% of the time`);
  const mean = ids.filter((id) => id !== 'creed').reduce((a, id) => a + share[id], 0) / 6;
  assert.ok(mean < 0.2, `on average ${(mean * 100).toFixed(1)}%: ${JSON.stringify(share)}`);
  assert.ok(share.creed > 0.95, `needs-you stays up (${(share.creed * 100).toFixed(1)}%)`);
});

test('(d) the floor hands each cloud its status, so the layer can gate it', () => {
  assert.match(readSource(FLOOR), /bubbles\.setThought\(a\.id, thought \? \{ text: thought\.text, tool: thought\.tool, status: thought\.status \} : null\);/);
});
