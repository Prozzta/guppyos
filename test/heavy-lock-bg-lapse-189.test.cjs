'use strict';
/**
 * HEAVY-LOCK-BG-LAPSE-189: Jim's chain at 08:40:28Z wrote a script with a heredoc and ran it in the
 * same backgrounded Bash call. At PreToolUse the script did not exist yet, the classifier read
 * nothing, called the call light, and the lock was never taken: the slot lapsed while the chain ran.
 * A script the lock cannot read at PreToolUse is now an unknown program and the lock fails closed on
 * it (HEAVY-JOB-LOCK-FAILOPEN), whatever its name. A file an earlier segment of the same command
 * writes from a heredoc is read from that body, so a script made and run in one call is classified
 * by its text. A call held only for an unreadable script is classified again at its PostToolUse and
 * freed at once if the script now reads as light.
 * HOME is jailed and asserted before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { classifyCommand, HeavyJobLock } = loadTs('src/main/heavyJob.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const SUITE = 'node test/tools/run-tests.cjs';
const made = (file, body, run) => `cat > ${file} <<'EOF'\n${body}\nEOF\n${run}`;
// A script made by something the classifier cannot follow (python writing it): unreadable at PreToolUse.
const pyMade = (file, run) => `python - <<'EOF'\nopen('${file}', 'w').write('x')\nEOF\n${run}`;

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bglapse-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('CLASSIFIER: a script the lock cannot read yet is heavy (provisional), whatever its name: bash, sh, ./x.sh, node', (t) => {
  const ctx = HookServer.heavyScriptCtx(dir(t));
  for (const cmd of ['bash run.sh', 'sh ./run.sh', './run.sh', 'scripts/go.bash', 'node run.cjs', 'node ./tools/x.mjs', 'node -r ./pre.cjs', pyMade('run.sh', 'bash run.sh'), pyMade('run.cjs', 'node run.cjs')]) {
    const c = classifyCommand(cmd, 0, ctx);
    assert.equal(c.heavy, true, `${JSON.stringify(cmd)} is heavy`);
    assert.equal(c.provisional, true, `${JSON.stringify(cmd)} is heavy only because unreadable`);
    assert.match(c.why, /a script the lock cannot read yet/);
  }
  // A throwing reader is unreadable too (and never throws into the hook).
  assert.equal(classifyCommand('bash run.sh', 0, { readScript: () => { throw new Error('EACCES'); } }).heavy, true);
  // Unchanged: no reader at all (a caller that does not read scripts), a bare module preload, an empty file.
  assert.equal(classifyCommand('bash run.sh').heavy, false);
  assert.equal(classifyCommand('node -r ts-node/register -e 1', 0, ctx).heavy, false);
  assert.equal(classifyCommand('bash empty.sh', 0, { readScript: () => '' }).heavy, false);
});

test('CLASSIFIER: a script written by a heredoc earlier in the same command is classified by that body (Jim 08:40:28Z, neutral name)', (t) => {
  const ctx = HookServer.heavyScriptCtx(dir(t));
  const heavy = [
    made('run.sh', `cd /c/w\n${SUITE} > out.log 2>&1`, 'bash run.sh'),
    made('run.sh', SUITE, 'chmod +x run.sh && ./run.sh'),
    `cat <<'EOF' > run.sh\n${SUITE}\nEOF\nsh run.sh`,
    `tee run.sh <<EOF >/dev/null\n${SUITE}\nEOF\nbash run.sh`,
    `cd sub && cat > run.sh <<'EOF'\n${SUITE}\nEOF\nbash run.sh`,
    `cat > sub/run.sh <<'EOF'\n${SUITE}\nEOF\ncd sub && bash ./run.sh`,
    `cat > "$S/run.sh" <<'EOF'\n${SUITE}\nEOF\nbash "$S/run.sh"`,
    made('run.sh', 'echo one', '') + `cat >> run.sh <<'EOF'\n${SUITE}\nEOF\nbash run.sh`,
    made('run.sh', SUITE, '') + `cat >> run.sh <<'EOF'\necho done\nEOF\nbash run.sh`,
  ];
  for (const cmd of heavy) {
    const c = classifyCommand(cmd, 0, ctx);
    assert.deepEqual([c.heavy, c.kind, c.provisional], [true, 'suite', undefined], JSON.stringify(cmd));
  }
  const n = classifyCommand(made('run.cjs', "require('onnxruntime-node')", 'node run.cjs'), 0, ctx);
  assert.deepEqual([n.heavy, n.kind, n.provisional], [true, 'bench', undefined]);
  // HEAVY-CLASSIFIER-FP: a LIGHT script made the same way stays light (no wait for the slot).
  for (const cmd of [made('run.sh', 'echo hi\ngit status', 'bash run.sh'), made('run.cjs', "console.log(require('fs').readdirSync('.'))", 'node run.cjs'), made('run.sh', 'echo hi', 'cd elsewhere && bash run.sh; bash run.sh')]) {
    const c = classifyCommand(cmd, 0, ctx);
    // `cd elsewhere && bash run.sh` reads elsewhere/run.sh: not the heredoc's file, so unreadable.
    if (cmd.includes('elsewhere')) assert.equal(c.provisional, true, JSON.stringify(cmd));
    else assert.equal(c.heavy, false, JSON.stringify(cmd));
  }
  // `cat a.txt > run.sh <<EOF` writes a.txt, not the body: not virtual, so still unreadable (fail closed).
  assert.equal(classifyCommand(`cat a.txt > run.sh <<'EOF'\necho hi\nEOF\nbash run.sh`, 0, ctx).provisional, true);
  // A quoted "<<X" is not a heredoc, but reads as an operator word: the bodies cannot be paired with
  // their segments, so no file is virtual (fail closed) rather than run.sh taking b.sh's light body.
  const skew = `echo "<<X"; cat > run.sh <<'A'\n${SUITE}\nA\ncat > b.sh <<'B'\necho hi\nB\nbash run.sh`;
  assert.deepEqual([classifyCommand(skew, 0, ctx).heavy, classifyCommand(skew, 0, ctx).provisional], [true, true]);
});

test('CLASSIFIER: a definite heavy segment wins over a provisional one (its kind and why are the ones reported)', (t) => {
  const ctx = HookServer.heavyScriptCtx(dir(t));
  const c = classifyCommand('bash missing.sh; npm ci', 0, ctx);
  assert.deepEqual([c.heavy, c.kind, c.provisional], [true, 'install', undefined]);
  for (const cmd of ['X="$(bash missing.sh)"; Y="$(npm ci)"', 'X=$(bash missing.sh); echo "$(npm ci)"']) {
    const s = classifyCommand(cmd, 0, ctx);
    assert.deepEqual([s.heavy, s.kind, s.provisional], [true, 'install', undefined], cmd);
  }
});

test('CLASSIFIER: the floor\'s `S=/c/...; cd $S; node x.cjs` reads x.cjs (a literal assignment earlier in the command is substituted)', (t) => {
  const d = dir(t).replace(/\\/g, '/');
  fs.writeFileSync(path.join(d, 's.sh'), `${SUITE}\n`);
  fs.writeFileSync(path.join(d, 'ok.cjs'), "console.log(require('fs').readdirSync('.'))\n");
  const bash = `/${d[0].toLowerCase()}${d.slice(2)}`;   // Git Bash's /c/... spelling
  const ctx = HookServer.heavyScriptCtx(os.tmpdir());
  for (const S of [d, bash]) {
    assert.equal(classifyCommand(`S=${S}; cd $S; node ok.cjs`, 0, ctx).heavy, false, `${S}: read, and light`);
    assert.equal(classifyCommand(`S="${S}"; node "\${S}/ok.cjs" > $S/x.log`, 0, ctx).heavy, false);
    assert.equal(classifyCommand(`export S=${S} && bash $S/s.sh`, 0, ctx).kind, 'suite', `${S}: read, and the suite`);
    assert.equal(classifyCommand(`R=${S}\nS=$R; cd $S && bash ./s.sh &`, 0, ctx).kind, 'suite', 'a variable set from another one');
  }
  // Not a literal, or never set in this command: the path stays unreadable (fails closed).
  for (const cmd of [`S=$(mktemp -d); node $S/ok.cjs`, `S=\`pwd\`; bash $S/s.sh`, 'node $TEMP/ok.cjs', `S=${d} node $S/ok.cjs`]) assert.equal(classifyCommand(cmd, 0, ctx).provisional, true, cmd);
});

test('CLASSIFIER: a script run inside $(...) or bash -c is read too (it was never read below depth 0)', (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, 's.sh'), `${SUITE}\n`);
  const ctx = HookServer.heavyScriptCtx(d);
  for (const cmd of ['X="$(bash s.sh)"', 'bash -c "bash s.sh"', 'out=$(sh ./s.sh 2>&1)']) assert.equal(classifyCommand(cmd, 0, ctx).kind, 'suite', cmd);
  for (const cmd of ['X="$(bash run.sh)"', 'bash -c "bash run.sh"']) assert.equal(classifyCommand(cmd, 0, ctx).provisional, true, cmd);
  assert.equal(classifyCommand('bash -c "bash -c \'npm ci\'"', 0, ctx).heavy, false, 'a -c body is still read one level deep only (unchanged)');
});

async function server(t, limit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bglapse-home-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  t.after(() => { if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph; if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu; hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const rows = [];
  const l = new HeavyJobLock({ limit: () => limit, setTimer: () => ({}), clearTimer: () => {}, log: (r) => rows.push(r) });
  s.setHeavyLock(l);
  const cwd = dir(t);
  const fire = (agent_id, hook_event_name, command, id, background = false) => s.handle({ agent_id, hook_event_name, session_id: 's', cwd, tool_name: 'Bash', tool_input: background ? { command, run_in_background: true } : { command }, tool_use_id: id, transport: 'http' });
  return { s, l, fire, cwd, rows };
}
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

for (const background of [false, true]) {
  const how = background ? 'BACKGROUND' : 'FOREGROUND';
  test(`HOOK ${how}: a heredoc-made run.sh that runs the suite takes the slot (Jim's lapse), another heavy call is denied`, async (t) => {
    const { l, fire } = await server(t, 1);
    const cmd = made('run.sh', SUITE, 'bash run.sh');
    assert.equal(denied(fire('a1', 'PreToolUse', cmd, 'j1', background)), false);
    assert.deepEqual(l.snapshot().map((h) => [h.agentId, h.kind, h.background]), [['a1', 'suite', background]]);
    assert.equal(denied(fire('a2', 'PreToolUse', 'npm ci', 'x1')), true, 'the slot is held');
    fire('a1', 'PostToolUse', cmd, 'j1', background);
    if (background) assert.equal(l.snapshot().length, 1, 'a background holder is kept until its job exits (the watcher), not freed by PostToolUse');
    else assert.equal(l.snapshot().length, 0, 'a foreground holder is freed by its PostToolUse');
  });

  test(`HOOK ${how}: a run.sh the lock cannot read yet takes the slot and keeps it while it is still unreadable`, async (t) => {
    const { l, fire } = await server(t, 1);
    const cmd = pyMade('run.sh', 'bash run.sh');
    assert.equal(denied(fire('a1', 'PreToolUse', cmd, 'j1', background)), false);
    assert.deepEqual(l.snapshot().map((h) => [h.agentId, h.kind, h.background]), [['a1', 'bench', background]]);
    assert.equal(denied(fire('a2', 'PreToolUse', 'npm run build', 'x1')), true, 'the slot is held');
    fire('a1', 'PostToolUse', cmd, 'j1', background);
    assert.equal(l.snapshot().length, background ? 1 : 0, background ? 'still unreadable: kept until the job exits' : 'freed by its PostToolUse');
  });
}

test('HOOK EARLY RELEASE: a background call held for an unreadable script is freed at PostToolUse once the script reads light, kept when it reads heavy', async (t) => {
  for (const [body, kept] of [['echo hi\ngit log -1', false], [SUITE, true]]) {
    const { l, fire, cwd, rows } = await server(t, 1);
    const cmd = pyMade('run.sh', 'bash run.sh');
    fire('a1', 'PreToolUse', cmd, 'j1', true);
    assert.equal(l.snapshot().length, 1);
    fs.writeFileSync(path.join(cwd, 'run.sh'), body);   // what the call's python wrote
    fire('a1', 'PostToolUse', cmd, 'j1', true);
    assert.equal(l.snapshot().length, kept ? 1 : 0, JSON.stringify(body));
    assert.equal(rows.some((r) => r.action === 'release' && r.reason === 'settled-light'), !kept);
  }
  // Foreground: freed by callDone as any foreground call (after its orphan check), never settled.
  const { l, fire, cwd, rows } = await server(t, 1);
  const cmd = pyMade('run.sh', 'bash run.sh');
  fire('a1', 'PreToolUse', cmd, 'f1');
  fs.writeFileSync(path.join(cwd, 'run.sh'), 'echo hi');
  fire('a1', 'PostToolUse', cmd, 'f1');
  assert.equal(l.snapshot().length, 0);
  assert.deepEqual(rows.filter((r) => r.action === 'release').map((r) => r.reason), ['posttool']);
});

test('HOOK EARLY RELEASE: never for a holder that is also heavy outright, nor for a definite heavy call', async (t) => {
  for (const npmFirst of [true, false]) {
    const { l, fire, cwd } = await server(t, 1);
    const cmd = pyMade('run.sh', 'bash run.sh');
    if (npmFirst) fire('a1', 'PreToolUse', 'npm ci', 'i1', true);
    fire('a1', 'PreToolUse', cmd, 'j1', true);
    if (!npmFirst) fire('a1', 'PreToolUse', 'npm ci', 'i1', true);   // a re-entry, heavy outright
    fs.writeFileSync(path.join(cwd, 'run.sh'), 'echo hi');
    fire('a1', 'PostToolUse', cmd, 'j1', true);
    assert.equal(l.snapshot().length, 1, `the npm ci of the same holder still runs (npm ci ${npmFirst ? 'first' : 'second'})`);
  }
  {
    const { l, fire, cwd } = await server(t, 1);
    const cmd = made('run.sh', SUITE, 'bash run.sh');
    fire('a1', 'PreToolUse', cmd, 'j1', true);
    fs.writeFileSync(path.join(cwd, 'run.sh'), 'echo changed');   // Andy N1: a script changed during the run
    fire('a1', 'PostToolUse', cmd, 'j1', true);
    assert.equal(l.snapshot().length, 1, 'a definite heavy call is freed by its job exiting, not by reclassifying');
  }
});

// ─── Andy's audit of d2f20abf ───────────────────────────────────────────────────────────

test('CLASSIFIER B1: a `cd $S` target and the variables reach the path, in $(...) and bash -c too (Andy\'s repros)', (t) => {
  const d = dir(t).split(path.sep).join('/');
  fs.writeFileSync(path.join(d, 'light.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(d, 'suite.sh'), `${SUITE}\n`);
  fs.writeFileSync(path.join(d, 'ok.cjs'), 'console.log(1)\n');
  const ctx = HookServer.heavyScriptCtx(os.tmpdir());
  // (a) the cd target is expanded: not the glued X/$S
  assert.deepEqual(classifyCommand(`cd ${os.tmpdir().split(path.sep).join('/')}; S=${d}; cd $S; bash light.sh`, 0, ctx), { heavy: false }, 'B1a: cd $S');
  // (b) the substitution is classified with this point's variables and cd
  assert.deepEqual(classifyCommand(`J=${d}; X="$(bash $J/light.sh)"`, 0, ctx), { heavy: false }, 'B1b: $J inside $(...)');
  assert.deepEqual(classifyCommand(`J=${d}; for f in a b; do echo $(node $J/ok.cjs); done`, 0, ctx), { heavy: false }, 'B1b: $J inside $(...) in a loop');
  assert.deepEqual(classifyCommand(`cd ${d}; X="$(bash light.sh)"`, 0, ctx), { heavy: false }, 'B1b: the cd reaches $(...)');
  assert.deepEqual(classifyCommand(`J=${d}; bash -c "cd $J; bash light.sh"`, 0, ctx), { heavy: false }, 'B1b: $J inside bash -c');
  // ...and a heavy script found the same way is a DEFINITE suite, not provisional
  for (const cmd of [`J=${d}; X="$(bash $J/suite.sh)"`, `cd ${d}; X="$(bash suite.sh)"`, `J=${d}; bash -c "cd $J; bash suite.sh"`, `S=${d}; cd /; cd $S; bash suite.sh`]) {
    const c = classifyCommand(cmd, 0, ctx);
    assert.equal(c.kind, 'suite', cmd);
    assert.equal(c.provisional, undefined, cmd);
  }
});

test('CLASSIFIER S1: a later write by other means (>>, cp, mv, sed -i, tee) makes a heredoc-made file unknown: provisional, not light', (t) => {
  const d = dir(t).split(path.sep).join('/');
  fs.writeFileSync(path.join(d, 'suite.sh'), `${SUITE}\n`);
  fs.writeFileSync(path.join(d, 'light.sh'), 'echo hi\n');
  const ctx = HookServer.heavyScriptCtx(d);
  const H = made('run.sh', 'echo hi', '');
  for (const w of [`echo '${SUITE}' >> run.sh`, 'cp suite.sh run.sh', 'mv suite.sh run.sh', "sed -i 's/hi/x/' run.sh", "perl -pi -e 's/hi/x/' run.sh", 'echo x | tee run.sh', `echo '${SUITE}' > run.sh`,
    `printf '${SUITE}\\n' >| run.sh`, `echo '${SUITE}' &> run.sh`, `echo '${SUITE}' &>> run.sh`, `echo '${SUITE}' 1>| run.sh`]) {
    assert.equal(classifyCommand(`${H}${w}\nbash run.sh`, 0, ctx).provisional, true, `S1: ${w}`);
  }
  // Andy's repro (dc4d5e69 SHOULD 1): a clobber redirect `>|` is a write to its file, not to "|".
  assert.equal(classifyCommand(`cat > run.sh <<EOF\necho hi\nEOF\nprintf 'node test/tools/run-tests.cjs\\n' >| run.sh; bash run.sh`, 0, ctx).provisional, true, 'S1: >| run.sh');
  // ... and to that file only: a clobber, &> or &>> of another file leaves run.sh as written.
  for (const w of ['echo x >| other.txt', 'echo x &> other.log', 'echo x &>> other.log']) {
    assert.deepEqual(classifyCommand(`${H}${w}\nbash run.sh`, 0, ctx), { heavy: false }, w);
  }
  // A poisoned file that also exists on disk is NOT read from disk (the disk holds the old text).
  assert.equal(classifyCommand(`${made('light.sh', 'echo hi', '')}cp suite.sh light.sh\nbash light.sh`, 0, ctx).provisional, true, 'S1: not the disk copy');
  // cp into a directory: the copy lands under its own name.
  const HD = made('d/run.sh', 'echo hi', '');
  assert.equal(classifyCommand(`${HD}cp x/run.sh d/\nbash d/run.sh`, 0, ctx).provisional, true, 'S1: cp x/run.sh d/ rewrites d/run.sh');
  assert.deepEqual(classifyCommand(`${HD}cp x/other.sh d/\nbash d/run.sh`, 0, ctx), { heavy: false }, 'cp x/other.sh d/ leaves d/run.sh as written');
  // Out of scope (HEAVY-LOCK-SHAPES-189): a file on DISK edited earlier in the command is read as it is now.
  assert.deepEqual(classifyCommand("sed -i 's/hi/x/' light.sh && bash light.sh", 0, ctx), { heavy: false });
  // Unchanged: a heredoc writer's own target, an append to a known file, and writes to other files.
  assert.deepEqual(classifyCommand(`${H}bash run.sh`, 0, ctx), { heavy: false });
  assert.equal(classifyCommand(`cat <<'EOF' >> light.sh\n${SUITE}\nEOF\nbash light.sh`, 0, ctx).kind, 'suite', 'a heredoc append adds to the file\'s text');
  assert.deepEqual(classifyCommand('bash light.sh > out.log 2>&1; cp light.sh copy.sh; bash light.sh', 0, ctx), { heavy: false });
  // An append to a file that is already unknown stays unknown.
  assert.equal(classifyCommand(`cp suite.sh run.sh; cat <<'EOF' >> run.sh\necho hi\nEOF\nbash run.sh`, 0, ctx).provisional, true);
});

test('LOCK S2: with two provisional calls open, settling one of them light keeps the slot (the other is still unknown)', () => {
  const rows = [];
  const l = new HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, log: (r) => rows.push(r) });
  const P = { heavy: true, kind: 'bench', why: 'x.sh (a script the lock cannot read yet)', provisional: true };
  assert.equal(l.acquire('a1', P, 'bash a.sh', 'j1', true).allow, true);
  assert.equal(l.acquire('a1', P, 'bash b.sh', 'j2', true).allow, true);
  l.settle('a1', 'j1', () => ({ heavy: false }));
  assert.equal(l.snapshot().length, 1, 'S2: j2 is still an unknown job, so the slot is kept');
  assert.equal(rows.some((r) => r.action === 'settled-light'), false);
});

test('LOCK N-a: a reclassify that throws keeps the hold', () => {
  const l = new HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, log: () => {} });
  l.acquire('a1', { heavy: true, kind: 'bench', why: 'x', provisional: true }, 'bash a.sh', 'j1', true);
  l.settle('a1', 'j1', () => { throw new Error('reader broke'); });
  assert.equal(l.snapshot().length, 1, 'N-a: a throw is not a light verdict');
  l.settle('a1', 'j1', () => ({ heavy: false }));
  assert.equal(l.snapshot().length, 0, 'and the same call settles once it reads light');
});
