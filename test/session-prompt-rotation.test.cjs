'use strict';

/**
 * SESSION-PROMPT-ROTATION (1.1.76). A resumed Claude session keeps the system prompt it was
 * started with (1.1.75 real run #3, B4), so a prompt change at an upgrade never reached a
 * running agent, and 1.1.75 needed a hand-run registry clear (fresh-start-175.cjs).
 *
 * The fix, pinned here:
 * - each session is stamped with the fingerprint of the prompt its process was spawned with;
 * - an AUTOMATIC resume of a session with another stamp, or none, starts fresh (logged
 *   `session-rotate`), for the last key and for the previous-key fallback alike;
 * - a resume the human asks for by id is honoured (logged `session-resume-stale`);
 * - "Start fresh" (UI) drops the resume key through the main process, and a late hook from
 *   the old process cannot bring it back.
 *
 * HOME is redirected and asserted before anything touches ~/.claude.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-rot-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
assert.equal(os.homedir(), FAKE_HOME, 'HOME redirect failed - aborting before touching ~/.claude');
test.after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const loadTs = require('./load-ts.cjs');
const R = loadTs('src/main/sessionRotation.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002';
const CLR = 'cccccccc-0000-4000-8000-000000000003';

// — the normaliser: one test per thing it strips, and proof that instructions still count —

const { LEGACY_175_PROMPT_FP } = loadTs('src/main/sessionRotationLegacy.ts');

/** A hive whose prompt inputs the test controls. */
function promptHive(t, { maySpawn = false } = {}) {
  const home = fs.mkdtempSync(path.join(FAKE_HOME, 'fp-'));
  const hive = new HiveManager(() => home);
  hive.setOrchestratorMaySpawn(maySpawn);
  t.after(() => hive.dispose());
  return hive;
}
const WORKER = { id: 'jim', name: 'Jim', provider: 'claude', cwd: 'C:/w' };
/** The fingerprint with the given inputs, and the raw (unnormalised) prompt for contrast. */
function fpWith(hive, meta, { mem = true, kg = false, kgPath, mode, dir = 'C:/hive/agents/jim', root = 'C:/hive' } = {}) {
  if (mode) hive.promptMailMode = () => mode;
  const raw = hive.injectedPrompt(meta, dir, root, mem, kg, kgPath);
  const mailMode = hive.promptMailMode(meta);
  const canon = hive.injectedPrompt(meta, dir, root, mem, kg, kgPath, { mailMode });
  return { raw, fp: R.canonicalPromptFingerprint(canon) };
}

test('normaliser strips memory availability (memory line AND protocol line 1 wording)', (t) => {
  const hive = promptHive(t);
  const on = fpWith(hive, WORKER, { mem: true }), off = fpWith(hive, WORKER, { mem: false });
  assert.notEqual(on.raw, off.raw, 'the raw prompt does change');
  assert.match(on.raw, /memory search/);
  assert.equal(on.fp, off.fp, 'a memory service down at a restart never rotates');
  assert.equal(hive.sessionPromptFingerprint(WORKER).fp, on.fp, 'sessionPromptFingerprint is the canonical render');
});

test('normaliser strips the Knowledge Graph line and its CLI path', (t) => {
  const hive = promptHive(t);
  const off = fpWith(hive, WORKER), on = fpWith(hive, WORKER, { kg: true, kgPath: 'C:/kg/cli.js' }), other = fpWith(hive, WORKER, { kg: true, kgPath: 'D:/other/kg.js' });
  assert.notEqual(on.raw, off.raw);
  assert.equal(on.fp, off.fp);
  assert.equal(other.fp, off.fp);
});

test('normaliser strips the RUNNING BUILD line (version, packaged/dev, app path)', (t) => {
  const hive = promptHive(t);
  hive.setRuntimeInfo({ version: '1.1.75', packaged: true, appPath: 'C:/A/app.asar' });
  const a = fpWith(hive, WORKER);
  hive.setRuntimeInfo({ version: '1.1.76', packaged: false, appPath: 'D:/dev' });
  const b = fpWith(hive, WORKER);
  hive.setRuntimeInfo(null);
  const c = fpWith(hive, WORKER);
  assert.match(a.raw, /RUNNING BUILD: Munder Difflin v1\.1\.75/);
  assert.notEqual(a.raw, b.raw);
  assert.equal(a.fp, b.fp);
  assert.equal(a.fp, c.fp);
});

test('normaliser strips the agent name/id, workspace, hive root and node path (one fp per variant)', (t) => {
  const hive = promptHive(t);
  const jim = fpWith(hive, WORKER, { dir: 'C:\\hive\\agents\\jim', root: 'C:\\hive' });
  const andy = fpWith(hive, { ...WORKER, id: 'andy', name: 'Andy' }, { dir: '/home/x/hive/agents/andy', root: '/home/x/hive' });
  const orig = hive.nodeCommand.bind(hive);
  hive.nodeCommand = () => 'Z:/elsewhere/node.exe';
  const node = fpWith(hive, WORKER);
  hive.nodeCommand = orig;
  assert.notEqual(jim.raw, andy.raw);
  assert.equal(jim.fp, andy.fp, 'separators and identities are normalised');
  assert.equal(node.fp, jim.fp);
});

test('instructions still count: mail mode, role and the spawn-queue line change the fingerprint', (t) => {
  const hive = promptHive(t);
  const inject = fpWith(hive, WORKER, { mode: 'inject' }).fp;
  assert.notEqual(fpWith(hive, WORKER, { mode: 'legacy-read' }).fp, inject, 'a mail-mode degrade rotates');
  assert.notEqual(fpWith(hive, { ...WORKER, isGod: true }, { mode: 'inject' }).fp, inject);
  const spawnHive = promptHive(t, { maySpawn: true });
  assert.notEqual(fpWith(spawnHive, { ...WORKER, isGod: true }, { mode: 'inject' }).fp, fpWith(hive, { ...WORKER, isGod: true }, { mode: 'inject' }).fp);
  assert.equal(hive.sessionPromptFingerprint({ ...WORKER, isGod: true }).variant, 'claude|inject|god');
  assert.equal(spawnHive.sessionPromptFingerprint({ ...WORKER, isGod: true }).variant, 'claude|inject|god+spawn');
  assert.equal(hive.sessionPromptFingerprint({ ...WORKER, isAssistant: true }).variant, 'claude|inject|assistant');
});

test('LEGACY_175 table: 16 variants; 1.1.77 changes the GOD instruction text only (god rotates at install, workers and the assistant do not)', (t) => {
  // TRIPWIRE. If a later change edits the prompt's instructions, this fails: the install of that
  // build will rotate every 1.1.75-era session, which is then correct. Do NOT regenerate the table
  // (it describes what 1.1.75 sessions got); change this assertion to notEqual deliberately.
  // 1.1.77 (ZT-I3/I4) DELIBERATELY changed god's prompt: the harness keeps board-status.md and
  // floor-digest.md and wakes god for decisions, instead of god polling fleet.json; plus the
  // "parked" marker. So the god and god+spawn variants rotate once at the 1.1.77 install (god
  // starts a fresh conversation; identity, memory, inbox and ledger kept). Workers and the
  // assistant are unchanged: PROTOCOL.md is a file, not injected text.
  // Ruling: god 2026-10-01 (dc06a9, conv-be5f29) accepted the one-time god reset; keep every
  // other god-prompt edit of 1.1.77 inside fix/177-zt-i3-i4 so the reset happens once.
  assert.equal(Object.keys(LEGACY_175_PROMPT_FP).length, 16);
  for (const role of ['worker', 'assistant', 'god', 'god+spawn']) {
    const hive = promptHive(t, { maySpawn: role === 'god+spawn' });
    const meta = { ...WORKER, isGod: role.startsWith('god'), isAssistant: role === 'assistant' };
    for (const mode of ['inject', 'legacy-read', 'legacy-move', 'work-order']) {
      hive.promptMailMode = () => mode;
      const cur = hive.sessionPromptFingerprint(meta);
      assert.equal(cur.variant, `claude|${mode}|${role}`);
      if (role.startsWith('god')) assert.notEqual(cur.fp, LEGACY_175_PROMPT_FP[cur.variant], `${cur.variant} rotates at the 1.1.77 install`);
      else assert.equal(cur.fp, LEGACY_175_PROMPT_FP[cur.variant], cur.variant);
    }
  }
});

test('resumeDecision: an unstamped session takes the 1.1.75 stamp of its variant, then compares as usual', () => {
  const legacy = { 'claude|inject|worker': 'f175' };
  assert.deepEqual(R.resumeDecision(undefined, 'claude|inject|worker', 'f175', legacy), { stale: null, stampLegacy: 'f175' }, 'unchanged text: resumes');
  assert.deepEqual(R.resumeDecision(undefined, 'claude|inject|worker', 'f176', legacy), { stale: 'prompt-changed', stampLegacy: 'f175' }, 'changed text: rotates');
  assert.deepEqual(R.resumeDecision(undefined, 'claude|nope|worker', 'f176', legacy), { stale: 'prompt-unrecorded', stampLegacy: null }, 'unknown variant: rotates');
  assert.deepEqual(R.resumeDecision('f176', 'claude|inject|worker', 'f176', legacy), { stale: null, stampLegacy: null }, 'a stamp is never replaced');
  assert.deepEqual(R.resumeDecision('fOLD', 'claude|inject|worker', 'f176', legacy), { stale: 'prompt-changed', stampLegacy: null });
  assert.deepEqual(R.resumeDecision(undefined, 'claude|inject|worker', null, legacy), { stale: null, stampLegacy: 'f175' }, 'nothing to compare: never stale');
  assert.equal(R.resumeDecision(undefined, 'claude|inject|worker', 'x').stampLegacy, LEGACY_175_PROMPT_FP['claude|inject|worker'], 'defaults to the build-time table');
});

test('Creed R1: a session retired by the rotation path cannot come back through a late hook', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-v1', null);
  hive.recordSession('jim', OLD, 'hook');
  // index.ts rotation: the stale key is retired, the new process starts fresh.
  hive.retireSession('jim', OLD);
  hive.noteSpawnPrompt('jim', 'fp-v2', null);
  hive.recordSession('jim', NEW, 'hook');
  assert.equal(reg().sessionId, NEW);
  hive.recordSession('jim', OLD, 'hook');   // the straggler from the old process
  assert.equal(reg().sessionId, NEW, 'the rotated id never becomes the resume key again');
  assert.equal(reg().sessionPrompts[OLD], 'fp-v1', 'nor is it re-stamped with the new prompt');
});

test('Creed R2: a hook never overwrites an existing stamp (the B4 guard)', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-old', null);
  hive.recordSession('jim', OLD, 'hook');
  assert.equal(reg().sessionPrompts[OLD], 'fp-old');
  hive.noteSpawnPrompt('jim', 'fp-new', null);   // a newer process, not resuming OLD
  hive.recordSession('jim', OLD, 'hook');        // a hook naming OLD (neither retired nor resumed)
  assert.equal(reg().sessionPrompts[OLD], 'fp-old', 'the stale session must not look current');
});

test('Creed O2: clearSession keeps the stamps', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-v1', null);
  hive.recordSession('jim', OLD, 'hook');
  hive.clearSession('jim', 'start-fresh');
  assert.equal(reg().sessionPrompts[OLD], 'fp-v1');
});

test('Creed R3: no legacy stamp under a mail channel override, or with god\'s spawn toggle on (it rotates)', (t) => {
  const hive = promptHive(t);
  assert.equal(hive.sessionPromptFingerprint(WORKER).legacyBlock, null);
  assert.equal(hive.sessionPromptFingerprint({ ...WORKER, isGod: true }).legacyBlock, null, 'god at the 1.1.75 default (spawn off)');
  hive.mail.channelOverride = () => ({ mode: 'legacy-read', reason: 'no-mail-block' });
  assert.equal(hive.sessionPromptFingerprint(WORKER).legacyBlock, 'mail-channel-override');
  const spawn = promptHive(t, { maySpawn: true });
  assert.equal(spawn.sessionPromptFingerprint({ ...WORKER, isGod: true }).legacyBlock, 'spawn-toggle-changed');
  assert.equal(spawn.sessionPromptFingerprint(WORKER).legacyBlock, null, 'the toggle only changes god\'s prompt');
  // A blocked session gets no variant, so resumeDecision leaves it unrecorded: it rotates.
  assert.deepEqual(R.resumeDecision(undefined, null, 'fp'), { stale: 'prompt-unrecorded', stampLegacy: null });
});

test('stampSession stamps only an unstamped session', async (t) => {
  const { hive, reg } = await oneAgent(t);
  assert.equal(hive.stampSession('jim', OLD, 'f175'), true);
  assert.equal(reg().sessionPrompts[OLD], 'f175');
  assert.equal(hive.stampSession('jim', OLD, 'other'), false);
  assert.equal(reg().sessionPrompts[OLD], 'f175');
  assert.equal(hive.stampSession('nobody', OLD, 'f'), false);
});

test('staleReason: changed, unrecorded, equal, and nothing to compare', () => {
  assert.equal(R.staleReason('f1', 'f2'), 'prompt-changed');
  assert.equal(R.staleReason(undefined, 'f2'), 'prompt-unrecorded');
  assert.equal(R.staleReason('f2', 'f2'), null);
  assert.equal(R.staleReason(undefined, null), null);
  assert.equal(R.staleReason('f1', null), null);
});

test('withSessionStamp keeps the newest SESSION_PROMPT_CAP stamps, newest last', () => {
  let m;
  for (let i = 0; i < R.SESSION_PROMPT_CAP + 3; i++) m = R.withSessionStamp(m, `s${i}`, `f${i}`);
  const keys = Object.keys(m);
  assert.equal(keys.length, R.SESSION_PROMPT_CAP);
  assert.equal(keys[keys.length - 1], `s${R.SESSION_PROMPT_CAP + 2}`);
  assert.equal(keys[0], 's3');
  m = R.withSessionStamp(m, 's3', 'fx');
  assert.equal(Object.keys(m).pop(), 's3', 're-stamping moves a session to newest');
  assert.equal(m.s3, 'fx');
});

async function oneAgent(t) {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const cwd = fs.mkdtempSync(path.join(FAKE_HOME, 'cwd-'));
  const hive = new HiveManager(() => harness);
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd });
  t.after(() => hive.dispose());
  const reg = () => JSON.parse(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8')).agents.jim;
  const log = () => fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { hive, reg, log };
}

test('a fresh process stamps the session its hook reports; a sample never stamps', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-new', null);
  hive.recordSession('jim', NEW, 'sample');
  assert.equal(reg().sessionPrompts, undefined, 'sample path: no stamp');
  hive.recordSession('jim', NEW, 'hook');
  assert.deepEqual(reg().sessionPrompts, { [NEW]: 'fp-new' });
  assert.equal(hive.sessionPromptStamp('jim', NEW), 'fp-new');
  // A /clear inside the same process opens a new id: it has this process's prompt too.
  hive.recordSession('jim', CLR, 'hook');
  assert.equal(reg().sessionPrompts[CLR], 'fp-new');
  assert.equal(reg().sessionId, CLR);
});

test('a resumed process never stamps the session it resumed (it keeps its old prompt)', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-v1', null);
  hive.recordSession('jim', OLD, 'hook');
  // Upgrade: the human resumes OLD by id under a new prompt.
  hive.noteSpawnPrompt('jim', 'fp-v2', OLD);
  hive.recordSession('jim', OLD, 'hook');
  assert.equal(reg().sessionPrompts[OLD], 'fp-v1', 'the resumed session keeps its original stamp');
  // A session it then opens (/clear) runs on the new prompt.
  hive.recordSession('jim', CLR, 'hook');
  assert.equal(reg().sessionPrompts[CLR], 'fp-v2');
});

test('a legacy (pre-1.1.76, unstamped) session resumed by id is not stamped with the new prompt', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.recordSession('jim', OLD, 'hook'); // recorded by 1.1.75: no spawn note, no stamp
  assert.equal(hive.sessionPromptStamp('jim', OLD), undefined);
  hive.noteSpawnPrompt('jim', 'fp-v2', OLD); // Restart & Continue on 1.1.76
  hive.recordSession('jim', OLD, 'hook');
  assert.equal(hive.sessionPromptStamp('jim', OLD), undefined, 'still unrecorded, so the next automatic resume rotates it');
});

test('clearSession drops the resume key, keeps ownership, and a late old hook cannot restore it', async (t) => {
  const { hive, reg, log } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-v1', null);
  hive.recordSession('jim', OLD, 'hook');
  hive.recordSession('jim', NEW, 'hook');
  assert.equal(reg().previousSessionId, OLD);
  const r = hive.clearSession('jim', 'start-fresh');
  assert.deepEqual(r, { ok: true, cleared: [NEW, OLD] });
  const a = reg();
  assert.equal(a.sessionId, undefined);
  assert.equal(a.previousSessionId, undefined);
  assert.equal(a.sessionSource, undefined);
  assert.deepEqual(a.hookSessionIds, [OLD, NEW], 'ownership kept');
  assert.equal(hive.lastSession('jim'), undefined);
  hive.recordSession('jim', NEW, 'hook'); // straggler from the killed process
  hive.recordSession('jim', OLD, 'sample');
  assert.equal(reg().sessionId, undefined, 'a retired id never comes back as the resume key');
  hive.noteSpawnPrompt('jim', 'fp-v2', null);
  hive.recordSession('jim', CLR, 'hook'); // the fresh process
  assert.equal(reg().sessionId, CLR);
  assert.equal(reg().previousSessionId, undefined, 'no fallback to the cleared conversation');
  assert.equal(reg().sessionPrompts[CLR], 'fp-v2');
  const row = log().find((e) => e.kind === 'session-fresh');
  assert.deepEqual({ agentId: row.agentId, reason: row.reason, cleared: row.cleared }, { agentId: 'jim', reason: 'start-fresh', cleared: [NEW, OLD] });
  assert.equal(hive.clearSession('nobody', 'start-fresh').ok, false, 'unknown agent refused');
});

test('main: an automatic resume rotates a stale session; the fallback obeys the same check; a typed id is honoured', () => {
  const src = read('src/main/index.ts');
  const block = src.slice(src.indexOf('const explicitSid = typeof opts.resumeSessionId'), src.indexOf('opts.args = args;', src.indexOf('const explicitSid = typeof opts.resumeSessionId')));
  assert.ok(block.length > 0);
  assert.match(block, /const promptInfo = hive\.enabled\(\) \? hive\.sessionPromptFingerprint\(\{ \.\.\.opts\.hive, cwd: opts\.cwd, provider \}\) : null;/, 'the normalised fingerprint of this agent');
  assert.match(block, /if \(d\.stampLegacy && hive\.stampSession\(opts\.hive!\.id, s, d\.stampLegacy\)\)/, 'legacy sessions are stamped, then compared');
  assert.ok(block.indexOf('const promptFp') > block.indexOf('const explicitSid'));
  assert.match(block, /if \(sid && !explicitSid\) \{\s*const why = staleFor\(sid\);\s*if \(why\) \{[\s\S]*?kind: 'session-rotate'[\s\S]*?sid = undefined;/, 'automatic resume of a stale session starts fresh');
  assert.match(block, /else if \(sid && explicitSid && staleFor\(sid\)\) \{\s*hive\.appendLog\(\{ kind: 'session-resume-stale'/, 'a typed id is resumed, and logged');
  assert.match(block, /chooseResumeSession\(sid, previous, seedFresh, foreign\)/, 'the previous-key fallback uses the stale-aware seed');
  assert.match(block, /if \(staleFor\(s\)\) \{ rotated\.push\(s\); return false; \}/);
  assert.match(block, /hive\.noteSpawnPrompt\(opts\.hive\.id, promptFp, resumedSid\);/);
  // Creed R1: the rotation retires the stale key before it is dropped.
  assert.match(block, /rotated\.push\(sid\);\s*hive\.retireSession\(opts\.hive\.id, sid\);/);
  // Creed R3: a blocked legacy session is logged and gets no variant (so no legacy stamp).
  assert.match(block, /const legacyBlock = !recorded \? promptInfo\?\.legacyBlock \?\? null : null;\s*if \(legacyBlock\) hive\.appendLog\(\{ kind: 'session-legacy-skip'/);
  assert.match(block, /resumeDecision\(recorded, legacyBlock \? null : promptInfo\?\.variant \?\? null, promptFp\)/);
  assert.match(block, /let resumedSid: string \| null = null;/, 'fresh unless a resume is attached');
  assert.equal((block.match(/\n\s*resumedSid = (sid|pick\.sessionId);/g) || []).length, 2, 'set on both resume paths');
  // The rotation check runs before anything is attached, i.e. before `--resume`.
  assert.ok(block.indexOf("kind: 'session-rotate'") < block.indexOf("args.push('--resume'"));
});

test('main: Start fresh clears the key before the resume blocks and refuses a required resume', () => {
  const src = read('src/main/index.ts');
  const at = src.indexOf('if (opts.startFresh === true && opts.hive)');
  assert.ok(at > 0);
  assert.ok(at < src.indexOf('const explicitSid = typeof opts.resumeSessionId'), 'before the Claude resume block');
  assert.ok(at < src.indexOf('const typedSid = typeof opts.resumeSessionId'), 'before the generic resume block');
  const seg = src.slice(at, at + 700);
  assert.match(seg, /opts\.requireResume === true\) return \{ ok: false/);
  assert.match(seg, /hive\.clearSession\(opts\.hive\.id, 'start-fresh'\)/);
  assert.match(seg, /if \(!cleared\.ok\) return \{ ok: false/, 'a failed clear blocks the spawn instead of resuming');
  assert.match(seg, /opts\.resume = false;\s*opts\.resumeSessionId = undefined;/);
});

test('UI: a Start fresh button per agent (workers and god) spawns with startFresh and never resumes', () => {
  const ui = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.equal((ui.match(/<StartFreshButton agent=\{a\} disabled=\{restarting === a\.id\} onStart=\{\(\) => restartWithModel\(a, a\.model, \{ startFresh: true \}\)\} \/>/g) || []).length, 2);
  assert.match(ui, /let resume = opts\.resume === true && provider === previousProvider && opts\.startFresh !== true;/);
  assert.match(ui, /\.\.\.\(opts\.startFresh === true \? \{ startFresh: true \} : \{\}\)/);
  assert.match(ui, /function StartFreshButton[\s\S]*?window\.confirm\(/, 'asks before ending a conversation');
  assert.match(read('src/preload/index.ts'), /startFresh\?: boolean;/);
});
