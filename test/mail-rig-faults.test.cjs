'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 8: the 12 FAULT-INJECTION tests of INBOX-DESIGN §8.3 (F1-F12), on the
 * fake-agent rig (test/mail-rig/). Layer (a): zero model tokens.
 *
 * LAYER: main-process integration. Each test starts its own sandbox instance (rig-host.cjs: the
 * real hive, ledger, hook server with its real pipe / HTTP broker / MCP endpoint, the wake
 * coordinator and bridge, the one submit owner, PtyManager) in a throwaway directory with its own
 * harness home, hive and HOME, and drives fake CLIs spawned through the real PTY path, whose hooks
 * travel over the provider's real transport. The renderer is not loaded (no window at all); its
 * mirrors into main are stand-ins, named in rig-host.cjs. See NOTES (slice 8) for why.
 *
 * Every test kills its instance and every stub process at the end, failure included, and removes
 * its sandbox. Tests in this file run one at a time (node:test's default within a file).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startRig, waitFor, sleep, markersIn, REDELIVERED } = require('./mail-rig/driver.cjs');
const { checkIsolation, SECRET_NAME } = require('./mail-rig/isolation.cjs');

const T = { timeout: 180_000 };
const acted = async (rig, agentId, id) => (await rig.entry(agentId, id))?.state === 'acted';
const actedRows = async (rig, id) => (await rig.rows('mail')).filter((r) => r.stage === 'acted' && (r.ids ?? []).includes(id));

const beatUntil = (rig, fn, opts) => rig.beatUntil(fn, opts);

// ——————————————————————————————————————————————————————————————————————————— the rig itself

test('RIG the sandbox instance is isolated: own home, harness home, hive and pipe; the CLIs see only jailed paths; no model endpoint', T, async (t) => {
  const rig = await startRig(t);
  const inside = (p) => { const r = path.relative(rig.sandbox, p); return !!p && r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
  const info = await rig.call('ping');
  assert.ok(inside(info.home), `os.homedir() of the instance is jailed (${info.home})`);
  assert.ok(inside(info.hiveRoot), 'its hive is in the sandbox');
  assert.match(info.sock, /^\\\\\.\\pipe\\munder-difflin-[0-9a-f]{12}$/, 'its own pipe (the name hashes the sandbox hive root)');
  assert.match(info.llm, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, 'provider base URLs point at the rig fake LLM');
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }, { id: 'cx-1', flavour: 'codex', scenario: {} }, { id: 'ag-1', flavour: 'agy', scenario: {} }]);
  for (const id of ['cl-1', 'cx-1', 'ag-1']) {
    const start = rig.transcript(id).find((r) => r.kind === 'start');
    for (const [k, v] of Object.entries(start.envAll)) {
      assert.ok(!/^(MUNDER_|CTH_|KG_|MEMORY_)/i.test(k), `${id}: no live-floor variable ${k}`);
      if (/[\\/]/.test(v) && !/^https?:/.test(v) && !v.startsWith('\\\\.\\pipe\\')) assert.ok(inside(v) || /node|nodejs/i.test(v), `${id}: ${k}=${v} is inside the sandbox`);
      assert.ok(!/Dunder[\\/]hive/i.test(v), `${id}: ${k} never names the live hive`);
    }
    assert.ok(inside(start.cwd), `${id}: works in the sandbox`);
    assert.deepEqual(start.isolation, [], `${id}: the stub's own isolation check is clean`);
  }
  assert.deepEqual(info.envNames.filter((k) => SECRET_NAME.test(k) && !/_BASE_URL$/i.test(k)), [], 'no credential-family variable in the host');
  // The settings/config each real CLI would read point only at loopback and the sandbox pipe.
  const settings = JSON.parse(fs.readFileSync(path.join(rig.agentDir('cl-1'), 'settings.json'), 'utf8'));
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    const h = groups[0].hooks[0];
    if (h.type === 'http') assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/hook\/cl-1\//, `${ev} posts to the instance broker`);
    else assert.ok(h.command.includes(rig.sandbox), `${ev} runs the sandbox shim`);
  }
  const codexToml = fs.readFileSync(path.join(rig.agentDir('cx-1'), '.codex', 'config.toml'), 'utf8');
  assert.ok(!/api\.openai\.com|api\.anthropic\.com/.test(codexToml));
  assert.ok(fs.existsSync(path.join(rig.sandbox, 'home', '.gemini', 'config', 'hooks.json')), 'the AGY global hooks went to the JAILED ~/.gemini');
  await rig.stop();
  const alive = () => rig.stubPids().filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  await waitFor(() => alive().length === 0, { what: 'every stub gone with its instance', timeoutMs: 10_000 });
});

// ——————————————————————————————————————————————————————————————————————————— ISO (negative control)

test('ISO negative control: parent credentials and decoy agy/codex/claude on the PARENT PATH never reach the rig; the decoys never run; the guard trips on both', T, async (t) => {
  const fsp = require('node:fs');
  const os = require('node:os');
  const decoy = fsp.mkdtempSync(path.join(os.tmpdir(), 'md-rig-decoy-'));
  const marker = path.join(decoy, 'EXECUTED');
  for (const name of ['agy', 'codex', 'claude']) {
    fsp.writeFileSync(path.join(decoy, `${name}.cmd`), `@echo off\r\necho ${name} %* >> "${marker}"\r\nexit /b 0\r\n`);
  }
  const sentinels = { SLACK_BOT_TOKEN: 'xoxb-sentinel', WEBHOOK_SECRET: 'sentinel', ANTHROPIC_AUTH_TOKEN: 'sentinel', AWS_SECRET_ACCESS_KEY: 'sentinel', GITHUB_TOKEN: 'sentinel', OPENAI_API_KEY: 'sentinel' };
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const saved = { path: process.env[pathKey], ...Object.fromEntries(Object.keys(sentinels).map((k) => [k, process.env[k]])) };
  Object.assign(process.env, sentinels);
  process.env[pathKey] = `${decoy}${path.delimiter}${saved.path}`;
  t.after(() => {
    process.env[pathKey] = saved.path;
    for (const k of Object.keys(sentinels)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fsp.rmSync(decoy, { recursive: true, force: true });
  });
  // The guard itself trips on each kind of leak (so a green run below means something).
  const sandboxLike = fsp.mkdtempSync(path.join(os.tmpdir(), 'md-rig-decoy-sb-'));
  t.after(() => fsp.rmSync(sandboxLike, { recursive: true, force: true }));
  assert.throws(() => checkIsolation({ SLACK_BOT_TOKEN: 'x', PATH: '' }, sandboxLike), /secret-shaped variable SLACK_BOT_TOKEN/);
  assert.throws(() => checkIsolation({ PATH: decoy }, sandboxLike), /PATH dir outside the sandbox/);
  assert.throws(() => checkIsolation({ PATH: decoy, PATHEXT: '.CMD' }, sandboxLike), /provider command agy resolves outside the rig bin/);

  const rig = await startRig(t);
  const info = await rig.call('ping');
  for (const k of Object.keys(sentinels)) assert.ok(!info.envNames.includes(k), `host: no ${k}`);
  assert.ok(!info.path.toLowerCase().includes(decoy.toLowerCase()), 'host PATH: no decoy dir');
  await rig.setup([{ id: 'ag-1', flavour: 'agy', scenario: {} }, { id: 'cx-1', flavour: 'codex', scenario: {} }, { id: 'cl-1', flavour: 'claude', scenario: {} }]);
  const sent = {};
  for (const id of ['ag-1', 'cx-1', 'cl-1']) sent[id] = await rig.call('send', { to: id, subject: 'iso', body: 'hello' });
  await rig.beatUntil(async () => {
    for (const id of ['ag-1', 'cx-1', 'cl-1']) if (!rig.contexts(id).some((c) => c.ids.includes(sent[id].id)) && !rig.transcript(id).some((r) => r.kind === 'read-file')) return false;
    return true;
  }, { what: 'each agent took a turn with its mail (hooks and wakes ran)', stepMs: 70_000 });
  for (const id of ['ag-1', 'cx-1', 'cl-1']) {
    const start = rig.transcript(id).find((r) => r.kind === 'start');
    assert.deepEqual(start.isolation, [], `${id}: isolated`);
    for (const k of Object.keys(sentinels)) assert.ok(!start.envNames.includes(k), `${id}: no ${k}`);
    assert.ok(!start.path.toLowerCase().includes(decoy.toLowerCase()), `${id}: no decoy dir on PATH`);
    assert.ok(rig.hooks(id).length > 0, `${id}: its hooks ran`);
  }
  assert.ok(!fsp.existsSync(marker), `no decoy was ever executed${fsp.existsSync(marker) ? `: ${fsp.readFileSync(marker, 'utf8')}` : ''}`);
});

// ——————————————————————————————————————————————————————————————————————————— F1

test('F1 kill the PTY between surfacing and Stop: re-surfaced ONCE with the re-delivered marker; exactly one acted', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cl-1', subject: 'f1', body: 'kill me mid-turn' });
  await rig.beat();
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m.id)), { what: 'the wake turn surfaces m' });
  rig.cue('cl-1', { cue: 'tool' });   // a later hook: the transcript evidence confirms it (surfaced)
  await waitFor(async () => (await rig.entry('cl-1', m.id))?.state === 'surfaced', { what: 'm surfaced (evidence)' });

  await rig.call('killPty', { id: 'cl-1' });   // the PTY dies before any Stop
  await waitFor(async () => { const e = await rig.entry('cl-1', m.id); return e.state === 'delivered' && e.redelivered === true; }, { what: 'm back to delivered with the marker' });
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'redelivered' && r.ids.includes(m.id) && r.reason === 'pty-exit'), 'one redelivered row, reason pty-exit');

  await rig.respawn({ id: 'cl-1', flavour: 'claude', scenario: {} });   // restart in place
  await beatUntil(rig, () => acted(rig, 'cl-1', m.id), { what: 'm acted after the restart' });

  const withM = rig.contexts('cl-1').filter((c) => c.ids.includes(m.id));
  assert.equal(withM.length, 2, 'surfaced in the killed turn, then re-surfaced exactly once');
  assert.ok(!withM[0].context.includes(REDELIVERED), 'the first surfacing carries no marker');
  assert.ok(withM[1].context.includes(REDELIVERED), 'the re-surfacing carries the re-delivered marker');
  assert.equal((await actedRows(rig, m.id)).length, 1, 'exactly one acted');
  await waitFor(() => rig.doneFiles('cl-1').includes(m.id), { what: 'the harness archived it' });
});

// ——————————————————————————————————————————————————————————————————————————— F2

test('F2 kill -9 the app between the ledger write and the .done rename, restart: consistent, rename completed, no re-wake', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  await rig.call('holdArchives', { on: true });
  const m = await rig.call('send', { to: 'cl-1', subject: 'f2', body: 'crash before the rename' });
  await rig.beat();
  const marker = path.join(rig.rigDir, 'at-rename.json');
  await waitFor(() => fs.existsSync(marker), { what: 'the ledger write that records acted, rename held' });
  const onDisk = JSON.parse(fs.readFileSync(rig.ledgerFile('cl-1'), 'utf8'));
  assert.equal(onDisk.entries[m.id].state, 'acted', 'the durable ledger says acted');
  assert.ok(rig.inboxFiles('cl-1').includes(m.id), 'and the file is still in inbox/ (no rename yet)');

  await rig.kill9();
  assert.ok(rig.inboxFiles('cl-1').includes(m.id), 'the crash left acted + file in inbox/');
  const promptsBefore = rig.prompts('cl-1').length;
  await rig.boot();
  await rig.respawn({ id: 'cl-1', flavour: 'claude', scenario: {} });   // the tab is restored
  await beatUntil(rig, () => rig.doneFiles('cl-1').includes(m.id), { what: 'the rename completed after the restart', tries: 6 });
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 70_000 }); await rig.beat(); await sleep(300); }

  const e = await rig.entry('cl-1', m.id);
  assert.equal(e.state, 'acted', 'still acted');
  assert.ok(!rig.inboxFiles('cl-1').includes(m.id) && rig.doneFiles('cl-1').includes(m.id), 'rename completed');
  assert.deepEqual(await rig.call('pending', { id: 'cl-1' }), [], 'nothing pending');
  assert.equal(rig.prompts('cl-1').length, promptsBefore, 'NO re-wake for acted mail');
  assert.equal((await rig.rows('mail-ledger-corrupt')).length, 0, 'the ledger was never damaged');
  assert.equal((await actedRows(rig, m.id)).length, 1, 'one acted row');
});

// ——————————————————————————————————————————————————————————————————————————— F3

test('F3 truncate the ledger JSON: mail-ledger-corrupt, rebuilt from log + filesystem, never an empty state', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  const m1 = await rig.call('send', { to: 'cl-1', subject: 'f3 one', body: 'first' });
  const m2 = await rig.call('send', { to: 'cl-1', subject: 'f3 two', body: 'second' });
  await beatUntil(rig, async () => (await acted(rig, 'cl-1', m1.id)) && (await acted(rig, 'cl-1', m2.id)), { what: 'm1, m2 acted' });
  await waitFor(() => rig.doneFiles('cl-1').length === 2, { what: 'both archived' });
  await rig.call('capacityHold', { on: true });   // m3 stays delivered
  const m3 = await rig.call('send', { to: 'cl-1', subject: 'f3 three', body: 'third, never shown yet' });
  await rig.call('flush');
  await rig.kill9();

  const file = rig.ledgerFile('cl-1');
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw.slice(0, Math.floor(raw.length / 2)));   // truncated mid-JSON

  await rig.boot();
  const doc = await rig.call('ledger', { id: 'cl-1' });
  const rows = await rig.rows('mail-ledger-corrupt');
  assert.equal(rows.length, 1, 'one mail-ledger-corrupt row');
  assert.ok(rows[0].rebuiltEntries >= 3, `rebuilt entries: ${rows[0].rebuiltEntries}`);
  assert.equal(doc.entries[m1.id].state, 'acted', 'm1 acted (from .done)');
  assert.equal(doc.entries[m2.id].state, 'acted', 'm2 acted (from .done)');
  assert.equal(doc.entries[m3.id].state, 'delivered', 'm3 still delivered (from inbox/)');
  const quarantined = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('cl-1.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'the damaged file is quarantined, not overwritten');
  assert.ok((await rig.call('integrity')).some((i) => i.repaired === true && String(i.file).includes('cl-1')), 'the integrity banner says it was rebuilt');

  await rig.respawn({ id: 'cl-1', flavour: 'claude', scenario: {} });
  const before = rig.contexts('cl-1').length;
  await beatUntil(rig, () => acted(rig, 'cl-1', m3.id), { what: 'm3 acted after the rebuild' });
  const after = rig.contexts('cl-1').slice(before).flatMap((c) => c.ids);
  assert.deepEqual([...new Set(after)], [m3.id], 'only m3 is surfaced after the rebuild: acted mail is not re-shown');
});

// ——————————————————————————————————————————————————————————————————————————— F4 / F5

async function heldThenReleased(rig, hold, release) {
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  await hold();
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push((await rig.call('send', { to: 'cl-1', subject: `held ${i}`, body: `held body ${i}` })).id);
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 20 * 60_000 }); await rig.beat(); await sleep(300); }   // 1 h
  assert.equal(rig.prompts('cl-1').length, 0, 'nothing typed while held');
  for (const id of ids) assert.equal((await rig.entry('cl-1', id)).state, 'delivered');
  await release();
  await beatUntil(rig, async () => { for (const id of ids) if (!(await acted(rig, 'cl-1', id))) return false; return true; }, { what: 'all 5 acted' });
  const first = rig.contexts('cl-1')[0];
  assert.deepEqual(markersIn(first.context), ids, 'all 5 surfaced in the FIRST turn after release, oldest first');
  assert.equal(rig.prompts('cl-1').length, 1, 'one wake');
}

test('F4 capacity hold for 1 h (simulated clock) with 5 messages: all 5 surfaced in the first turn after release, in order', T, async (t) => {
  const rig = await startRig(t);
  await heldThenReleased(rig, () => rig.call('capacityHold', { on: true }), () => rig.call('capacityHold', { on: false }));
  assert.ok((await rig.call('outcomes')).some((o) => o.outcome.kind === 'REFUSED' && o.outcome.reason === 'CAPACITY_HOLD'), 'the hold refused the wakes');
});

test('F5 pause, then unpause, with mail pending: all 5 surfaced in the first turn after release, in order', T, async (t) => {
  const rig = await startRig(t);
  await heldThenReleased(rig, () => rig.call('pause', { id: 'cl-1', on: true }), () => rig.call('pause', { id: 'cl-1', on: false }));
});

// ——————————————————————————————————————————————————————————————————————————— F6

test('F6 INTERFERED, then ALREADY_HANDLED / SEND_AGAIN: the ledger follows the turn that actually started', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-a', flavour: 'claude', scenario: {} }, { id: 'cl-b', flavour: 'claude', scenario: {} }]);

  // ALREADY_HANDLED: the person pressed Enter on the staged nudge themselves.
  await rig.call('armInterfere', { id: 'cl-a' });
  const ma = await rig.call('send', { to: 'cl-a', subject: 'f6 a', body: 'handled by a person' });
  await rig.beat();
  await waitFor(async () => (await rig.call('outcomes')).some((o) => o.agentId === 'cl-a' && o.outcome.kind === 'INTERFERED'), { what: 'cl-a INTERFERED' });
  assert.ok(await rig.call('inhibition', { id: 'cl-a' }), 'the PTY is held for a person');
  assert.equal(rig.prompts('cl-a').length, 0, 'nothing submitted');
  assert.equal((await rig.entry('cl-a', ma.id)).state, 'delivered', 'still delivered');
  await rig.call('humanType', { id: 'cl-a', text: '\r' });
  await waitFor(() => acted(rig, 'cl-a', ma.id), { what: 'the human-started turn acts it' });
  assert.equal(await rig.call('resolveInterference', { id: 'cl-a', how: 'ALREADY_HANDLED' }), true);
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 70_000 }); await rig.beat(); await sleep(300); }
  assert.equal(rig.prompts('cl-a').length, 1, 'no second wake after ALREADY_HANDLED');
  assert.ok(rig.contexts('cl-a')[0].ids.includes(ma.id), 'surfaced in the turn the person started');

  // SEND_AGAIN: the person cleared the line; the owner re-admits the wake.
  await rig.call('armInterfere', { id: 'cl-b' });
  const mb = await rig.call('send', { to: 'cl-b', subject: 'f6 b', body: 'send it again' });
  await rig.beat();
  await waitFor(async () => (await rig.call('outcomes')).some((o) => o.agentId === 'cl-b' && o.outcome.kind === 'INTERFERED'), { what: 'cl-b INTERFERED' });
  await rig.call('humanType', { id: 'cl-b', text: '\x15' });
  await sleep(300);
  assert.equal(await rig.call('resolveInterference', { id: 'cl-b', how: 'SEND_AGAIN' }), true);
  assert.equal((await rig.entry('cl-b', mb.id)).state, 'delivered', 'nothing surfaced while held');
  await sleep(1_700);   // HUMAN_QUIET_MS after the person's key
  await beatUntil(rig, () => acted(rig, 'cl-b', mb.id), { what: 'the re-sent wake acts it' });
  assert.equal(rig.prompts('cl-b').length, 1, 'exactly the one re-sent nudge became a turn');
  assert.ok(rig.contexts('cl-b')[0].ids.includes(mb.id));
});

// ——————————————————————————————————————————————————————————————————————————— F7

test('F7 20-message burst of 4,000 characters: drip across PostToolUse, each surfaced exactly once, none lost, every injection within the joined budget', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { turn: { tools: 16, toolMs: 15 } } }]);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await rig.call('send', { to: 'cl-1', subject: `burst ${i}`, body: `burst body ${i} `.padEnd(4000, '.') })).id);
  await beatUntil(rig, async () => { for (const id of ids) if (!(await acted(rig, 'cl-1', id))) return false; return true; }, { what: 'all 20 acted' });
  const ctxs = rig.contexts('cl-1');
  const counts = new Map();
  for (const c of ctxs) for (const id of markersIn(c.context)) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of ids) assert.equal(counts.get(id), 1, `${id} surfaced exactly once`);
  assert.ok(ctxs.some((c) => c.event === 'PostToolUse' && c.ids.length > 0), 'the drip used PostToolUse');
  for (const c of ctxs) assert.ok(c.context.length <= 9_500, `an injection of ${c.context.length} characters is over the joined budget (§11.2: 9,500)`);
  await waitFor(() => rig.doneFiles('cl-1').length === 20, { what: 'all 20 archived' });
  assert.equal(rig.inboxFiles('cl-1').length, 0, 'none lost, none left');
});

// ——————————————————————————————————————————————————————————————————————————— F8

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) walk(p, out);
  }
  return out;
}

test('F8 duplicate-id attack, traversal id, reserved and overlong ids, same-id resend: §4.1, nothing written outside the inbox', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  await rig.call('register', { id: 'cl-2', provider: 'claude' });
  const sends = [
    { to: 'cl-2', id: '..\\..\\..\\evil-trav', subject: 'traversal', body: 't', file: 'o1' },
    { to: 'cl-2', id: '../../evil-trav2', subject: 'traversal 2', body: 't2', file: 'o2' },
    { to: 'cl-2', id: 'CON', subject: 'reserved', body: 'r', file: 'o3' },
    { to: 'cl-2', id: 'x'.repeat(200), subject: 'overlong', body: 'l', file: 'o4' },
    { to: 'cl-2', id: 'dup-1', subject: 'same', body: 'same body', file: 'o5' },
    { to: 'cl-2', id: 'dup-1', subject: 'same', body: 'same body', file: 'o6' },          // same-id resend
    { to: 'cl-2', id: 'dup-1', subject: 'attack', body: 'different content', file: 'o7' } // duplicate-id attack
  ];
  for (const s of sends) { rig.cue('cl-1', { cue: 'reply', ...s }); await waitFor(() => rig.transcript('cl-1').some((r) => r.kind === 'outbox' && r.file === `${s.file}.json`), { what: `outbox ${s.file}` }); await waitFor(() => !fs.existsSync(path.join(rig.agentDir('cl-1'), 'outbox', `${s.file}.json`)), { what: `routed ${s.file}` }); }

  const doc = await rig.call('ledger', { id: 'cl-2' });
  const entries = Object.values(doc.entries);
  assert.equal(entries.length, 6, 'six messages: the same-content resend was dropped');
  assert.equal((await rig.rows('mail-dedup')).length, 1, 'one mail-dedup row');
  const bySender = (sid) => entries.filter((e) => e.senderId === sid);
  for (const sid of ['..\\..\\..\\evil-trav', '../../evil-trav2', 'CON', 'x'.repeat(128)]) {
    const hit = entries.find((e) => e.senderId && sid.startsWith(e.senderId.slice(0, 20)));
    assert.ok(hit, `the invalid id ${sid.slice(0, 20)} was reassigned, sender_id kept`);
  }
  assert.ok(doc.entries['dup-1'], 'the first dup-1 kept its id');
  assert.equal(bySender('dup-1').length, 1, 'the different-content collision got a fresh id and sender_id dup-1');
  const reasons = (await rig.rows('mail-id-reassigned')).map((r) => r.reason).sort();
  assert.deepEqual(reasons, ['collision-ledger', 'invalid', 'invalid', 'invalid', 'invalid'].sort(), 'four invalid ids and one collision reassigned');

  // Nothing written outside the recipient's inbox.
  const all = walk(rig.sandbox);
  assert.deepEqual(all.filter((p) => /evil/i.test(path.basename(p))), [], 'no file named after the traversal id anywhere');
  const inbox = path.join(rig.agentDir('cl-2'), 'inbox');
  const files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 6);
  assert.deepEqual(fs.readdirSync(path.join(rig.sandbox, 'harness', 'hive', 'agents')).sort(), ['cl-1', 'cl-2', 'god-1'], 'no new agent directory');
});

// ——————————————————————————————————————————————————————————————————————————— F9

test('F9 mail to an archived agent (explicit archive): the sender is bounced, the archived inbox is untouched', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  await rig.call('register', { id: 'cl-2', provider: 'claude' });
  await rig.call('archiveExplicit', { id: 'cl-2' });   // the human/god archive action (hive:setArchived)
  const before = fs.readdirSync(path.join(rig.agentDir('cl-2'), 'inbox'));
  rig.cue('cl-1', { cue: 'reply', to: 'cl-2', subject: 'are you there', body: 'hello archived', file: 'b1' });
  await waitFor(async () => (await rig.rows('drop')).some((r) => r.reason === 'archived'), { what: 'the archived drop row' });
  assert.deepEqual(fs.readdirSync(path.join(rig.agentDir('cl-2'), 'inbox')), before, 'the archived inbox is untouched');
  const bounce = await waitFor(async () => Object.values((await rig.call('ledger', { id: 'cl-1' })).entries).find((e) => e.from === 'system' && /^\[undeliverable: cl-2 is archived/.test(e.subject)), { what: 'the bounce in the sender ledger' });
  await beatUntil(rig, () => acted(rig, 'cl-1', bounce.id), { what: 'the bounce reaches the sender' });
  assert.ok(rig.contexts('cl-1').some((c) => c.ids.includes(bounce.id)), 'the sender SAW the bounce');
});

// ——————————————————————————————————————————————————————————————————————————— F9 (Q32 reasons)

test('F9b archive reasons (Q32, god 0f1672): a crash (PTY exit) and the boot orphan pass keep mail flowing; a tab kill and the explicit archive bounce and set mail aside', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }, { id: 'cl-c', flavour: 'claude', scenario: { manualTurns: true } }]);
  const reason = async (id) => (await rig.call('registry')).agents[id];
  // A crash: the process exits on its own (index.ts onExit -> teardownPty(id, 'pty-exit')).
  rig.cue('cl-c', { cue: 'crash' });
  await waitFor(async () => (await reason('cl-c'))?.archived === true, { what: 'the crashed agent archived' });
  assert.equal((await reason('cl-c')).archiveReason, 'pty-exit');
  const kept = await rig.call('send', { to: 'cl-c', subject: 'while down', body: 'keep me' });
  assert.ok(kept?.id, 'routed, not refused');
  await waitFor(() => rig.inboxFiles('cl-c').includes(kept.id), { what: 'delivered into the crashed agent\'s inbox' });
  assert.equal((await rig.entry('cl-c', kept.id))?.state, 'delivered');
  assert.ok(!(await rig.rows('drop')).some((r) => r.reason === 'archived'), 'no archived drop for a crash');
  // The boot orphan pass (index.ts archiveOrphanedAgents -> setArchived(id, true, 'orphan')).
  await rig.call('register', { id: 'cl-o', provider: 'claude' });
  await rig.call('archiveOrphan', { id: 'cl-o' });
  assert.equal((await reason('cl-o')).archiveReason, 'orphan');
  const kept2 = await rig.call('send', { to: 'cl-o', subject: 'orphan', body: 'keep me too' });
  await waitFor(() => rig.inboxFiles('cl-o').includes(kept2.id), { what: 'delivered into the orphan\'s inbox' });
  // A tab kill (pty:kill -> teardownPty(id), the explicit default) bounces.
  await rig.call('killPty', { id: 'cl-1' });
  assert.equal((await reason('cl-1')).archiveReason, 'explicit');
  // The explicit archive of the crashed agent (hive:setArchived) sets its unread mail aside and bounces new mail.
  await rig.call('archiveExplicit', { id: 'cl-c' });
  assert.equal((await reason('cl-c')).archiveReason, 'explicit');
  await waitFor(() => !rig.inboxFiles('cl-c').includes(kept.id), { what: 'set aside' });
  assert.ok(fs.readdirSync(path.join(rig.agentDir('cl-c'), 'inbox', '.undelivered')).includes(`${kept.id}.json`), 'in .undelivered/');
  await rig.call('send', { to: 'cl-c', subject: 'after', body: 'bounce me' });
  await rig.call('send', { to: 'cl-1', subject: 'after kill', body: 'bounce me too' });
  await waitFor(async () => (await rig.rows('drop')).filter((r) => r.reason === 'archived').length >= 2, { what: 'two archived drop rows' });
});

// ——————————————————————————————————————————————————————————————————————————— F10

test('F10 old-habit agent bulk-moves inbox/*.json mid-turn: unsurfaced mail is still surfaced (from .done), mail-agent-moved rows', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const m1 = await rig.call('send', { to: 'cl-1', subject: 'f10 one', body: 'first' });
  await rig.beat();
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m1.id)), { what: 'm1 surfaced' });
  const m2 = await rig.call('send', { to: 'cl-1', subject: 'f10 two', body: 'arrived mid-turn' });
  const m3 = await rig.call('send', { to: 'cl-1', subject: 'f10 three', body: 'also mid-turn' });
  rig.cue('cl-1', { cue: 'bulk-move' });   // mv inbox/*.json inbox/.done/
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(() => rig.contexts('cl-1').some((c) => c.event === 'PostToolUse' && c.ids.includes(m2.id) && c.ids.includes(m3.id)), { what: 'm2, m3 surfaced from .done at PostToolUse' });
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(async () => (await acted(rig, 'cl-1', m1.id)) && (await acted(rig, 'cl-1', m2.id)) && (await acted(rig, 'cl-1', m3.id)), { what: 'all acted' });
  const moved = (await rig.rows('mail-agent-moved')).map((r) => r.id).sort();
  assert.deepEqual(moved, [m2.id, m3.id].sort(), 'mail-agent-moved rows for the two unsurfaced messages');
  assert.deepEqual(rig.doneFiles('cl-1'), [m1.id, m2.id, m3.id].sort());
});

// ——————————————————————————————————————————————————————————————————————————— F11

test('F11 Stop never arrives (AGY false-active): the 30-minute stale-epoch back-edge fires once on the simulated clock; the marker is shown', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'ag-1', flavour: 'agy', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'ag-1', subject: 'f11', body: 'the Stop is lost' });
  await rig.beat();
  await waitFor(() => rig.contexts('ag-1').some((c) => c.ids.includes(m.id)), { what: 'surfaced at PreInvocation' });
  await waitFor(async () => (await rig.entry('ag-1', m.id))?.state === 'surfaced', { what: 'confirmed by latency' });
  // No Stop. AGY's statusline goes idle (the native idle the coordinator believes after its grace).
  rig.cue('ag-1', { cue: 'statusline', state: 'idle' });
  await waitFor(() => rig.transcript('ag-1').some((r) => r.kind === 'statusline' && r.installed), { what: 'statusline tick' });
  await rig.call('advance', { ms: 10_000 });
  await rig.beat();
  await waitFor(async () => (await rig.call('wakeState', { id: 'ag-1' })).lifecycle === 'idle', { what: 'lifecycle idle' });
  assert.equal((await rig.entry('ag-1', m.id)).state, 'surfaced', 'idle alone acts nothing (§11.7)');
  await rig.call('advance', { ms: 29 * 60_000 });
  await rig.beat();
  assert.equal((await rig.call('diags')).filter((d) => d.stage === 'mail-epoch-stale').length, 0, 'not before 30 minutes');
  await rig.call('advance', { ms: 2 * 60_000 });
  await rig.beat();
  await waitFor(async () => (await rig.call('diags')).some((d) => d.stage === 'mail-epoch-stale' && d.agentId === 'ag-1'), { what: 'the stale back-edge' });
  // The re-delivered mail is woken again and shown with the marker; that turn ends properly.
  await beatUntil(rig, () => rig.contexts('ag-1').filter((c) => c.ids.includes(m.id)).length >= 2, { what: 're-surfaced at the next beat', stepMs: 15_000, settle: false, holdForStubs: true });
  const again = rig.contexts('ag-1').filter((c) => c.ids.includes(m.id))[1];
  assert.ok(again.context.includes(REDELIVERED), 'the marker is shown');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'ag-1', m.id), { what: 'acted at the next real Stop' });
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 31 * 60_000 }); await rig.beat(); await sleep(200); }
  assert.equal((await rig.call('diags')).filter((d) => d.stage === 'mail-epoch-stale' && d.agentId === 'ag-1').length, 1, 'the back-edge fired ONCE');
});

// ——————————————————————————————————————————————————————————————————————————— Q38

test('Q38 (§11.18 #41) Codex: the UserPromptSubmit hook never arrives and the turn ends before the 15 s beat: the mail is re-offered at that Stop (mail-repend, unconfirmedStart:true)', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cx-1', flavour: 'codex', scenario: { hookMode: 'ups-silent', manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cx-1', subject: 'q38', body: 'a short turn' });
  const commits = async () => (await rig.call('outcomes')).filter((o) => o.agentId === 'cx-1' && o.outcome.kind === 'COMMITTED').length;
  // ONE beat: a further beat would read the rollout's task_started and confirm the start, which
  // is exactly what this case must not have (a beatUntil loop raced the COMMITTED against its next
  // beat under load). After Rig.setup's boot barrier the first reconcile beat claims.
  await rig.beat();
  await waitFor(async () => (await commits()) >= 1, { what: 'the wake COMMITTED', diag: () => rig.diagnose('cx-1') });
  await waitFor(() => rig.prompts('cx-1').length >= 1, { what: 'the wake typed' });
  await waitFor(async () => !(await rig.call('wakeState', { id: 'cx-1' })).inFlight, { what: 'the wake settled' });
  // No beat yet: the rollout's task_started has not been read, the start is unconfirmed.
  const before = await rig.call('wakeState', { id: 'cx-1' });
  assert.equal(before.lifecycle, 'active');
  assert.equal(before.provisional, true, 'the turn start was never confirmed');
  assert.deepEqual(before.announced, [m.id]);
  // The Codex case exactly: its UserPromptSubmit never reached the app (the shim died), and no beat
  // has read the rollout's task_started yet.
  // LOAD-FLAKES-176: the stub records its (dead) UserPromptSubmit when IT gets there: wait for it.
  await waitFor(() => rig.hooks('cx-1', 'UserPromptSubmit').length >= 1, { what: 'the stub tried its UserPromptSubmit' });
  const ups = rig.hooks('cx-1', 'UserPromptSubmit');
  assert.ok(ups.length >= 1 && ups.every((h) => h.transport === 'none'), 'no UserPromptSubmit reached the app');
  assert.equal((await rig.call('diags')).filter((d) => d.agentId === 'cx-1' && d.stage === 'codex-rollout' && d.confirmed).length, 0, 'no rollout confirmation before the Stop');
  const ends = rig.turnEnds('cx-1').length;
  rig.cue('cx-1', { cue: 'stop' });
  await waitFor(() => rig.turnEnds('cx-1').length > ends, { what: 'turn end' });
  // Re-offered: a second COMMITTED wake for the same id, on the Stop's own edge (or, if the owner
  // refused that instant, the next beat: without the re-pend nothing would ever offer it again).
  await beatUntil(rig, async () => (await commits()) >= 2, { what: 'the mail re-offered', stepMs: 15_000, settle: false, holdForStubs: true });
  const row = (await rig.rows('mail-repend')).find((r) => r.agentId === 'cx-1');
  assert.ok(row, 'a mail-repend row');
  assert.equal(row.unconfirmedStart, true);
  assert.equal(row.reason, 'stop');
  assert.deepEqual(row.requeued, [m.id]);
  assert.equal((await rig.entry('cx-1', m.id)).state, 'delivered', 'never acted: it never reached the model');
  const outs = (await rig.call('outcomes')).filter((o) => o.agentId === 'cx-1' && o.outcome.kind === 'COMMITTED');
  assert.ok(outs[1].requestId.endsWith(':1') && outs[0].requestId.endsWith(':0'), 'the re-announcement is a new request (the next generation)');
});

// ——————————————————————————————————————————————————————————————————————————— F12

test('F12 hook shim exits 127 (zero hook traffic): degrades after 3 wakes, mail-channel-degraded, the mail is still read', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-z', flavour: 'claude', scenario: { hookMode: 'exit127' } }]);
  const m = await rig.call('send', { to: 'cl-z', subject: 'f12', body: 'hooks are dead' });
  await beatUntil(rig, async () => (await rig.rows('mail-channel-degraded')).length > 0, { what: 'degradation', stepMs: 6 * 60_000, settle: false, holdForStubs: true });
  const row = (await rig.rows('mail-channel-degraded'))[0];
  assert.equal(row.reason, 'zero-hook-traffic');
  const commits = (await rig.call('outcomes')).filter((o) => o.agentId === 'cl-z' && o.outcome.kind === 'COMMITTED').length;
  assert.equal(commits, 3, 'after exactly 3 COMMITTED wakes');
  assert.equal((await rig.call('channelOverride', { id: 'cl-z' })).mode, 'legacy-read');
  await beatUntil(rig, () => acted(rig, 'cl-z', m.id), { what: 'the degraded agent reads and moves it', stepMs: 6 * 60_000, settle: false, holdForStubs: true });
  assert.ok(rig.prompts('cl-z').some((p) => /Mail channel degraded/.test(p.text) && p.text.includes(m.id)), 'the degraded nudge names the file and says to move it');
  assert.ok(rig.transcript('cl-z').some((r) => r.kind === 'read-file' && r.id === m.id), 'mail still read');
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'acted' && r.ids.includes(m.id) && r.mode === 'legacy-move'), 'acted by its own move (§11.7)');
  assert.equal(rig.hooks('cl-z').filter((h) => h.exit !== 127).length, 0, 'no hook ever reached the app');
});

test('F12 hook fires but returns nothing (the UserPromptSubmit shim dies silently): degrades after 3 wakes with no mail block; mail still read', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cx-1', flavour: 'codex', scenario: { hookMode: 'ups-silent', manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cx-1', subject: 'f12b', body: 'the block never arrives' });
  const commits = async () => (await rig.call('outcomes')).filter((o) => o.agentId === 'cx-1' && o.outcome.kind === 'COMMITTED').length;
  for (let round = 0; round < 6 && !(await rig.rows('mail-channel-degraded')).length; round++) {
    const n = await commits();
    await beatUntil(rig, async () => (await commits()) > n, { what: `wake ${round + 1} COMMITTED`, stepMs: 6 * 60_000, settle: false, holdForStubs: true });
    // The next 15 s beat reads the rollout: its task_started confirms the turn start (the silent
    // UserPromptSubmit never does). Then the turn ends with its Stop and no mail block.
    // LOAD-FLAKES-176: only once the stub has started that turn (task_started written), not before.
    await rig.waitStubsIdle({ what: `wake ${round + 1}'s turn started in the stub` });
    await rig.call('advance', { ms: 15_000 });
    await rig.beat();
    await waitFor(async () => (await rig.call('wakeState', { id: 'cx-1' })).turn.turnStartAt > 0 && !(await rig.call('wakeState', { id: 'cx-1' })).provisional, { what: 'turn start confirmed by the rollout' });
    const ends = rig.turnEnds('cx-1').length;
    rig.cue('cx-1', { cue: 'stop' });
    await waitFor(() => rig.turnEnds('cx-1').length > ends, { what: 'turn end' });
    await sleep(300);
  }
  const row = (await rig.rows('mail-channel-degraded'))[0];
  assert.ok(row, 'degraded');
  assert.equal(row.reason, 'no-mail-block');
  assert.equal(rig.contexts('cx-1').filter((c) => c.ids.length).length, 0, 'no mail block ever reached it');
  // Degraded. Codex's wake is its fixed sentinel in every mode (CODEX-BLOAT), so the running
  // session cannot be told (Creed Q27 reaches only nudge-text providers): the legacy-read P1
  // arrives with its NEXT spawn (Q-slice-5), and then the sentinel wake makes it read its inbox.
  const promptsAtDegrade = rig.prompts('cx-1').length;
  for (let i = 0; i < 2; i++) { await rig.call('advance', { ms: 6 * 60_000 }); await rig.beat(); await sleep(400); }
  assert.ok(!rig.transcript('cx-1').some((r) => r.kind === 'read-file'), 'the running (inject-P1) session never reads files');
  await rig.respawn({ id: 'cx-1', flavour: 'codex', scenario: { hookMode: 'ups-silent', manualTurns: true } });
  await beatUntil(rig, () => rig.transcript('cx-1').some((r) => r.kind === 'read-file' && r.id === m.id), { what: 'mail still read after the respawn', stepMs: 6 * 60_000, settle: false, holdForStubs: true });
  assert.ok(rig.prompts('cx-1').length > promptsAtDegrade);
  // Its turn start is confirmed by the rollout at the next beat (the UserPromptSubmit is still
  // silent); legacy-read acts the ids the CONFIRMED wake named, at its Stop (§11.18 #19).
  await waitFor(async () => { const s2 = await rig.call('wakeState', { id: 'cx-1' }); return !s2.inFlight; }, { what: 'the wake settled' });
  // LOAD-FLAKES-176: no stub wait here: the read-file above is written in runTurn after task_started.
  await rig.call('advance', { ms: 15_000 });
  await rig.beat();
  await waitFor(async () => !(await rig.call('wakeState', { id: 'cx-1' })).provisional, { what: 'turn start confirmed by the rollout' });
  rig.cue('cx-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cx-1', m.id), { what: 'acted at its Stop' });
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'acted' && r.ids.includes(m.id) && r.mode === 'legacy-read'), 'acted at Stop in legacy-read mode');
});
