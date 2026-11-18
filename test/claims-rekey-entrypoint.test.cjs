'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-REKEY-ENTRYPOINT-108: god's command for the Human rekey. Before this card the key-missing
 * alerts said "ask god to run it" and no code path reached ClaimStore.rekey().
 *   E1 the entry point exists: the CLI parses `rekey --floor <hive folder>`, main routes the action to
 *      RekeyCommand, and RekeyCommand is the only caller of rekey() under src/main. (Red on a3b89793.)
 *   E2 the real rekey: a floor whose key is gone, a real ClaimStore in a jailed user-data folder, the
 *      Human's yes: one rekey line on each ledger, the reply names each ledger, and the floor verifies.
 *   E3 no confirmation, no rekey: a no, a closed dialog (undefined), an answer that is not exactly
 *      true, and no answer in time each write nothing.
 *   E4 only god, only this floor, one at a time: each refusal comes before the Human is asked.
 *   E5 through the real CLI over HTTP: the output lists each ledger; a refusal exits 1.
 *   E6 a ledger the rekey refuses is reported by name and the command says it is not complete.
 *   E7 both alert texts and COMMANDS.md name the exact command; a hidden run never confirms.
 *   E8 one append fails: no ledger is reported as rekeyed. E9 the CLI: exit 5 and the timeout line.
 * Then a mutant census over rekeyCommand.ts (M1-M9), each killed by the case it names.
 * Synthetic floors in temp dirs only. HOME, USERPROFILE and APPDATA are jailed and asserted before any
 * product code loads; the live key and %APPDATA% are never read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-rekey-entry-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.APPDATA = path.join(JAIL, 'appdata');
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) { try { s.close(); } catch { /* closed */ } }
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const ROOT = path.join(__dirname, '..');
const RC = 'src/main/claims/rekeyCommand.ts';
const K = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const S = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const REAL = fs.existsSync(path.join(ROOT, RC)) ? loadTs(path.join(ROOT, RC)) : null;
const cli = require('../resources/claims-cli.cjs');
const lf = (file) => readSource(file).split('\r\n').join('\n');

const fakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s),
  decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return t.slice(4); },
});
let n = 0;
function userData() {
  const ud = path.join(JAIL, `userdata-${++n}`);
  fs.mkdirSync(ud, { recursive: true });
  return {
    keyFile: path.join(ud, K.MAC_KEY_FILE),
    keys: new K.SafeStorageKeyProvider(path.join(ud, K.MAC_KEY_FILE), fakeSafe()),
    record: new K.FileLedgerKeyRecord(path.join(ud, K.KEY_RECORD_FILE)),
    anchors: new K.FileHeadAnchorStore(path.join(ud, K.HEAD_ANCHOR_FILE)),
  };
}
function open(root, u) {
  let t = Date.parse('2026-11-17T08:00:00Z');
  const store = new S.ClaimStore({ hiveRoot: root, keys: u.keys, keyRecord: u.record, headAnchor: u.anchors, now: () => new Date(t += 1000), alert: () => {}, log: () => {} });
  STORES.push(store);
  return store;
}
const AGENTS = ['andy', 'dwight'];
/** A floor whose ledgers were written under a key that is gone, opened on a user-data folder with no key. */
async function lostFloor() {
  const root = path.join(JAIL, `FLOOR-${++n}`, 'hive');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const old = open(root, userData());
  for (const a of AGENTS) {
    const r = await old.appendRecord(a, { t: 'claim', kind: 'fact', text: `${a} before the key was lost` }, 'endpoint');
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  old.close();
  const u = userData();
  const store = open(root, u);
  for (const a of AGENTS) assert.equal(store.readLedger(a).chain.reason, 'key-missing', `${a} starts key-missing`);
  return { root, u, store };
}
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out.sort();
}
/** Every byte under the floor's agents folder: "nothing was written" is an equality on this. */
const snapshot = (root) => filesUnder(path.join(root, 'agents')).map((f) => `${f}\n${fs.readFileSync(f).toString('base64')}`).join('\n');
function rekeyLines(root, agent) {
  const lines = [];
  for (const f of filesUnder(path.join(root, 'agents', agent))) {
    if (!f.endsWith('.jsonl')) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r = null; try { r = JSON.parse(l); } catch { /* not a record */ }
      if (r && r.t === 'event' && r.ev === 'rekey') lines.push(r);
    }
  }
  return lines;
}
/** The command as main wires it, with the Human's answer and the clock in the test's hands. */
function command(mod, f, over = {}) {
  const asked = [];
  const logs = [];
  const timers = [];
  const cmd = new mod.RekeyCommand({
    isGod: (id) => id === 'god',
    floorRoot: () => f.root,
    store: () => f.store,
    confirm: async (q, signal) => { asked.push({ q, signal }); return true; },
    log: (row) => logs.push(row),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    ...over,
  });
  return { cmd, asked, logs, timers };
}

const CASES = [];
const kase = (id, what, fn) => CASES.push([id, what, fn]);

kase('E2', 'the real rekey writes one rekey line on each ledger, on the Human\'s yes', async (mod) => {
  const f = await lostFloor();
  const c = command(mod, f);
  const r = await c.cmd.handle('god', { action: 'rekey', floor: f.root });
  assert.equal(r.status, 200, `E2: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true, 'E2: ok');
  assert.deepEqual([...r.body.lines].sort(), AGENTS.map((a) => `rekeyed: ${a}`), 'E2: one line per ledger');
  const keyId = f.u.keys.load().keyId;
  assert.equal(r.body.line, `rekey complete: 2 ledgers rekeyed under key ${keyId}`, 'E2: the summary names the key');
  for (const a of AGENTS) {
    const lines = rekeyLines(f.root, a);
    assert.equal(lines.length, 1, `E2: ${a} has exactly one rekey line`);
    assert.equal(lines[0].by, 'human', `E2: ${a}'s rekey line is the Human's`);
    assert.equal(lines[0].keyId, keyId, `E2: ${a}'s rekey line names the key`);
  }
  f.store.close();
  const again = open(f.root, f.u);
  for (const a of AGENTS) assert.equal(again.readLedger(a).chain, 'ok', `E2: ${a} verifies after the rekey`);
  assert.equal((await again.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'after the rekey' }, 'endpoint')).ok, true, 'E2: the floor writes again');
  // The Human was asked once, about this floor, by name of the asker; the timer was armed and cleared.
  assert.equal(c.asked.length, 1, 'E2: the Human is asked once');
  assert.ok(c.asked[0].q.detail.includes(`Floor: ${f.root}`), 'E2: the dialog names the floor');
  assert.ok(c.asked[0].q.detail.includes('Asked by: god'), 'E2: the dialog names who asked');
  assert.equal(c.asked[0].q.ok, 'Rekey this floor');
  assert.deepEqual(c.timers.map((t) => [t.ms, t.cleared]), [[mod.REKEY_CONFIRM_MS, true]], 'E2: the answer timer is armed and cleared');
  assert.deepEqual(c.logs.map((l) => l.step), ['asked', 'ran'], 'E2: both steps are logged');
});

kase('E3-no', 'a no, a closed dialog and a throwing dialog write nothing', async (mod) => {
  const f = await lostFloor();
  const before = snapshot(f.root);
  for (const [name, answer] of [['no', async () => false], ['closed', async () => undefined], ['throws', async () => { throw new Error('no window'); }]]) {
    const c = command(mod, f, { confirm: answer });
    const r = await c.cmd.handle('god', { action: 'rekey', floor: f.root }).catch((e) => ({ threw: e }));
    if (name === 'throws') assert.ok(r.threw, 'E3-no: a dialog that throws is an error, not a yes');
    else {
      assert.equal(r.status, 409, `E3-no ${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.line, 'refused: the Human did not confirm. Nothing was written.', `E3-no ${name}`);
      assert.deepEqual(c.logs.map((l) => l.step), ['asked', 'declined'], `E3-no ${name}: logged`);
    }
    assert.equal(snapshot(f.root), before, `E3-no ${name}: not a byte changed`);
    assert.equal(fs.existsSync(f.u.keyFile), false, `E3-no ${name}: no key was made`);
    // And the command is free again: a refusal never leaves it "busy".
    const next = await command(mod, f, { confirm: async () => false }).cmd.handle('god', { floor: f.root });
    assert.equal(next.status, 409);
  }
});

kase('E3-true', 'only exactly true is a yes', async (mod) => {
  const f = await lostFloor();
  const before = snapshot(f.root);
  for (const answer of ['yes', 1, {}, 'true']) {
    const r = await command(mod, f, { confirm: async () => answer }).cmd.handle('god', { floor: f.root });
    assert.equal(r.status, 409, `E3-true ${JSON.stringify(answer)}: ${JSON.stringify(r.body)}`);
    assert.equal(snapshot(f.root), before, `E3-true ${JSON.stringify(answer)}: not a byte changed`);
  }
});

kase('E3-late', 'no answer in time is a no, even if a yes arrives afterwards', async (mod) => {
  const f = await lostFloor();
  const before = snapshot(f.root);
  let aborted = null;
  const c = command(mod, f);
  const cmd = new mod.RekeyCommand({
    isGod: () => true, floorRoot: () => f.root, store: () => f.store, log: (row) => c.logs.push(row),
    setTimer: (fn, ms) => { const t = { fn, ms }; c.timers.push(t); return t; }, clearTimer: () => {},
    // The dialog is still open when the time runs out; the late click says yes.
    confirm: async (q, signal) => { c.timers[0].fn(); aborted = signal.aborted; return true; },
  });
  const r = await cmd.handle('god', { floor: f.root });
  assert.equal(aborted, true, 'E3-late: the time running out aborts the dialog');
  assert.equal(c.timers[0].ms, 5 * 60_000, 'E3-late: the Human has five minutes');
  assert.equal(r.status, 409, `E3-late: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.line, 'refused: the Human did not answer within 5 minutes. Nothing was written.');
  assert.deepEqual(c.logs.map((l) => l.step), ['asked', 'unanswered']);
  assert.equal(snapshot(f.root), before, 'E3-late: not a byte changed');
});

kase('E4-god', 'an agent that is not god is refused before the Human is asked', async (mod) => {
  const f = await lostFloor();
  const before = snapshot(f.root);
  const c = command(mod, f);
  const r = await c.cmd.handle('jim', { action: 'rekey', floor: f.root });
  assert.equal(r.status, 403, `E4-god: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.line, 'refused: claims rekey is god-only');
  assert.equal(c.asked.length, 0, 'E4-god: the Human is not asked');
  assert.equal(snapshot(f.root), before, 'E4-god: not a byte changed');
});

kase('E4-floor', 'another floor, or no floor, is refused before the Human is asked', async (mod) => {
  const f = await lostFloor();
  const before = snapshot(f.root);
  const c = command(mod, f);
  const other = path.join(JAIL, 'FLOOR-other', 'hive');
  const r = await c.cmd.handle('god', { floor: other });
  assert.equal(r.status, 409, `E4-floor: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.line.startsWith(`refused: ${other} is not the floor this Guppy runs (${f.root}).`), r.body.line);
  for (const body of [{}, { floor: '' }, { floor: '   ' }, { floor: 7 }, null, [f.root], { floor: 'x'.repeat(1025) }]) {
    const m = await c.cmd.handle('god', body);
    assert.equal(m.status, 400, `E4-floor ${JSON.stringify(body).slice(0, 40)}`);
    assert.equal(m.body.line, 'refused: name the floor: claims rekey --floor <hive folder>');
  }
  assert.equal(c.asked.length, 0, 'E4-floor: the Human is not asked');
  assert.equal(snapshot(f.root), before, 'E4-floor: not a byte changed');
  // No hive, or no claim ledger up: refused the same way.
  for (const over of [{ floorRoot: () => null }, { store: () => null }]) {
    const x = command(mod, f, over);
    const m = await x.cmd.handle('god', { floor: f.root });
    assert.equal(m.status, 409);
    assert.equal(m.body.line, 'refused: no active hive with a claim ledger');
    assert.equal(x.asked.length, 0);
  }
  // The same folder spelled another way is this floor (a trailing separator; case on Windows).
  const spelled = command(mod, f, { confirm: async () => false });
  assert.equal((await spelled.cmd.handle('god', { floor: f.root + path.sep })).body.line, 'refused: the Human did not confirm. Nothing was written.');
  const win = command(mod, { root: 'C:\\Floor\\hive', store: f.store }, { platform: 'win32', confirm: async () => false });
  if (process.platform === 'win32') assert.equal((await win.cmd.handle('god', { floor: 'c:/floor/HIVE/' })).body.line, 'refused: the Human did not confirm. Nothing was written.');
  // Jim NIT a: the same folder reached through a link is this floor; a link to another folder is not.
  const link = path.join(JAIL, `link-${++n}`);
  fs.symlinkSync(f.root, link, 'junction');
  const elsewhere = path.join(JAIL, `link-${++n}`);
  fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(other, elsewhere, 'junction');
  try {
    assert.equal((await spelled.cmd.handle('god', { floor: link })).body.line, 'refused: the Human did not confirm. Nothing was written.', 'E4-floor: a link to this floor is this floor');
    const wrong = command(mod, f);
    assert.ok((await wrong.cmd.handle('god', { floor: elsewhere })).body.line.startsWith(`refused: ${elsewhere} is not the floor this Guppy runs (${f.root}).`));
    assert.equal(wrong.asked.length, 0);
  } finally { fs.unlinkSync(link); fs.unlinkSync(elsewhere); }
  assert.equal(snapshot(f.root), before, 'E4-floor: not a byte changed');
});

kase('E8', 'one ledger\'s rekey append fails: no ledger is reported as rekeyed, and a retry completes', async (mod) => {
  const f = await lostFloor();
  const real = f.store.writeLine;
  f.store.writeLine = async function (agent, ...rest) { return agent === 'dwight' ? { ok: false, error: 'the disk said no' } : real.call(this, agent, ...rest); };
  const c = command(mod, f);
  const r = await c.cmd.handle('god', { floor: f.root });
  f.store.writeLine = real;
  assert.equal(r.status, 409, `E8: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
  assert.equal(rekeyLines(f.root, 'andy').length, 1, 'E8: the fixture of this case: andy\'s line WAS written');
  assert.deepEqual(r.body.lines.filter((l) => l.startsWith('rekeyed:')), [], `E8: nothing is reported as rekeyed: ${r.body.lines}`);
  assert.deepEqual([...r.body.lines].sort(), [
    'refused: andy (not in effect: the key id was not recorded (the rekey append of another ledger failed), retry the rekey)',
    'refused: dwight (the rekey append failed)',
  ]);
  assert.equal(r.body.line, 'rekey not in effect: the new key id was not recorded, so every ledger stays read-only (2 refused). Retry the rekey.');
  assert.deepEqual(r.body.result.rekeyed, []);
  assert.equal(r.body.result.recorded, false);
  for (const a of AGENTS) assert.equal(f.store.readLedger(a).chain.reason, 'key-missing', `E8: ${a} is still read-only, as the lines say`);
  const again = await command(mod, f).cmd.handle('god', { floor: f.root });
  assert.equal(again.status, 200, `E8 retry: ${JSON.stringify(again.body)}`);
  assert.deepEqual([...again.body.lines].sort(), AGENTS.map((a) => `rekeyed: ${a}`));
  for (const a of AGENTS) assert.equal(f.store.readLedger(a).chain, 'ok', `E8: ${a} verifies after the retry`);
});

kase('E4-busy', 'a second request while the Human is being asked is refused, and asks nobody', async (mod) => {
  const f = await lostFloor();
  const open = [];   // every dialog on screen; each is answered no at the end, so no case is left waiting
  const c = command(mod, f, { confirm: (q) => new Promise((res) => { c.asked.push(q); open.push(res); }) });
  const first = c.cmd.handle('god', { floor: f.root });
  await new Promise((res) => setImmediate(res));
  const second = c.cmd.handle('god', { floor: f.root });
  await new Promise((res) => setImmediate(res));
  const dialogs = open.length;
  for (const res of open) res(false);
  const r2 = await second;
  assert.equal(dialogs, 1, 'E4-busy: one dialog only');
  assert.equal(r2.status, 409, `E4-busy: ${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.line, 'refused: a rekey for this floor is already waiting for the Human or running');
  assert.equal((await first).body.line, 'refused: the Human did not confirm. Nothing was written.');
});

kase('E6', 'a refused ledger is named and the command says it is not complete', async (mod) => {
  const f = await lostFloor();
  // Break dwight's chain: drop the first record's prev link target by editing a byte of its id.
  const file = filesUnder(path.join(f.root, 'agents', 'dwight')).find((p) => p.endsWith('.jsonl') && fs.readFileSync(p, 'utf8').includes('"t":"claim"'));
  await f.store.appendRecord('dwight', { t: 'claim', kind: 'fact', text: 'never written: read-only' }, 'endpoint');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('"text":"dwight before the key was lost"', '"text":"dwight before the key was lost"}{'));
  f.store.close();
  f.store = open(f.root, f.u);
  const r = await command(mod, f).cmd.handle('god', { floor: f.root });
  assert.equal(r.status, 409, `E6: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false);
  assert.ok(r.body.lines.includes('rekeyed: andy'), `E6: ${r.body.lines}`);
  assert.ok(r.body.lines.some((l) => l.startsWith('refused: dwight (')), `E6: ${r.body.lines}`);
  assert.match(r.body.line, /^rekey not complete: 1 rekeyed, 1 refused \(key [^)]+\)\. Refused ledgers stay read-only\.$/);
  assert.equal(rekeyLines(f.root, 'dwight').length, 0, 'E6: the refused ledger got no rekey line');
});

test('E1 (red before): the entry point exists and is the only caller of rekey()', () => {
  assert.ok(REAL, `${RC} exists`);
  assert.deepEqual(cli.parseArgs(['rekey', '--floor', 'C:\\Floor\\hive']), { action: 'rekey', floor: 'C:\\Floor\\hive' });
  for (const bad of [['rekey'], ['rekey', '--floor'], ['rekey', '--floor', '--yes'], ['rekey', 'C:\\Floor\\hive'], ['rekey', '--floor', 'a', '--yes'], ['rekey', '--yes', '--floor', 'a']]) {
    assert.throws(() => cli.parseArgs(bad), /rekey: --floor <hive folder> is required/, bad.join(' '));
  }
  const index = lf('src/main/index.ts');
  assert.ok(index.includes("  if (action === 'rekey') return rekeyCommand.handle(agentId, body);\n"), 'main routes the rekey action to the command');
  assert.ok(index.includes("const claimsCallerIsGod = (agentId: string): boolean => hive.isGod(agentId);\nconst rekeyCommand = new RekeyCommand({\n  isGod: claimsCallerIsGod,\n  floorRoot: () => hive.root(),\n  store: () => claimsEndpoint()?.store ?? null,\n"), 'the command is wired to god, this floor and its store');
  // One caller: nothing else under src/ runs a rekey, so nothing can run it without the Human.
  const callers = [];
  // Code lines only: a comment that names rekey() is not a call.
  const calls = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /\.rekey\(/.test(l)).length;
  const walk =(dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && calls(fs.readFileSync(p, 'utf8')) > 0) callers.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(callers, [RC], 'only rekeyCommand.ts calls rekey()');
  assert.equal(calls(lf(RC)), 1, 'and it calls it in one place');
});

for (const [id, what, fn] of CASES) test(`${id}: ${what}`, async () => { assert.ok(REAL, `${RC} exists`); await fn(REAL); });

test('E5: the real CLI over HTTP prints one line per ledger; a refusal exits 1 and writes nothing', async () => {
  assert.ok(REAL, `${RC} exists`);
  const f = await lostFloor();
  let yes = false;
  const c = command(REAL, f, { confirm: async () => yes });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const r = body.action === 'rekey' ? await c.cmd.handle('god', body) : { status: 400, body: { ok: false, line: 'refused: not rekey' } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    const env = { HIVE_CLAIMS_URL: `http://127.0.0.1:${server.address().port}/claims/god` };
    const run = async (argv, e = env) => { const io = { o: '', e: '' }; const code = await cli.main(argv, e, { out: (s) => { io.o += s; }, err: (s) => { io.e += s; } }); return { code, ...io }; };
    const before = snapshot(f.root);
    const no = await run(['rekey', '--floor', f.root]);
    assert.equal(no.code, cli.EXIT.refused, JSON.stringify(no));
    assert.ok(no.e.includes('claims: waiting for the Human to confirm the rekey in the Guppy window (up to 5 minutes)...\n'), no.e);
    assert.ok(no.e.endsWith('claims: refused: the Human did not confirm. Nothing was written.\n'), no.e);
    assert.equal(no.o, '');
    assert.equal(snapshot(f.root), before, 'E5: the refused run wrote nothing');
    yes = true;
    const ran = await run(['rekey', '--floor', f.root]);
    assert.equal(ran.code, cli.EXIT.ok, JSON.stringify(ran));
    const out = ran.o.split('\n');
    assert.match(out[0], /^rekey complete: 2 ledgers rekeyed under key \S+$/);
    assert.deepEqual(out.slice(1).filter(Boolean).sort(), AGENTS.map((a) => `rekeyed: ${a}`));
    for (const a of AGENTS) assert.equal(rekeyLines(f.root, a).length, 1, `E5: ${a} has one rekey line`);
    // No URL (a worker's shell): unavailable, and usage errors never reach main.
    assert.equal((await run(['rekey', '--floor', f.root], {})).code, cli.EXIT.unavailable);
    const usage = await run(['rekey']);
    assert.equal(usage.code, cli.EXIT.usage);
    assert.ok(usage.e.includes('usage: claims bootstrap [--status] | claims rekey --floor <hive folder>'), usage.e);
    assert.ok(cli.REKEY_TIMEOUT_MS > REAL.REKEY_CONFIRM_MS, 'the CLI waits longer than the Human has to answer');
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('E9 (Jim NIT b, c): the CLI tells a rekey that ran and is not complete (exit 5) from a refusal (exit 1), and a timeout says the rekey may still be running', async () => {
  let reply = null;   // null: never answer
  let posted = null;
  const open = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => { posted = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!reply) { open.push(res); return; } res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body)); });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    const env = { HIVE_CLAIMS_URL: `http://127.0.0.1:${server.address().port}/claims/god` };
    const run = async (opts) => { const io = { o: '', e: '' }; const code = await cli.main(['rekey', '--floor', 'C:\\Floor\\hive'], env, { out: (s) => { io.o += s; }, err: (s) => { io.e += s; } }, opts); return { code, ...io }; };
    assert.deepEqual(cli.EXIT, { ok: 0, refused: 1, usage: 2, unavailable: 3, timeout: 4, partial: 5 });
    reply = { status: 409, body: { ok: false, line: 'rekey not complete: 1 rekeyed, 1 refused (key k). Refused ledgers stay read-only.', lines: ['rekeyed: andy', 'refused: dwight (mac at c-1)'], result: { ok: false, keyId: 'k', rekeyed: ['andy'], refused: [{ agentId: 'dwight', why: 'mac at c-1' }] } } };
    const partial = await run();
    assert.equal(partial.code, 5, JSON.stringify(partial));
    assert.ok(partial.e.endsWith('claims: rekey not complete: 1 rekeyed, 1 refused (key k). Refused ledgers stay read-only.\nrekeyed: andy\nrefused: dwight (mac at c-1)\n'), partial.e);
    reply = { status: 409, body: { ok: false, line: 'refused: the Human did not confirm. Nothing was written.' } };
    assert.equal((await run()).code, 1);
    reply = { status: 409, body: { ok: false, line: 'refused: this floor has no claim ledger to rekey', lines: [], result: { ok: false, rekeyed: [], refused: [] } } };
    assert.equal((await run()).code, 1, 'nothing ran: a refusal');
    // Jim NIT 2 (9aebc259): refused ledgers alone are not a rekey that ran. Exit 5 needs written lines.
    reply = { status: 409, body: { ok: false, line: 'rekey not complete: 0 rekeyed, 2 refused.', lines: ['refused: andy (mac at c-1)', 'refused: dwight (mac at c-2)'], result: { ok: false, rekeyed: [], refused: [{ agentId: 'andy', why: 'mac at c-1' }, { agentId: 'dwight', why: 'mac at c-2' }] } } };
    assert.equal((await run()).code, 1, 'every ledger refused for a broken chain: nothing was written');
    reply = { status: 409, body: { ok: false, line: 'x', lines: [], result: { ok: false, rekeyed: [], refused: [{ agentId: 'andy', why: 'no key (unreadable)' }] } } };
    assert.equal((await run()).code, 1, 'no key: nothing was written');
    reply = { status: 409, body: { ok: false, line: 'rekey not in effect', lines: [], result: { ok: false, keyId: 'k', recorded: false, rekeyed: [], refused: [{ agentId: 'andy', why: 'not in effect: the key id was not recorded (skipped), retry the rekey' }] } } };
    assert.equal((await run()).code, 5, 'lines were written and the key id was not recorded: partial');
    // Jim NIT 1 (9aebc259): a relative --floor is god's, so the CLI makes it absolute before posting.
    reply = { status: 409, body: { ok: false, line: 'refused' } };
    const at = path.join(os.tmpdir(), 'gods-folder', 'hive');
    for (const [typed, want] of [['.', at], ['..', path.dirname(at)], ['sub', path.join(at, 'sub')], ['C:\\Floor\\hive', 'C:\\Floor\\hive']]) {
      const io = { e: '' };
      await cli.main(['rekey', '--floor', typed], env, { out: () => {}, err: (s) => { io.e += s; } }, { cwd: at });
      assert.deepEqual(posted, { action: 'rekey', floor: want }, typed);
    }
    reply = null;
    const late = await run({ rekeyTimeoutMs: 300 });
    assert.equal(late.code, 4, JSON.stringify(late));
    assert.ok(late.e.endsWith('claims: no reply within 0 minutes; the rekey may still be running. Check log.jsonl for claims-rekey-command and claims-rekey before running it again.\n'), late.e);
    assert.ok(lf('resources/claims-cli.cjs').includes('`claims: no reply within ${Math.round(rekeyTimeoutMs / 60000)} minutes; the rekey may still be running.'), 'the minutes are the real limit');
    assert.equal(cli.REKEY_TIMEOUT_MS, 10 * 60000);
  } finally {
    for (const res of open) res.destroy();
    await new Promise((res) => server.close(res));
  }
});

test('E7: both alerts and COMMANDS.md name the exact command; a hidden run never confirms', () => {
  assert.ok(REAL, `${RC} exists`);
  assert.equal(REAL.REKEY_COMMAND, 'claims rekey --floor <hive folder>');
  assert.equal(REAL.rekeyCommandFor('C:\\Floor A\\hive'), 'claims rekey --floor "C:\\Floor A\\hive"');
  // The typed command parses: the alert's text is a command line god can run as written.
  assert.deepEqual(cli.parseArgs(['rekey', '--floor', 'C:\\Floor A\\hive']), { action: 'rekey', floor: 'C:\\Floor A\\hive' });
  const index = lf('src/main/index.ts');
  assert.ok(index.includes('Recovery is a rekey of this floor, which only the Human can approve: god runs \\`${rekeyCommandFor(root)}\\` and the Human confirms it in the Guppy window.'), 'the key-missing alert names the command with the floor');
  const store = lf('src/main/claims/store.ts');
  assert.ok(store.includes("that floor's god runs \\`${REKEY_COMMAND}\\` and the Human confirms it in that floor's Guppy window. Nothing runs it automatically."), 'the unreadable-key recovery names the command');
  for (const [name, src] of [['index.ts', index], ['store.ts', store]]) {
    assert.ok(!/ask god to run it/.test(src), `${name}: no "ask god to run it" without a command`);
    assert.ok(!/no Settings button/.test(src), `${name}: the stop-gap wording is gone`);
  }
  const hive = lf('src/main/hive.ts');
  assert.ok(hive.includes(`'- god only: \`${REAL.REKEY_COMMAND}\` — rekey this floor\\'s claim ledgers`), 'COMMANDS.md FLOOR COMMANDS documents the command');
  assert.ok(hive.includes('the rekey runs on the Human\\\'s yes alone'), 'and says who decides');
  // The dialog: Cancel is the default and the answer on close; a hidden (harness) run never confirms.
  const at = index.indexOf('const rekeyCommand = new RekeyCommand({');
  const wiring = index.slice(at, index.indexOf('hookServer.setClaimsHandler(', at));
  assert.ok(wiring.includes('    if (DEV_HIDDEN) return false;'), 'a hidden run answers no');
  assert.ok(wiring.includes("buttons: [q.ok, 'Cancel'], defaultId: 1, cancelId: 1,"), 'Cancel is the default button');
  assert.ok(wiring.includes('return r.response === 0;'), 'only the first button is a yes');
  assert.ok(wiring.includes('signal };'), 'the dialog closes when the time runs out');
  // Jim NIT d: the window is restored and brought to the front BEFORE the dialog is shown.
  const front = wiring.indexOf('try { surfaceWindow(shown, { show: true, restore: true, focus: true }); shown?.flashFrame(true); }');
  assert.ok(!/\.(show|restore|focus)\(\)/.test(wiring), 'only through surfaceWindow, the one seam for the hidden rule');
  assert.ok(index.includes("  if (!claimsCallerIsGod(agentId)) return { status: 403, body: { ok: false, line: 'refused: the claims command is god-only' } };"), 'the handler gate uses the same god check');
  assert.ok(front > 0 && front < wiring.indexOf('dialog.showMessageBox('), 'the parent window is brought to the front first');
  assert.ok(wiring.indexOf('    if (DEV_HIDDEN) return false;') < front, 'and never in a hidden run');
  // The CLI cannot confirm for the Human: it sends the floor and nothing else.
  assert.ok(lf('resources/claims-cli.cjs').includes("{ action: 'rekey', floor: a.floor }"), 'the CLI sends no confirmation field');
  assert.ok(!/confirm/i.test(lf(RC).split('handle(agentId: string, body: unknown)')[1].split('const root = this.d.floorRoot();')[0]), 'and the command reads none from the request');
});

const MUTANTS = [
  { id: 'M1', what: 'a no still runs the rekey', from: '      if (!yes) {', to: '      if (false) {', dies: ['E3-no'] },
  { id: 'M2', what: 'any agent may ask', from: "    if (!this.d.isGod(agentId)) return refuse(403, 'claims rekey is god-only');", to: '', dies: ['E4-god'] },
  { id: 'M3', what: 'any floor name is accepted', from: '    if (!sameFolder(floor, root, this.d.platform ?? process.platform, this.d.realpath ?? realpathSync.native)) {', to: '    if (false) {', dies: ['E4-floor'] },
  { id: 'M4', what: 'anything but false is a yes', from: '=== true && !ac.signal.aborted', to: '!== false && !ac.signal.aborted', dies: ['E3-true', 'E3-no'] },
  { id: 'M5', what: 'a late yes counts', from: '=== true && !ac.signal.aborted', to: '=== true', dies: ['E3-late'] },
  { id: 'M6', what: 'two dialogs at once', from: '    if (this.busy) return refuse(', to: '    if (false) return refuse(', dies: ['E4-busy'] },
  { id: 'M8', what: 'a link to this floor is another floor', from: '    try { r = realpath(r); } catch { /* absent or unreadable: as written */ }', to: '', dies: ['E4-floor'] },
  { id: 'M9', what: 'an unrecorded rekey is summed up as a partial one', from: '          : r.recorded === false', to: '          : false', dies: ['E8'] },
  { id: 'M7', what: 'the rekey never runs', from: '      const r = await store.rekey(true);', to: '      const r = { ok: true, keyId: \'k\', rekeyed: [\'andy\', \'dwight\'], refused: [] as Array<{ agentId: string; why: string }> };', dies: ['E2'] },
];
for (const m of MUTANTS) {
  test(`mutant: ${m.id} ${m.what}`, async () => {
    const text = lf(RC);
    assert.equal(text.split(m.from).length - 1, 1, `${m.id}: the mutant edit applies exactly once`);
    const mod = loadTs.fromText(RC, text.split(m.from).join(m.to));
    for (const id of m.dies) {
      const fn = CASES.find(([c]) => c === id)[2];
      let died = null;
      try { await fn(mod); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${m.id} (${m.what}) at ${id}${died ? `: ${died.message}` : ''}`);
    }
  });
}

test('MUTANT CENSUS: every mutant names a case that exists', () => {
  for (const m of MUTANTS) for (const id of m.dies) assert.ok(CASES.some(([c]) => c === id), `${m.id} -> ${id}`);
});
