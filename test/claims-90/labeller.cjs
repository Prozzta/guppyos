'use strict';
/**
 * CLAIMS-90 labeller jail (god 425eb1 and 9a5ae0, Jim 18:40 and 20:08; test-only). One H1 batch is
 * keyed by ONE fresh Claude Code CLI session in its own jail folder, which holds COPIES of only:
 *   docs/  the batch, INSTRUCTIONS-H1, the label guide, the pilot INSTRUCTIONS.md, the labeller's
 *          own cross-check list;
 *   hive/  the snapshot's primary sources: tasks.json, tasks-archive/, board.md, PROTOCOL.md,
 *          agents/<id>/inbox/.done/*.json;
 *   repo.git  a mirror of the addendum bundle (the repo's refs at T_s), reached through GIT_DIR;
 *   key.jsonl the only file the session may write.
 * No memory folder, ledger, claims file, index, eligibility output or key from anyone else is
 * copied, and the jail is checked for them. No memory CLI and no hive folder on PATH; the env is an
 * allow-list. No hive hook: no SessionStart, compaction briefing or mail. The only hook is the
 * jail's own guard (labeller-guard.cjs), which denies a call that leaves the jail and writes the
 * open log. The batch is INVALID if the session compacts, starts with more than its tools, or
 * names any path outside the jail (the guard's log and the transcript are both judged).
 * A VALID batch's key rows (only the labeller's own rows) and a COST row are appended to --key.
 *
 *   node test/claims-90/labeller.cjs --snapshot <dir> --addendum <dir> --labeller <name>
 *        --group F|D --xcheck <ids.json> --batch <batch-NN.jsonl> --instructions <INSTRUCTIONS-H1.md>
 *        --guide <guide.md> --pilot <pilot INSTRUCTIONS.md> --prompt <prompt.md> --key <key.jsonl>
 *        --out <dir> [--model <id>] [--claude <exe>] [--keep]
 * The prompt may use {labeller}, {group}, {batchName}, {today}, {jail}, {keyFile} and {ownIds}.
 * Writes under --out/<batchName>-<labeller>/: transcript.jsonl, jail-files.json, open-log.jsonl,
 * key-batch.jsonl and run.json. Item text and keys stay local; mails carry counts and shas only.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const R = require('./run.cjs');
const G = require('./labeller-guard.cjs');
const { childEnv } = require('./answerer.cjs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const BATCH_TIMEOUT_MS = 90 * 60_000;
const TOOLS = ['Bash', 'Glob', 'Grep', 'Read', 'Write'];
// Never in a jail, by name: ledgers, memory, indexes, eligibility outputs, sealed or other keys.
const FORBIDDEN = /(^|\/)(memory|claims[^/]*|sealed[^/]*|elig[^/]*|key-[^/]*|[^/]*\.sqlite[^/]*|memory\.md|[^/]*ledger[^/]*)(\/|$)/i;

function parseArgs(argv) {
  const o = { keep: false, model: 'claude-opus-5-5' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (/^--(snapshot|addendum|labeller|group|xcheck|batch|instructions|guide|pilot|prompt|key|out|model|claude)$/.test(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['snapshot', 'addendum', 'labeller', 'group', 'xcheck', 'batch', 'instructions', 'guide', 'pilot', 'prompt', 'key', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  if (!/^[a-z][a-z0-9-]*$/.test(o.labeller)) throw new Error('bad --labeller');
  if (!/^[FD]$/.test(o.group)) throw new Error('--group is F or D');
  o.claude = o.claude || claudeExe();
  return o;
}

function claudeExe() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(path.join(dir, 'claude.cmd')) && fs.existsSync(exe)) return exe;
  }
  throw new Error('no Claude Code CLI on PATH');
}

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

/** The rows this labeller keys in a batch: its own group plus its cross-check ids. */
function ownRows(batch, group, xcheckIds) {
  const x = new Set(xcheckIds);
  return batch.filter((r) => r.group === group || x.has(r.itemId));
}

function copyFile(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }

/** Build the jail. Returns its file list (relative path, bytes, sha256), sorted. */
function buildJail(jail, o, snap, addDir) {
  const hive = path.join(snap, 'hive');
  copyFile(o.batch, path.join(jail, 'docs', path.basename(o.batch)));
  copyFile(o.instructions, path.join(jail, 'docs', 'INSTRUCTIONS-H1.md'));
  copyFile(o.guide, path.join(jail, 'docs', path.basename(o.guide)));
  copyFile(o.pilot, path.join(jail, 'docs', 'INSTRUCTIONS.md'));
  copyFile(o.xcheck, path.join(jail, 'docs', path.basename(o.xcheck)));
  for (const f of ['tasks.json', 'board.md', 'PROTOCOL.md']) copyFile(path.join(hive, f), path.join(jail, 'hive', f));
  fs.cpSync(path.join(hive, 'tasks-archive'), path.join(jail, 'hive', 'tasks-archive'), { recursive: true });
  for (const a of fs.readdirSync(path.join(hive, 'agents'))) {
    const done = path.join(hive, 'agents', a, 'inbox', '.done');
    if (!fs.existsSync(done)) continue;
    for (const f of fs.readdirSync(done).filter((n) => n.endsWith('.json'))) copyFile(path.join(done, f), path.join(jail, 'hive', 'agents', a, 'inbox', '.done', f));
  }
  const repo = path.join(jail, 'repo.git');
  execFileSync('git', ['clone', '--quiet', '--mirror', path.join(addDir, 'repo-at-ts.bundle'), repo], { stdio: 'ignore' });
  execFileSync('git', ['--git-dir', repo, 'config', 'remote.origin.url', 'repo-at-ts.bundle'], { stdio: 'ignore' });
  // key.jsonl is not created: the session writes it once (Write wants a Read before it overwrites).
  return jailFiles(jail);
}

function jailFiles(jail) {
  const out = [];
  for (const rel of fs.readdirSync(jail, { recursive: true })) {
    const abs = path.join(jail, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`the jail holds a link: ${rel}`);
    if (!st.isFile()) continue;
    out.push({ path: rel.replace(/\\/g, '/'), bytes: st.size, sha256: sha256(fs.readFileSync(abs)) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Names that must never be in a jail. repo.git internals and docs/ are judged too. */
function forbiddenIn(files) {
  return files.map((f) => f.path).filter((p) => !p.startsWith('repo.git/') && FORBIDDEN.test(p.replace(/^docs\/(INSTRUCTIONS(-H1)?\.md|LABEL-GUIDE[^/]*|batch-\d+\.jsonl|xcheck-[^/]*)$/, 'docs/ok')));
}

function settingsFor(jail, openLog, keyFile) {
  const d = (p) => `//${p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, x) => x.toLowerCase())}`;
  const guard = `"${process.execPath.replace(/\\/g, '/')}" "${path.join(__dirname, 'labeller-guard.cjs').replace(/\\/g, '/')}" "${jail.replace(/\\/g, '/')}" "${openLog.replace(/\\/g, '/')}" "${keyFile.replace(/\\/g, '/')}"`;
  return {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guard }] }] },
    permissions: {
      // Claude Code judges a Write by Edit rules, so the key file is allowed as Edit(...); the
      // tool set has no Edit tool, and the guard refuses any other write target.
      allow: [`Read(${d(jail)}/**)`, `Grep(${d(jail)}/**)`, `Glob(${d(jail)}/**)`, `Read(${d(G.ownOutputsDir(jail))}/**)`, 'Bash(git:*)', `Edit(${d(keyFile)})`],
      deny: ['WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'Agent'],
      defaultMode: 'default',
    },
  };
}

function jailEnv(jail, scratch) {
  const env = childEnv(path.join(scratch, 'bin'), {});
  for (const k of Object.keys(env)) if (/^(MUNDER|MEMORY|HIVE|AGENT|GUPPY)/i.test(k)) delete env[k];
  fs.mkdirSync(path.join(scratch, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'gitconfig-empty'), '');
  return { ...env, GIT_DIR: path.join(jail, 'repo.git'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig-empty'), GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

/** What the session did. compact: any compaction record. outside: calls the guard rules judge outside. */
function auditTranscript(file, jail, keyFile) {
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const init = rows.find((r) => r.type === 'system' && r.subtype === 'init') || null;
  const result = rows.find((r) => r.type === 'result') || null;
  const compact = rows.filter((r) => r.subtype === 'compact_boundary' || r.type === 'compact_boundary' || r.isCompactSummary).length;
  const calls = [];
  for (const r of rows) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) if (c.type === 'tool_use') calls.push({ id: c.id, tool: c.name, ...G.check(c.name, c.input, jail, keyFile) });
  }
  return {
    init: init ? {
      model: init.model, tools: init.tools, mcpServers: (init.mcp_servers || []).length, slashCommands: (init.slash_commands || []).length, skills: (init.skills || []).length,
      builtinPlugins: (init.plugins || []).filter((p) => p.path === 'builtin').map((p) => p.name), otherPlugins: (init.plugins || []).filter((p) => p.path !== 'builtin').length,
      autoMemoryFiles: (() => { try { return init.memory_paths?.auto ? fs.readdirSync(init.memory_paths.auto, { recursive: true }).length : 0; } catch { return 0; } })(),
      additionalDirectories: (init.additional_directories || []).length, claudeCodeVersion: init.claude_code_version,
    } : null,
    compact,
    calls,
    outside: calls.filter((c) => c.place === 'outside').length,
    denied: calls.filter((c) => c.decision === 'deny').length,
    result: result ? { isError: !!result.is_error, numTurns: result.num_turns, costUsd: result.total_cost_usd, usage: result.usage || null } : null,
  };
}

/** The session's key file, judged against the rows it had to key. */
function checkKey(text, own) {
  const want = new Set(own.map((r) => r.itemId));
  const seen = new Set();
  const rows = [];
  const problems = [];
  text.split(/\r?\n/).filter((l) => l.trim()).forEach((l, n) => {
    let j;
    try { j = JSON.parse(l); } catch { problems.push(`line ${n + 1}: not JSON`); return; }
    if (j.itemId === 'COST') return;
    if (!want.has(j.itemId)) { problems.push(`line ${n + 1}: ${j.itemId} is not one of this labeller's rows`); return; }
    if (seen.has(j.itemId)) { problems.push(`line ${n + 1}: ${j.itemId} repeated`); return; }
    seen.add(j.itemId);
    rows.push(j);
  });
  return { rows, keyed: seen.size, missing: [...want].filter((id) => !seen.has(id)), problems };
}

const tokensOf = (u) => (u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null);

async function main(argv) {
  const o = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const snap = path.resolve(o.snapshot);
  const addDir = path.resolve(o.addendum);
  for (const d of [snap, addDir]) if (R.linksUnder(d).length) throw new Error(`${d} holds a link or junction`);
  const v = R.verifySnapshot(snap);
  if (v.diffs.length) throw new Error(`the snapshot differs from its manifest (${v.diffs.length})`);
  const ad = R.verifyAddendum(addDir, v.manifestSha256);
  if (ad.diffs.length) throw new Error(`the addendum does not match (${ad.diffs.length})`);
  const batch = readJsonl(o.batch);
  const xcheck = JSON.parse(fs.readFileSync(o.xcheck, 'utf8'));
  const own = ownRows(batch, o.group, xcheck);
  const batchName = path.basename(o.batch, '.jsonl');
  const runDir = path.resolve(o.out, `${batchName}-${o.labeller}`);
  if (fs.existsSync(path.join(runDir, 'run.json')) && JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).verdict === 'VALID') throw new Error(`${batchName} is already keyed VALID for ${o.labeller}`);
  const keyOut = path.resolve(o.key);
  const already = fs.existsSync(keyOut) ? new Set(readJsonl(keyOut).map((r) => r.itemId)) : new Set();
  const clash = own.filter((r) => already.has(r.itemId)).map((r) => r.itemId);
  if (clash.length) throw new Error(`${clash.length} of this batch's rows are already in ${keyOut}`);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const run = {
    card: 'CLAIMS-90', mode: 'labeller', labeller: o.labeller, group: o.group, batch: batchName, startedAt,
    snapshot: path.basename(snap), manifestSha256: v.manifestSha256, addendumSha256: ad.addendumSha256, model: o.model,
    claudeExeSha256: sha256(fs.readFileSync(o.claude)),
    shas: Object.fromEntries(['batch', 'instructions', 'guide', 'pilot', 'xcheck', 'prompt'].map((k) => [k, sha256(fs.readFileSync(o[k]))])),
    code: { head: R.git(path.resolve(__dirname, '..', '..'), ['rev-parse', 'HEAD']), dirty: R.git(path.resolve(__dirname, '..', '..'), ['status', '--porcelain', '--', 'test/claims-90']) || '' },
    rows: batch.length, ownRows: own.length,
  };
  const finish = (verdict, extra = {}) => {
    Object.assign(run, extra, { verdict, finishedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 1));
    return run;
  };
  if (!own.length) return finish('SKIPPED', { reason: 'no rows for this labeller in the batch' });

  // The jail lives beside the run folder, never inside the snapshot or the hive.
  const jail = fs.mkdtempSync(path.join(path.resolve(o.out), `jail-${batchName}-${o.labeller}-`));
  const scratch = fs.mkdtempSync(path.join(path.resolve(o.out), `scratch-${batchName}-${o.labeller}-`));
  const keyFile = path.join(jail, 'key.jsonl');
  const openLog = path.join(runDir, 'open-log.jsonl');
  fs.writeFileSync(openLog, '');
  try {
    const files = buildJail(jail, o, snap, addDir);
    fs.writeFileSync(path.join(runDir, 'jail-files.json'), JSON.stringify(files, null, 1));
    run.jail = { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), listSha256: sha256(JSON.stringify(files)) };
    const bad = forbiddenIn(files);
    if (bad.length) return finish('INVALID', { reason: `the jail holds a forbidden name: ${bad[0]}` });
    const settingsFile = path.join(scratch, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(settingsFor(jail, openLog, keyFile), null, 1));
    const fill = { labeller: o.labeller, group: o.group, batchName, today: v.manifest.takenFrom, jail: jail.replace(/\\/g, '/'), keyFile: keyFile.replace(/\\/g, '/'), ownIds: own.map((r) => r.itemId).join(', ') };
    const prompt = fs.readFileSync(o.prompt, 'utf8').replace(/\{(labeller|group|batchName|today|jail|keyFile|ownIds)\}/g, (_, k) => fill[k]);
    const transcript = path.join(runDir, 'transcript.jsonl');
    const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose', '--settings', settingsFile, '--setting-sources', 'project,local',
      '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--tools', TOOLS.join(','), '--permission-mode', 'default'];
    const t0 = Date.now();
    const exit = await new Promise((resolve) => {
      const child = spawn(o.claude, args, { cwd: jail, env: jailEnv(jail, scratch), stdio: ['pipe', fs.openSync(transcript, 'w'), 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill(), BATCH_TIMEOUT_MS);
      child.on('close', (code) => { clearTimeout(timer); run.stderrTail = err.slice(-300); resolve(code); });
      child.stdin.end(prompt);
    });
    const a = auditTranscript(transcript, jail, keyFile);
    const log = readJsonl(openLog);
    const logOutside = log.filter((r) => r.place === 'outside').length;
    const key = checkKey(fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '', own);
    const initOk = a.init && JSON.stringify([...(a.init.tools || [])].sort()) === JSON.stringify(TOOLS) && a.init.mcpServers === 0 && a.init.otherPlugins === 0 && a.init.autoMemoryFiles === 0 && a.init.additionalDirectories === 0 && a.init.skills === 0;
    // The guard must have seen every call (the hook is the open log's source).
    const unlogged = a.calls.filter((c) => !log.some((r) => r.toolUseId === c.id)).length;
    let reason = null;
    if (a.compact) reason = `the session compacted (${a.compact})`;
    else if (a.outside || logOutside) reason = `a call named a path outside the jail (transcript ${a.outside}, open log ${logOutside})`;
    else if (!initOk) reason = 'the session started with more than its tools';
    else if (unlogged) reason = `${unlogged} call(s) missing from the open log`;
    else if (exit !== 0 || !a.result || a.result.isError) reason = `session failed (exit ${exit})`;
    else if (key.problems.length) reason = `key file: ${key.problems[0]}`;
    // A batch is keyed whole or not at all: an unanswerable row is still a row.
    else if (key.missing.length) reason = `key file: ${key.missing.length} of ${own.length} rows missing`;
    const tokens = tokensOf(a.result?.usage);
    Object.assign(run, {
      exit, ms: Date.now() - t0, init: a.init, compact: a.compact, calls: a.calls.length, denied: a.denied, outside: a.outside, logRows: log.length, logOutside, unlogged,
      byTool: a.calls.reduce((m, c) => ({ ...m, [c.tool]: (m[c.tool] || 0) + 1 }), {}),
      keyed: key.keyed, missing: key.missing, keyBatchSha256: null, costUsd: a.result?.costUsd ?? null, usage: a.result?.usage ?? null, tokens,
    });
    if (reason) return finish('INVALID', { reason });
    const cost = { itemId: 'COST', labeller: o.labeller, batches: batchName.replace(/^batch-/, ''), tokensStart: 0, tokensEnd: tokens, tokensF: null, tokensD: null, tokensSplitUnmeasured: true, costUsd: run.costUsd, startedAt, endedAt: new Date().toISOString() };
    const lines = [...key.rows, cost].map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(runDir, 'key-batch.jsonl'), lines);
    run.keyBatchSha256 = sha256(lines);
    fs.appendFileSync(keyOut, lines);
    return finish('VALID', { keySha256: sha256(fs.readFileSync(keyOut)) });
  } finally {
    if (!o.keep) {
      for (const d of [jail, scratch]) {
        if (R.linksUnder(d).length) console.error(`[claims-90] kept ${d}: it holds a link`);
        else fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((run) => {
    console.log(JSON.stringify({ batch: run.batch, labeller: run.labeller, verdict: run.verdict, reason: run.reason ?? null, ownRows: run.ownRows, keyed: run.keyed ?? 0, calls: run.calls ?? 0, costUsd: run.costUsd ?? null, keySha256: run.keySha256 ?? null }));
    process.exitCode = /^VALID|SKIPPED/.test(run.verdict) ? 0 : 1;
  }, (e) => { console.error(`[claims-90] ${e.stack || e.message}`); process.exitCode = 2; });
}

module.exports = { parseArgs, ownRows, buildJail, jailFiles, forbiddenIn, settingsFor, jailEnv, auditTranscript, checkKey, FORBIDDEN, TOOLS, main };
