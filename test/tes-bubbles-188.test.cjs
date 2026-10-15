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
