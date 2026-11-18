'use strict';
require('./tools/own-job.cjs');

/**
 * ARMED-TRIGGERS-LOST-ON-RESTART (A9). Done-test (ROADMAP-108-SCOPE): "arm a post-install task,
 * restart the app, and it fires".
 *
 * Live case: Jim was armed for POST-INSTALL-161, and the arm lived only in his session context.
 * The one durable arm a card can carry is `waitingFor: "install"` + `fixVersion` (PROTOCOL), and
 * it never reached the agent who armed it:
 *   gap 1  detectStale checked installWait only for doing/blocked cards, so an armed TODO card
 *          (the usual post-install card) was never flagged (live: CLAIMS-FREEZE-GUARD, todo,
 *          fixVersion 1.1.98, silent under 1.1.107);
 *   gap 2  SHIPPED_INSTALLED was only a floor-digest item, and the digest wakes god. Nothing was
 *          ever sent to the assignee.
 *
 * Each "restart" here is a NEW HiveManager and a NEW BoardMonitor on the same hive home, with
 * a newer running version: nothing in memory survives, only the hive on disk.
 *
 *   R1  gap 1: an armed todo card whose fixVersion is installed is flagged SHIPPED_INSTALLED.
 *   R2  done-test: armed under 1.1.107, restarted into 1.1.108, the assignee gets one inform.
 *   R3  gap 2 for a doing card: the assignee is told, not only god's digest.
 *   R4  once per (card, fixVersion): a further restart sends nothing more; the record is durable.
 *   R5  at-least-once (god b92c29): a crash between the send and the record (the record write
 *       fails) sends it again on the next start - a duplicate, never a silent loss.
 *   R6  a new fixVersion arms it again.
 *   R7  an assignee who is not registered is not sent to and not recorded; once registered, sent.
 *   R8  a registered assignee with no inbox (undeliverable) is not recorded; once the inbox
 *       exists, it fires.
 *   G1  guards: a done card, an unarmed card, a fixVersion not reached yet: never sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { BoardMonitor } = loadTs('src/main/boardMonitor.ts');

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const agent = (id, extra = {}) => ({ id, name: id, cwd: '.', status: 'idle', lastSeen: 0, ...extra });
const ARMED = (extra = {}) => ({ id: 'POST-INSTALL-161', title: 'verify after install', status: 'todo', assignee: 'jim', waitingFor: 'install', fixVersion: '1.1.108', ...extra });

function rig(t, agents, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-armed-'));
  let hive = null;
  let monitor = null;
  const stop = () => { try { monitor?.stop(); } catch { /* noop */ } try { hive?.dispose(); } catch { /* noop */ } monitor = null; hive = null; };
  t.after(() => { stop(); fs.rmSync(home, { recursive: true, force: true }); });
  /** A fresh process: new HiveManager + new BoardMonitor, running `version`. */
  const boot = (version) => {
    stop();
    hive = new HiveManager(() => home);
    hive.ensureHive();
    hive.ledgerGuard.check();
    monitor = new BoardMonitor({ hive, now: () => NOW, runningVersion: () => version });
    monitor.tick();
    return { hive, monitor };
  };
  const first = new HiveManager(() => home);
  first.ensureHive();
  const root = first.root();
  // A registered agent has its folder (agents/<id>/inbox), as on a live floor: the router
  // delivers only into an existing inbox.
  const mkInboxes = (a) => { for (const id of Object.keys(a)) fs.mkdirSync(path.join(root, 'agents', id, 'inbox'), { recursive: true }); };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: null, agents }, null, 2));
  mkInboxes(agents);
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }, null, 2));
  first.dispose();
  const inbox = (id) => {
    const dir = path.join(root, 'agents', id, 'inbox');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  const setTasks = (list) => { fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: list }, null, 2)); };
  const setAgents = (a) => { fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: null, agents: a }, null, 2)); mkInboxes(a); };
  const log = () => fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { root, boot, inbox, setTasks, setAgents, log, flags: () => monitor.flags() };
}

const triggers = (msgs) => msgs.filter((m) => m.card === 'POST-INSTALL-161' && /app-start/.test(String(m.subject)));

test('R1 gap 1: an armed TODO card whose fixVersion is installed is flagged SHIPPED_INSTALLED', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED()]);
  r.boot('1.1.108');
  const f = r.flags().filter((x) => x.kind === 'SHIPPED_INSTALLED');
  assert.deepEqual(f.map((x) => [x.cardId, x.agentId, x.fixVersion]), [['POST-INSTALL-161', 'jim', '1.1.108']],
    'a todo card armed for an installed fix must be flagged, as a doing card is');
});

test('R2 done-test: armed under 1.1.107, restarted into 1.1.108, the assignee gets exactly one inform', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED()]);
  r.boot('1.1.107');
  assert.equal(triggers(r.inbox('jim')).length, 0, 'not installed yet: nothing fires');
  r.boot('1.1.108');
  const got = triggers(r.inbox('jim'));
  assert.equal(got.length, 1, 'after the restart into 1.1.108 the armed card fires to its assignee');
  const m = got[0];
  assert.equal(m.to, 'jim');
  assert.equal(m.from, 'system');
  assert.equal(m.act, 'inform');
  assert.match(m.subject, /^app-start 1\.1\.108: POST-INSTALL-161 /);
  assert.match(m.subject, /fix 1\.1\.108 is installed/);
});

test('R3 gap 2: an armed DOING card tells its assignee, not only god', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED({ status: 'doing' })]);
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 1);
});

test('R4 once per (card, fixVersion): another restart sends nothing more, and the record is on disk', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED()]);
  r.boot('1.1.108');
  r.boot('1.1.108');
  r.boot('1.1.109');
  assert.equal(triggers(r.inbox('jim')).length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(r.root, 'state', 'install-triggers.json'), 'utf8'));
  assert.ok(rec.fired && rec.fired['POST-INSTALL-161@1.1.108'], 'the fired record is keyed card@fixVersion');
  assert.equal(rec.fired['POST-INSTALL-161@1.1.108'].to, 'jim');
});

test('R5 at-least-once: a failed record write sends again on the next start (a duplicate, never silent)', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED()]);
  // The record cannot be written: its path is a directory (a crash between send and record).
  fs.mkdirSync(path.join(r.root, 'state', 'install-triggers.json'), { recursive: true });
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 1, 'the send happens before the record');
  assert.ok(r.log().some((l) => l.kind === 'install-trigger-record-failed' && l.cardId === 'POST-INSTALL-161'),
    'the failed record is logged');
  fs.rmSync(path.join(r.root, 'state', 'install-triggers.json'), { recursive: true, force: true });
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 2, 'not recorded, so it fires again: at-least-once');
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 2, 'now recorded: no third');
});

test('R6 a new fixVersion arms the card again', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED()]);
  r.boot('1.1.108');
  r.setTasks([ARMED({ fixVersion: '1.1.109' })]);
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 1, '1.1.109 is not installed yet');
  r.boot('1.1.109');
  const got = triggers(r.inbox('jim'));
  assert.equal(got.length, 2);
  assert.ok(got.some((m) => /^app-start 1\.1\.109: .*fix 1\.1\.109 is installed/.test(m.subject)));
});

test('R7 an assignee who is not registered is skipped and not recorded; once registered, it fires', (t) => {
  const r = rig(t, { ann: agent('ann') }, [ARMED()]);
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 0);
  r.setAgents({ ann: agent('ann'), jim: agent('jim') });
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 1, 'skipped, not recorded: it fires once jim is back');
});

test('R8 an undeliverable send (no inbox) is not recorded as fired; once the inbox exists, it fires', (t) => {
  const r = rig(t, { jim: agent('jim') }, [ARMED()]);
  fs.rmSync(path.join(r.root, 'agents', 'jim'), { recursive: true, force: true });
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 0);
  fs.mkdirSync(path.join(r.root, 'agents', 'jim', 'inbox'), { recursive: true });
  r.boot('1.1.108');
  assert.equal(triggers(r.inbox('jim')).length, 1, 'never recorded while undeliverable, so it fires once the inbox exists');
});

test('G1 guards: a done card, an unarmed card and a fix not reached are never sent', (t) => {
  const r = rig(t, { jim: agent('jim') }, [
    ARMED({ id: 'POST-INSTALL-161', fixVersion: '1.1.200' }),
    ARMED({ id: 'DONE-ONE', status: 'done' }),
    { id: 'PLAIN', title: 'plain', status: 'todo', assignee: 'jim' }
  ]);
  r.boot('1.1.108');
  r.boot('1.1.108');
  assert.equal(r.inbox('jim').filter((m) => /app-start/.test(String(m.subject))).length, 0);
});
