'use strict';

/**
 * Outbox files can be created by a non-atomic writer. The router used to parse
 * once, move a partial file to bad-*, and silently strand the intended work.
 * These tests exercise the polling boundary directly: leave a partial JSON file
 * in place for a later completed write, and make a truly malformed file visible
 * to its sender after the bounded retry budget expires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 300));
const olderThanFreshWriteGrace = (file) => {
  const old = new Date(Date.now() - 2_000);
  fs.utimesSync(file, old, old);
};

async function floor(t, Manager = HiveManager) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-rejection-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(process.env.HOME, home, 'HOME must be jailed before HiveManager construction');
  assert.equal(process.env.USERPROFILE, home, 'USERPROFILE must be jailed before HiveManager construction');
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    hive.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const events = [];
  const hive = new Manager(() => home, (channel, payload) => { events.push({ channel, payload }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { hive, events, outbox: path.join(hive.root(), 'agents', 'jim-1', 'outbox') };
}

test('a partial outbox write remains pending and routes after the writer finishes', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'partial.json');
  fs.writeFileSync(file, '{"to":"god-1","act":"inform"');

  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(file), true, 'a first partial read must not be quarantined');
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-partial.json')), false);
  assert.equal(hive.inbox('god-1').length, 0);
  assert.equal(hive.routeOnce(), 0, 'rapid watcher hints must not consume another retry');
  assert.equal(fs.existsSync(file), true);

  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'writer finished', body: 'delivered' }));
  assert.equal(hive.routeOnce(), 1);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'partial.json')), true);
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(hive.inbox('god-1')[0].subject, 'writer finished');
});

test('a writer that remains partial for more than one second is still delivered once it finishes', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'slow.json');
  fs.writeFileSync(file, '{"to":"god-1"');

  assert.equal(hive.routeOnce(), 0, 'a fresh file spends no parse retry budget');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(hive.routeOnce(), 0, 'the first eligible parse is still only one retry');
  assert.equal(fs.existsSync(file), true);
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'slow writer finished' }));

  assert.equal(hive.routeOnce(), 1);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'slow.json')), true);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-slow.json')), false);
  assert.equal(hive.inbox('god-1')[0].subject, 'slow writer finished');
});

test('a final malformed outbox rejection is logged, surfaced, and notices the sender', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const file = path.join(outbox, 'broken.json');
  fs.writeFileSync(file, '{ definitely not JSON');
  olderThanFreshWriteGrace(file);

  assert.equal(hive.routeOnce(), 0);
  await afterDebounce();
  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(file), true, 'the bounded retry still leaves the writer time to finish');
  assert.equal(hive.inbox('jim-1').length, 0);

  await afterDebounce();
  assert.equal(hive.routeOnce(), 0);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-broken.json')), true);
  const [notice] = hive.inbox('jim-1');
  assert.match(notice.subject, /^\[outbox rejected — malformed JSON after 3 attempts\] broken\.json$/);
  assert.match(notice.body, /after 3 attempts/);
  const [rejection] = hive.logTail(100).filter((entry) => entry.kind === 'outbox-rejected');
  assert.equal(rejection.from, 'jim-1');
  assert.equal(rejection.file, 'broken.json');
  assert.equal(rejection.reason, 'parse-failed');
  assert.match(rejection.detail, /malformed JSON after 3 attempts/);
  assert.equal(rejection.notified, true);
  assert.ok(events.some(({ channel, payload }) =>
    channel === 'hive:message' && payload.to === 'jim-1' && /^\[outbox rejected/.test(payload.subject)
  ), 'the sender notice must reach the floor event stream too');
});

test('parseable but unroutable files are rejected once with a sender notice', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const cases = [
    ['null.json', 'null', /message must be an object/],
    ['number-to.json', JSON.stringify({ to: 123 }), /to must be a string/],
    ['array-to.json', JSON.stringify({ to: ['god-1'] }), /to must be a string/]
  ];

  for (const [name, content, reason] of cases) {
    fs.writeFileSync(path.join(outbox, name), content);
    assert.equal(hive.routeOnce(), 0);
    assert.equal(fs.existsSync(path.join(outbox, '.sent', `bad-${name}`)), true, name);
    const matching = hive.inbox('jim-1').filter((message) => message.subject.endsWith(name));
    assert.equal(matching.length, 1, `${name} must notify exactly once`);
    assert.match(matching[0].subject, reason);
    const rows = hive.logTail(100).filter((entry) => entry.kind === 'outbox-rejected' && entry.file === name);
    assert.equal(rows.length, 1, `${name} must have one final rejection row`);
    assert.equal(rows[0].reason, 'route-failed');
    assert.match(rows[0].detail, reason);
  }

  assert.equal(hive.routeOnce(), 0, 'archived files cannot repeatedly reject');
  assert.equal(hive.inbox('jim-1').length, cases.length);
  assert.equal(events.filter(({ channel, payload }) => channel === 'hive:message' && payload.to === 'jim-1').length, cases.length);
});

async function replyLinkGapKiller(t, Manager) {
  const { hive, outbox } = await floor(t, Manager);
  const replyRequest = hive.send({ to: 'jim-1', act: 'request', subject: 'build the fix', body: 'please build it' }, 'god-1');
  const answerRequest = hive.send({ to: 'jim-1', act: 'request', subject: 'answer the question', body: 'please answer it' }, 'god-1');
  const cases = [
    ['reply-camel.json', { to: 'god-1', act: 'reply', subject: 'built', body: 'done', inReplyTo: replyRequest.id }],
    ['answer-linked.json', { to: 'god-1', act: 'answer', subject: 'answered', body: 'done', in_reply_to: answerRequest.id }],
    ['answer-unlinked.json', { to: 'god-1', act: 'answer', subject: 'status', body: 'FYI' }],
    ['ack.json', { to: 'god-1', act: 'ack', subject: 'acknowledged', body: 'ok' }],
    ['unknown-act.json', { to: 'god-1', act: 'sidequest', subject: 'bad', body: 'bad' }]
  ];
  for (const [file, payload] of cases) {
    const outboxFile = path.join(outbox, file);
    fs.writeFileSync(outboxFile, JSON.stringify(payload));
    olderThanFreshWriteGrace(outboxFile);
  }
  assert.equal(hive.routeOnce(), 4, 'REPLY-LINK GAP: known synonyms normalise and route; only the truly unknown act rejects');
  const delivered = hive.inbox('god-1');
  assert.equal(delivered.find((m) => m.subject === 'built').act, 'done', 'REPLY-LINK GAP: reply with camelCase link becomes done');
  assert.equal(delivered.find((m) => m.subject === 'built').in_reply_to, replyRequest.id, 'REPLY-LINK GAP: camelCase link is canonicalised');
  assert.equal(delivered.find((m) => m.subject === 'answered').act, 'done', 'REPLY-LINK GAP: linked answer becomes done');
  assert.equal(delivered.find((m) => m.subject === 'status').act, 'inform', 'REPLY-LINK GAP: unlinked answer becomes inform');
  assert.equal(delivered.find((m) => m.subject === 'acknowledged').act, 'agree', 'REPLY-LINK GAP: ack becomes agree');
  assert.deepEqual(hive.mail.openRequests('jim-1'), [], 'the canonicalised reply and answer close their requests');
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-unknown-act.json')), true, 'only the truly unknown act is terminally archived');
  const notice = hive.inbox('jim-1').find((m) => m.subject.endsWith('unknown-act.json'));
  assert.ok(notice, 'the unknown act tells its sender what to correct');
  assert.match(notice.subject, /act must be one of/);
  const normalised = hive.logTail(100).filter((entry) => entry.kind === 'outbox-normalised');
  assert.equal(normalised.length, 4, 'each known synonym produces a normalised log row without a bounce');
}

test('REPLY-LINK-GAP: normalise known reply spellings and reject only unknown acts', async (t) => {
  await replyLinkGapKiller(t, HiveManager);
});

const REPLY_LINK_MUTANTS = [
  {
    name: 'RLG-M1: camelCase link is not canonicalised',
    edits: [["if (Object.prototype.hasOwnProperty.call(wire, 'inReplyTo')) {", "if (false && Object.prototype.hasOwnProperty.call(wire, 'inReplyTo')) {"]]
  },
  {
    name: 'RLG-M2: reply and answer are rejected instead of normalised',
    edits: [["if (originalAct === 'reply' || originalAct === 'answer') {", "if (false && (originalAct === 'reply' || originalAct === 'answer')) {"]]
  },
  {
    name: 'RLG-M3: linked reply does not become done',
    edits: [["partial.act = partial.in_reply_to !== undefined && partial.in_reply_to !== null ? 'done' : 'inform';", "partial.act = 'inform';"]]
  },
  {
    name: 'RLG-M4: ack is rejected instead of agreeing',
    edits: [["} else if (originalAct === 'ack') {", "} else if (false && originalAct === 'ack') {"]]
  },
  {
    name: 'RLG-M5: truly unknown acts are silently accepted',
    edits: [['if (partial.act !== undefined && !isMessageAct(partial.act)) {', 'if (false && partial.act !== undefined && !isMessageAct(partial.act)) {']]
  }
];

test('MUTANT CENSUS REPLY-LINK-GAP: reply-schema mutants apply once and die at the link guarantee', async (t) => {
  const source = readSource('src/main/hive.ts');
  for (const [i, mutant] of REPLY_LINK_MUTANTS.entries()) {
    await t.test(`mutant: ${mutant.name}`, async (subtest) => {
      await replyLinkGapKiller(subtest, HiveManager);
      let text = source;
      for (const [from, to] of mutant.edits) {
        assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}" edit applies exactly once`);
        text = text.replace(from, to);
      }
      const { HiveManager: Mutant } = loadTs.fromText('src/main/hive.ts', text);
      let died = null;
      try { await replyLinkGapKiller(subtest, Mutant); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${mutant.name}`);
      assert.match(died.message, /REPLY-LINK GAP/, `${mutant.name} died at the wrong assertion`);
    });
  }
});

// MAIL-EMPTY-SUBJECT-BODY-195 (Dwight 2026-10-18T20-12-50): a message with no subject and no body
// was delivered as an empty mail. Both blank (whitespace counts as blank) is refused to the sender
// as unroutable; either one alone is a message and routes; a non-string subject or body is refused.
async function emptyMailKiller(t, Manager, L) {
  const { hive, outbox } = await floor(t, Manager);
  const refused = [
    ['empty.json', { to: 'god-1', act: 'inform' }, /subject and body are both empty/],
    ['blank.json', { to: 'god-1', act: 'inform', subject: '  ', body: '\n\t' }, /subject and body are both empty/],
    ['number-subject.json', { to: 'god-1', act: 'inform', subject: 5, body: 'x' }, /subject must be a string/],
    ['object-body.json', { to: 'god-1', act: 'inform', subject: 's', body: {} }, /body must be a string/]
  ];
  const routed = [
    ['subject-only.json', { to: 'god-1', act: 'done', subject: 'PASS @abc' }],
    ['body-only.json', { to: 'god-1', act: 'inform', body: 'just a body' }]
  ];
  for (const [file, payload] of [...refused, ...routed]) {
    const f = path.join(outbox, file);
    fs.writeFileSync(f, JSON.stringify(payload));
    olderThanFreshWriteGrace(f);
  }
  assert.equal(hive.routeOnce(), routed.length, 'EMPTY MAIL: only the messages that say something route');
  for (const [file, , reason] of refused) {
    assert.equal(fs.existsSync(path.join(outbox, '.sent', `bad-${file}`)), true, `EMPTY MAIL: ${file} goes to the failed state`);
    const notice = hive.inbox('jim-1').find((m) => m.subject.endsWith(file));
    assert.ok(notice, `EMPTY MAIL: the sender is told why ${file} was refused`);
    assert.match(notice.subject, reason, `EMPTY MAIL: ${file} names its reason`);
  }
  const got = hive.inbox('god-1');
  assert.deepEqual(got.map((m) => [m.subject, m.body]).sort(), [['', 'just a body'], ['PASS @abc', '']], 'EMPTY MAIL: a subject alone or a body alone is delivered');
  // The ledger path: a subject is required, and a blank one is none.
  const op = (message) => L.parseLedgerOp({ op: 'mesb-1', message: { to: 'god-1', act: 'inform', ...message } });
  assert.match(String(op({ subject: '  ', body: '' }).error), /message\.subject: required/, 'EMPTY MAIL: the ledger refuses a blank subject');
  assert.match(String(op({ subject: '', body: '' }).error), /message\.subject: required/, 'EMPTY MAIL: the ledger refuses an empty subject');
  assert.equal(op({ subject: 'PASS', body: '' }).ok, true, 'EMPTY MAIL: the ledger takes a subject alone');
}

const LEDGER = loadTs('src/main/ledger.ts');

test('MAIL-EMPTY-SUBJECT-BODY-195: a message with no subject and no body is refused to its sender; either alone routes', async (t) => {
  await emptyMailKiller(t, HiveManager, LEDGER);
});

const EMPTY_MAIL_MUTANTS = [
  { name: 'MESB-M1: both empty is delivered', file: 'src/main/hive.ts',
    edits: [["if (!partial.subject?.trim() && !partial.body?.trim()) throw", "if (false) throw"]] },
  { name: 'MESB-M2: whitespace counts as text', file: 'src/main/hive.ts',
    edits: [["if (!partial.subject?.trim() && !partial.body?.trim()) throw", "if (!partial.subject && !partial.body) throw"]] },
  { name: 'MESB-M3: either one empty is refused', file: 'src/main/hive.ts',
    edits: [["if (!partial.subject?.trim() && !partial.body?.trim()) throw", "if (!partial.subject?.trim() || !partial.body?.trim()) throw"]] },
  { name: 'MESB-M4: a non-string subject is not checked', file: 'src/main/hive.ts',
    edits: [["if (partial.subject !== undefined && typeof partial.subject !== 'string') throw", "if (false) throw"]] },
  { name: 'MESB-M5: a non-string body is not checked', file: 'src/main/hive.ts',
    edits: [["if (partial.body !== undefined && typeof partial.body !== 'string') throw", "if (false) throw"]] },
  { name: 'MESB-M6: the ledger takes a blank subject', file: 'src/main/ledger.ts',
    edits: [['if (!str(m.subject, 1000) || !m.subject.trim()) return', 'if (!str(m.subject, 1000)) return']] }
];

test('MUTANT CENSUS MAIL-EMPTY-SUBJECT-BODY-195: every mutant applies once and dies at an EMPTY MAIL assertion', async (t) => {
  for (const mutant of EMPTY_MAIL_MUTANTS) {
    await t.test(`mutant: ${mutant.name}`, async (subtest) => {
      let text = readSource(mutant.file);
      for (const [from, to] of mutant.edits) {
        assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}" edit applies exactly once`);
        text = text.replace(from, () => to);
      }
      const mutated = loadTs.fromText(mutant.file, text);
      const Manager = mutant.file === 'src/main/hive.ts' ? mutated.HiveManager : HiveManager;
      const L = mutant.file === 'src/main/ledger.ts' ? mutated : LEDGER;
      let died = null;
      try { await emptyMailKiller(subtest, Manager, L); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${mutant.name} (${died && died.message})`);
      assert.match(died.message, /EMPTY MAIL/, `${mutant.name} died at the wrong assertion: ${died.message}`);
    });
  }
});

async function archiveFailureLogKiller(t, Manager = HiveManager) {
  const { hive, events, outbox } = await floor(t, Manager);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => {
    if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent);
  });
  const file = path.join(outbox, 'delivered-before-archive.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'delivered before archive' }));

  assert.equal(hive.routeOnce(), 1, 'the message must be delivered before archive retry state is recorded');
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(hive.inbox('jim-1').length, 0);
  assert.equal(fs.existsSync(file), true, 'a failed archive leaves the delivered source file in place');
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-failed').length, 1);

  assert.equal(hive.routeOnce(), 0, 'an unchanged delivered file must only retry archival');
  assert.equal(hive.routeOnce(), 0, 'a third scan must still only retry archival');
  assert.equal(hive.routeOnce(), 0, 'a fourth scan must still only retry archival');
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-failed').length, 1,
    'ARCHIVE LOG NOISE: a held archive is reported once across repeated scans');
  assert.equal(hive.inbox('god-1').length, 1, 'archive retry must never redeliver');
  assert.equal(hive.inbox('jim-1').length, 0, 'archive failure must not reject the sender');

  fs.renameSync(heldSent, sent);
  assert.equal(hive.routeOnce(), 0, 'successful archive retry is not a new route');
  assert.equal(fs.existsSync(path.join(sent, 'delivered-before-archive.json')), true);
  assert.equal(hive.inbox('god-1').length, 1, 'successful archive retry still must not redeliver');
  assert.equal(hive.inbox('jim-1').length, 0);
  assert.deepEqual(hive.logTail(100)
    .filter((entry) => /^outbox-archive-(failed|cleared)$/.test(entry.kind))
    .map((entry) => entry.kind), ['outbox-archive-failed', 'outbox-archive-cleared'],
  'ARCHIVE LOG NOISE: the single stuck row is followed by one clear row');
  assert.equal(events.filter(({ channel, payload }) =>
    channel === 'hive:message' && /^\[outbox rejected/.test(payload.subject)
  ).length, 0, 'archive failure must produce no sender rejection notice');
}

test('a delivered message retries only its archive when .sent is temporarily unavailable', async (t) => {
  await archiveFailureLogKiller(t);
});

const ARCHIVE_LOG_NOISE_MUTANTS = [
  { name: 'ARCHIVE-LOG-NOISE-M1: log every held archive scan',
    edits: [['if (this.outboxArchiveFailures.has(full) && this.outboxArchiveFailures.get(full) === fingerprint) return;', 'if (false) return;']],
    killer: archiveFailureLogKiller },
  { name: 'ARCHIVE-LOG-NOISE-M2: never log a successful clear',
    edits: [['this.noteOutboxArchiveCleared(full, from, file);', '// clear omitted']], killer: archiveFailureLogKiller },
  { name: 'ARCHIVE-LOG-NOISE-M3: retain state for absent outbox files',
    edits: [['for (const full of this.outboxArchiveFailures.keys()) {\n      if (!liveOutboxFiles.has(full)) this.outboxArchiveFailures.delete(full);\n    }', '// archive failure state is never pruned']],
    killer: prunedDuplicateArchiveFailureLogKiller },
  { name: 'ARCHIVE-LOG-NOISE-M4: replacement pre-marks its new fingerprint as already reported',
    edits: [['this.outboxDeliveredArchives.delete(full);\n          // Its earlier archive failure belongs to the replaced payload, not this one.\n          this.outboxArchiveFailures.delete(full);', 'this.outboxDeliveredArchives.delete(full);\n          this.outboxArchiveFailures.set(full, this.outboxFingerprint(full));']],
    killer: replacedArchiveFailureLogKiller },
  { name: 'ARCHIVE-LOG-NOISE-M5: duplicate archive bypasses the once-only reporter',
    edits: [['this.noteOutboxArchiveFailure(full, from, file, error);\n      return null;', "this.appendLog({ kind: 'outbox-archive-failed', from, file, error: String(error) });\n      return null;"]],
    killer: prunedDuplicateArchiveFailureLogKiller },
  { name: 'ARCHIVE-LOG-NOISE-M7: replacement retains the old failure entry',
    edits: [['this.outboxDeliveredArchives.delete(full);\n          // Its earlier archive failure belongs to the replaced payload, not this one.\n          this.outboxArchiveFailures.delete(full);', 'this.outboxDeliveredArchives.delete(full);']],
    killer: replacedThenArchivedKiller }
];

test('MUTANT CENSUS ROUTER-ARCHIVE-FAILED-LOG-NOISE: per-scan logging dies at the noise pin', async (t) => {
  for (const mutant of ARCHIVE_LOG_NOISE_MUTANTS) {
    await t.test(`mutant: ${mutant.name}`, async (subtest) => {
      let text = readSource('src/main/hive.ts');
      for (const [from, to] of mutant.edits) {
        assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}" edit applies exactly once`);
        text = text.replace(from, () => to);
      }
      const MutatedManager = loadTs.fromText('src/main/hive.ts', text).HiveManager;
      let died = null;
      try { await mutant.killer(subtest, MutatedManager); } catch (error) { died = error; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${mutant.name} (${died && died.message})`);
      assert.match(died.message, /ARCHIVE (LOG NOISE|FINGERPRINT|PRUNE|REPLACE CLEAR)/, `${mutant.name} died at the wrong assertion`);
    });
  }
});

async function replacedArchiveFailureLogKiller(t, Manager = HiveManager) {
  const { hive, outbox } = await floor(t, Manager);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => {
    if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent);
  });
  const file = path.join(outbox, 'replaced-stuck.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'first held payload' }));
  assert.equal(hive.routeOnce(), 1);
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'replacement held payload', body: 'different contents' }));
  assert.equal(hive.routeOnce(), 1, 'the replacement is a new delivery before its archive fails');
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-failed').length, 2,
    'ARCHIVE FINGERPRINT: changed contents become a newly reported stuck archive');
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-cleared').length, 0,
    'ARCHIVE FINGERPRINT: replacing a held file is not an archive clear');
}

async function replacedThenArchivedKiller(t, Manager = HiveManager) {
  const { hive, outbox } = await floor(t, Manager);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => { if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent); });
  const file = path.join(outbox, 'replaced-then-archived.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'held original' }));
  assert.equal(hive.routeOnce(), 1);
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'replacement archives first try', body: 'new' }));
  fs.renameSync(heldSent, sent);
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-cleared').length, 0,
    'ARCHIVE REPLACE CLEAR: a replacement that never stuck must not clear the old failure');
}

test('a replaced held outbox file is a new archive-failure epoch, not a clear', async (t) => {
  await replacedArchiveFailureLogKiller(t);
});

test('a replacement archived on its first try does not clear the old held payload', async (t) => {
  await replacedThenArchivedKiller(t);
});

async function prunedDuplicateArchiveFailureLogKiller(t, Manager = HiveManager) {
  const { hive, outbox } = await floor(t, Manager);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => {
    if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent);
  });
  const file = path.join(outbox, 'gone-then-duplicate.json');
  const payload = JSON.stringify({ to: 'god-1', act: 'inform', subject: 'same bytes after removal' });
  fs.writeFileSync(file, payload);
  const stableTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  fs.utimesSync(file, stableTime, stableTime);
  const first = fs.statSync(file);
  assert.equal(hive.routeOnce(), 1);
  fs.rmSync(file);
  assert.equal(hive.routeOnce(), 0, 'the absent file prunes its archive-failure state');
  fs.writeFileSync(file, payload);
  fs.utimesSync(file, new Date(first.mtimeMs), new Date(first.mtimeMs));
  assert.equal(`${fs.statSync(file).size}:${fs.statSync(file).mtimeMs}`, `${first.size}:${first.mtimeMs}`,
    'FIXTURE: the recreated file must retain the old fingerprint to prove pruning');
  assert.equal(hive.routeOnce(), 0, 'the same bytes are an exact duplicate, whose archive is held');
  assert.equal(hive.routeOnce(), 0, 'a held duplicate retry must not add another failure row');
  assert.equal(hive.logTail(100).filter((entry) => entry.kind === 'outbox-archive-failed').length, 2,
    'ARCHIVE PRUNE: removal permits the recreated name to report once, including the duplicate path');
}

test('a removed stuck file is pruned, and a held exact duplicate logs once in its new epoch', async (t) => {
  await prunedDuplicateArchiveFailureLogKiller(t);
});

/**
 * Jim's router-148 note 1 (surviving mutant M3). The retry above remembers a delivered
 * file by FINGERPRINT, and the fingerprint is the whole guard: drop the comparison
 * (`if (true)`) and the router archives whatever now sits at that path as though it
 * were the message it already delivered. A sender who reuses a filename for a SECOND,
 * never-delivered message would have it swallowed silently - no delivery, no rejection,
 * no trace but an archived file that looks handled.
 *
 * The code handles it; nothing pinned it. This is that pin: strand a delivered file so
 * its archive fails, overwrite it with a DIFFERENT payload, restore `.sent`, and require
 * that the second payload REACHES the recipient rather than being archived on the first
 * one's ticket.
 */
test('a stranded delivered file REPLACED by a new message routes the new payload, not the archive', async (t) => {
  const { hive, events, outbox } = await floor(t);
  const sent = path.join(outbox, '.sent');
  const heldSent = path.join(outbox, '.sent-held');
  fs.renameSync(sent, heldSent);
  t.after(() => {
    if (fs.existsSync(heldSent) && !fs.existsSync(sent)) fs.renameSync(heldSent, sent);
  });

  // 1. Deliver, and strand it: .sent is gone, so the archive fails and the router
  //    remembers this exact file by fingerprint.
  const file = path.join(outbox, 'reused-name.json');
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'the first message' }));
  assert.equal(hive.routeOnce(), 1, 'the first message must be delivered before it can be stranded');
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(fs.existsSync(file), true, 'a failed archive leaves the delivered source in place');

  // 2. The sender REUSES the name for a different message. Size AND mtime both move, so
  //    the fingerprint cannot match by accident - a same-size rewrite inside one
  //    millisecond would compare equal and this test would prove nothing. mtime goes
  //    BACKWARDS, not forwards, so it can never be mistaken for a fresh partial write.
  const before = fs.statSync(file);
  fs.writeFileSync(file, JSON.stringify({ to: 'god-1', act: 'inform', subject: 'the SECOND message, same filename', body: 'x'.repeat(64) }));
  const past = new Date(Date.now() - 5_000);
  fs.utimesSync(file, past, past);
  const after = fs.statSync(file);
  assert.notEqual(`${before.size}:${before.mtimeMs}`, `${after.size}:${after.mtimeMs}`,
    'FIXTURE: the replacement must not share the stranded file\'s fingerprint, or nothing is being tested');

  // 3. .sent comes back. The new payload must be DELIVERED, not archived as the old one.
  fs.renameSync(heldSent, sent);
  assert.equal(hive.routeOnce(), 1, 'the replacement is a NEW route, not an archive retry');
  assert.equal(hive.inbox('god-1').length, 2, 'the second message must REACH the recipient');
  assert.equal(hive.inbox('god-1')[1].subject, 'the SECOND message, same filename',
    'the payload delivered must be the replacement, not a re-send of the first');
  assert.equal(fs.existsSync(path.join(sent, 'reused-name.json')), true, 'and it is archived once delivered');
  assert.equal(hive.inbox('jim-1').length, 0, 'a replaced file is not a sender error');
  assert.equal(events.filter(({ channel, payload }) =>
    channel === 'hive:message' && /^\[outbox rejected/.test(payload.subject)
  ).length, 0, 'no rejection notice for a legitimately replaced file');
});
