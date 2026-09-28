'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 7: the open-request UI (INBOX-DESIGN.md §4.3, §11.13 option B, §11.18 #1)
 * and the once-only §7.1 step-2 undelivered report. Main's view over a real (jailed) hive, the
 * pure renderer helpers, and the views rendered with react-dom/server (no window, no Electron).
 *  - every act:"request" (and requires_reply) is listed until replied or closed, with id,
 *    from -> to, subject, age and the "missing" flag; the Command Center badge counts them;
 *  - the Human's explicit close is the ONLY caller of closeObligation; it wakes nobody;
 *  - the undelivered report shows while unseen, never after the dismiss.
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-open-req-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');
const R = loadTs('src/main/mailReaders.ts');
const UI = loadTs('src/renderer/src/components/OpenRequestsTab.tsx');
const { readSource, codeOnly } = require('./read-source.cjs');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'codex', cwd: home });
  return { hive };
}
const html = (el) => renderToStaticMarkup(el);

test('main view: every open request / awaited reply of the active agents, with from, subject, age and missing', async (t) => {
  const { hive } = await floor(t);
  const q = hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'please' }, 'god-1');
  const lost = hive.send({ to: 'jim-1', act: 'request', subject: 'Audit', body: 'x' }, 'god-1');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'fyi', body: 'no reply owed' }, 'god-1');
  hive.mail.bodyMissing('jim-1', lost.id, 'missing');
  const view = hive.mailObligations();
  assert.deepEqual(view.map((a) => [a.agentId, a.name, a.openRequestCount]), [['andy-1', 'Andy', 1], ['jim-1', 'Jim', 1]], 'only agents that owe something');
  const rows = UI.openRequestRows(view);
  assert.deepEqual(rows.map((r) => [r.agentId, r.id, r.from, r.subject, r.kind, r.missing]).sort(),
    [['andy-1', q.id, 'god-1', 'Review PR 12', 'request', false], ['jim-1', lost.id, 'god-1', 'Audit', 'both', true]].sort(), 'the lost one is acted (Q15), so it is also an awaited reply');
  assert.equal(UI.openRequestsBadgeCount({ agents: view, undelivered: null }), 2);
  // An archived agent is not on the list (its mail bounced or was set aside).
  hive.setArchived('jim-1', true);
  assert.deepEqual(hive.mailObligations().map((a) => a.agentId), ['andy-1']);
});

test('the explicit close is the Human\'s: it closes exactly that obligation, logs it, and a reply after it closes nothing', async (t) => {
  const { hive } = await floor(t);
  const q = hive.send({ to: 'andy-1', act: 'request', subject: 'Ship it', body: 'go' }, 'god-1');
  assert.deepEqual(hive.closeMailObligation('nobody', q.id), [], 'not a registry agent');
  assert.deepEqual(hive.closeMailObligation('andy-1', '../x'), [], 'not a mail id');
  assert.deepEqual(hive.closeMailObligation('andy-1', 7), []);
  assert.deepEqual(hive.closeMailObligation('andy-1', q.id), [q.id]);
  assert.deepEqual(hive.mailObligations(), []);
  const row = hive.logTail(500).find((r) => r && r.kind === 'mail-obligation-closed');
  assert.equal(row.reason, 'closed-by-human');
  assert.deepEqual(hive.closeMailObligation('andy-1', q.id), [], 'idempotent');
  // Zero-token: closing writes no message to anyone.
  const inboxes = ['god-1', 'andy-1'].map((id) => fs.readdirSync(path.join(hive.root(), 'agents', id, 'inbox')).filter((n) => n.endsWith('.json')).length);
  assert.deepEqual(inboxes, [0, 1], 'only the original request exists');
});

test('rows: one per (agent, id) across both lists, oldest first; the badge counts distinct obligations, full counts beyond the bound', () => {
  const o = (id, ageSec, extra = {}) => ({ id, from: 'god-1', act: 'request', subject: `s ${id}`, state: 'acted', ageSec, ...extra });
  const agents = [{ agentId: 'a', name: 'A', openRequests: [o('r1', 60), o('r2', 3600)], openRequestCount: 2, awaitingReply: [o('r2', 3600)], awaitingReplyCount: 1 }];
  const rows = UI.openRequestRows(agents);
  assert.deepEqual(rows.map((r) => [r.id, r.kind]), [['r2', 'both'], ['r1', 'request']]);
  assert.equal(UI.openRequestsBadgeCount({ agents }), 2);
  assert.equal(UI.openRequestsBadgeCount({ agents: [{ ...agents[0], openRequestCount: 70 }] }), 70);
  assert.equal(UI.openRequestsBadgeCount(null), 0);
  assert.deepEqual(UI.openRequestRows(undefined), []);
  assert.deepEqual(['42s', '17m', '5h', '3d'], [42, 17 * 60, 5 * 3600, 3 * 86400].map(UI.formatObligationAge));
  // main's own helper agrees on the count.
  assert.equal(R.openObligationCount(agents), 2);
});

test('the list view renders id, from -> to, subject, age, kind and the missing flag, with a two-click close', () => {
  const rows = [
    { agentId: 'andy-1', agentName: 'Andy', id: 'q-1', from: 'god-1', subject: 'Review <PR>', ageSec: 1200, state: 'surfaced', kind: 'request', missing: false },
    { agentId: 'jim-1', agentName: 'Jim', id: 'q-2', from: 'god-1', subject: 'Audit', ageSec: 30, state: 'acted', kind: 'reply', missing: true }
  ];
  const out = html(React.createElement(UI.OpenRequestsView, { rows, confirming: 'andy-1|q-1', onClose: () => {} }));
  for (const s of ['q-1', 'god-1 → Andy', 'Review &lt;PR&gt;', '20m', 'q-2', 'god-1 → Jim', '30s', 'reply expected', 'data-missing', 'confirm close']) assert.ok(out.includes(s), s);
  assert.equal((out.match(/data-missing/g) || []).length, 1, 'only the missing one is flagged');
  assert.ok(html(React.createElement(UI.OpenRequestsView, { rows: [] })).includes('No open requests.'));
  assert.doesNotMatch(html(React.createElement(UI.OpenRequestsView, { rows })), /confirm close|>close</, 'no action without a handler');
});

test('the undelivered report banner: shown while unseen, never after the dismiss, never for an empty report', () => {
  const report = { version: 1, createdAt: 1, updatedAt: 1, seenAt: null, items: [
    { agentId: 'meredith-1', id: 'm0', file: 'agents/meredith-1/inbox/.undelivered/m0.json', from: 'god-1', act: 'request', subject: 'Deploy', createdAt: null, movedAt: 1 }
  ] };
  const out = html(React.createElement(UI.UndeliveredMailBannerView, { report, onDismiss: () => {} }));
  for (const s of ['1 unread message to archived agents was set aside', 'meredith-1: 1', 'm0', 'Deploy', 'dismiss', 'inbox/.undelivered']) assert.ok(out.includes(s), s);
  assert.equal(html(React.createElement(UI.UndeliveredMailBannerView, { report: { ...report, seenAt: 5 } })), '');
  assert.equal(html(React.createElement(UI.UndeliveredMailBannerView, { report: { ...report, items: [] } })), '');
  assert.equal(html(React.createElement(UI.UndeliveredMailBannerView, { report: null })), '');
});

test('WIRING: closeObligation has ONE caller (the Human\'s IPC); the Command Center has the badge, the tab and the banner; nothing wakes', () => {
  const callers = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n.name)) {
        const src = codeOnly(readSource(p), n.name);
        if (/\.closeObligation\(/.test(src)) callers.push(path.relative(path.resolve(__dirname, '..'), p).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.resolve(__dirname, '..', 'src'));
  assert.deepEqual(callers, ['src/main/hive.ts']);
  const hiveSrc = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  assert.equal((hiveSrc.match(/\.closeObligation\(/g) || []).length, 1);
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(idx, /ipcMain\.handle\('hive:closeObligation'[\s\S]{0,300}hive\.closeMailObligation\(agentId, id\)/);
  assert.equal((idx.match(/closeMailObligation\(/g) || []).length, 1, 'the IPC is the only path to it');
  assert.match(idx, /ipcMain\.handle\('hive:mailObligations'/);
  assert.match(idx, /ipcMain\.handle\('hive:undeliveredSeen'[\s\S]{0,200}hive\.markUndeliveredSeen\(\)/);
  const cc = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'), 'CommandCenterPanel.tsx');
  assert.match(cc, /key: 'requests'/);
  assert.match(cc, /data-open-requests-badge/);
  assert.match(cc, /<UndeliveredMailBanner /);
  assert.match(cc, /tab === 'requests' && <OpenRequestsTab /);
  const ui = codeOnly(readSource('src/renderer/src/components/OpenRequestsTab.tsx'), 'OpenRequestsTab.tsx');
  assert.doesNotMatch(ui, /RequestInboxWake|hiveSend|wake\(/i, 'the UI never wakes an agent');
});
