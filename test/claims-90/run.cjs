'use strict';
/**
 * CLAIMS-90 Phase 3: the scoring runner. Given an items file, it answers every item through the
 * product's real retrieval paths at the tree's sha (answer-child.cjs), over a disposable copy of
 * the frozen snapshot, and records the returned text per item for blind scoring.
 *
 *   node test/claims-90/run.cjs --snapshot <snapshot dir> --items <items.jsonl> --out <dir>
 *        [--resources <installed app resources dir>] [--now <ISO>] [--keep]
 *
 * items.jsonl, one per line: { "id": "...", "asker": "<agent id>", "searches": [["search", "<q>"], ...],
 *                              "wakeUp": true }   (searches are `memory` argv, passed through unchanged)
 * Writes only under --out: answers.jsonl (one row per item, then a summary row) and run.json.
 *
 * Before any answer it stops on: a snapshot file whose sha256 differs from the manifest, a link or
 * junction anywhere in the snapshot, a model that is not the tree's (manifest digests), or a live
 * hive path in the sandbox. The snapshot is never used in place.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { drillEnv } = require('../claims-drill/runner.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const o = { keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (/^--(snapshot|items|out|resources|now|tree)$/.test(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['snapshot', 'items', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  o.tree = path.resolve(o.tree || REPO);
  o.resources = path.resolve(o.resources || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Munder Difflin', 'Guppy', 'resources'));
  return o;
}

/** Every link or junction under dir (lstat sees a junction as a symbolic link). */
function linksUnder(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (fs.lstatSync(p).isSymbolicLink()) found.push(p);
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return found;
}

/** Re-hash the snapshot against its manifest; returns the differences (empty = intact). */
function verifySnapshot(snap) {
  const mbuf = fs.readFileSync(path.join(snap, 'manifest.json'));
  const manifest = JSON.parse(mbuf);
  const diffs = [];
  for (const f of manifest.files) {
    const p = path.join(snap, f.path);
    if (!fs.existsSync(p)) { diffs.push(`missing ${f.path}`); continue; }
    if (sha256(fs.readFileSync(p)) !== f.sha256) diffs.push(`changed ${f.path}`);
  }
  return { manifest, manifestSha256: sha256(mbuf), diffs };
}

function parseItems(file) {
  const items = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ids = new Set();
  for (const it of items) {
    if (typeof it.id !== 'string' || !it.id || ids.has(it.id)) throw new Error(`item id missing or repeated: ${it.id}`);
    ids.add(it.id);
    if (typeof it.asker !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(it.asker)) throw new Error(`${it.id}: bad asker`);
    if (!Array.isArray(it.searches) || it.searches.length > 3) throw new Error(`${it.id}: searches must be a list of at most 3 argv lists`);
    for (const s of it.searches) if (!Array.isArray(s) || !s.every((w) => typeof w === 'string')) throw new Error(`${it.id}: each search is an argv list of strings`);
  }
  return items;
}

/** Copy the groups the retrieval paths read into the sandbox (never the snapshot in place). */
function stageSandbox(snap, manifest, home) {
  const hive = path.join(home, 'hive');
  const userData = path.join(home, 'AppData', 'Roaming', 'Guppy');
  const groups = new Set(['retrieval', 'primary', 'retrieval-userdata', 'retrieval-index']);
  for (const f of manifest.files) {
    if (!groups.has(f.group)) continue;
    const dest = f.path.startsWith('hive/') ? path.join(hive, f.path.slice(5)) : path.join(userData, f.path.slice('userdata/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(snap, f.path), dest);
    fs.chmodSync(dest, 0o666);
  }
  // The key record, the head anchors and the index file are keyed by the hive root's id
  // (keyProvider hiveIdOf, mainWiring dbFileFor). Re-key the copies to the sandbox root, as a moved
  // hive would be; every value stays as it was.
  const { hiveIdOf } = require(path.join(REPO, 'test', 'load-ts.cjs'))(path.join(REPO, 'src', 'main', 'claims', 'keyProvider.ts'));
  const from = hiveIdOf(manifest.hiveRoot);
  const to = hiveIdOf(hive);
  for (const f of ['claims-mac.hives.json', 'claims-heads.json']) {
    const p = path.join(userData, f);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j.hives?.[from]) throw new Error(`${f} has no entry for the snapshot's hive`);
    j.hives = { [to]: j.hives[from] };
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  }
  fs.renameSync(path.join(userData, 'memory', `${from}-v2.sqlite`), path.join(userData, 'memory', `${to}-v2.sqlite`));
  return { hive, userData, hiveId: { from, to } };
}

function electronOf(tree) {
  const p = require(path.join(tree, 'node_modules', 'electron'));
  if (typeof p !== 'string' || !fs.existsSync(p)) throw new Error('the tree has no Electron');
  return p;
}

function unwrapKey(tree, userData, home) {
  return new Promise((resolve, reject) => {
    const env = drillEnv(home);
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(electronOf(tree), [path.join(__dirname, 'key-unwrap.cjs'), tree, userData], { cwd: tree, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const key = out.trim();
      if (code === 0 && Buffer.from(key, 'base64').length === 32) resolve(key);
      else reject(new Error(`key unwrap failed (exit ${code}): ${(err.match(/key: .*/) || [''])[0]}`));
    });
  });
}

function runChild(tree, specFile, home, key, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(electronOf(tree), [path.join(__dirname, 'answer-child.cjs'), specFile], { cwd: tree, env: drillEnv(home), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stderr: err }); });
    p.stdin.end(`${key}\n`);
  });
}

function git(tree, args) { try { return execFileSync('git', args, { cwd: tree, encoding: 'utf8' }).trim(); } catch { return null; } }

async function main(argv) {
  const o = parseArgs(argv);
  const t0 = new Date().toISOString();
  const snap = path.resolve(o.snapshot);
  const links = linksUnder(snap);
  if (links.length) throw new Error(`the snapshot holds ${links.length} link(s) or junction(s): ${links[0]}`);
  const v = verifySnapshot(snap);
  if (v.diffs.length) throw new Error(`the snapshot differs from its manifest (${v.diffs.length}): ${v.diffs.slice(0, 3).join('; ')}`);
  const items = parseItems(o.items);
  const treeModel = fs.readFileSync(path.join(o.tree, 'resources', 'models', 'native-memory-manifest.json'));
  const appModel = fs.readFileSync(path.join(o.resources, 'models', 'native-memory-manifest.json'));
  if (sha256(treeModel) !== sha256(appModel)) throw new Error('the model manifest at --resources is not the tree\'s');

  fs.mkdirSync(o.out, { recursive: true });
  const home = fs.mkdtempSync(path.join(path.resolve(o.out), 'sandbox-'));
  for (const d of ['tmp', path.join('AppData', 'Local')]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const { hive, userData } = stageSandbox(snap, v.manifest, home);
  const answers = path.join(path.resolve(o.out), 'answers.jsonl');
  const specFile = path.join(home, 'answer-spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ tree: o.tree, hive, userData, home, resourcesDir: o.resources, now: o.now || v.manifest.takenTo, items, out: answers }));
  let child = null;
  try {
    const key = await unwrapKey(o.tree, userData, home);
    child = await runChild(o.tree, specFile, home, key, Math.max(10 * 60_000, items.length * 60_000));
  } finally {
    if (!o.keep) {
      const inner = linksUnder(home);
      if (inner.length) console.error(`[claims-90] kept the sandbox: it holds a link (${inner[0]})`);
      else fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  const rows = fs.existsSync(answers) ? fs.readFileSync(answers, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const summary = rows.find((r) => r.summary)?.summary ?? { ok: false, reason: `the child left no summary (exit ${child?.code}): ${String(child?.stderr || '').slice(0, 600)}` };
  const run = {
    card: 'CLAIMS-90', startedAt: t0, finishedAt: new Date().toISOString(),
    snapshot: path.basename(snap), manifestSha256: v.manifestSha256, now: o.now || v.manifest.takenTo,
    code: {
      head: git(o.tree, ['rev-parse', 'HEAD']),
      claimsTree: git(o.tree, ['rev-parse', 'HEAD:src/main/claims']),
      nativeMemoryTree: git(o.tree, ['rev-parse', 'HEAD:src/main/nativeMemory']),
      memoryCli: git(o.tree, ['rev-parse', 'HEAD:resources/memory-cli.cjs']),
      dirty: git(o.tree, ['status', '--porcelain', '--', 'src', 'resources/memory-cli.cjs']) || '',
      modelManifestSha256: sha256(treeModel),
    },
    itemsSha256: sha256(fs.readFileSync(o.items)), items: items.length, answered: rows.filter((r) => r.id).length,
    childExit: child?.code ?? null, summary,
  };
  fs.writeFileSync(path.join(path.resolve(o.out), 'run.json'), JSON.stringify(run, null, 1));
  return run;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((run) => {
    console.log(JSON.stringify({ ok: run.summary.ok, answered: run.answered, items: run.items, manifestSha256: run.manifestSha256, head: run.code.head, reason: run.summary.reason }, null, 1));
    process.exitCode = run.summary.ok && run.answered === run.items ? 0 : 1;
  }, (e) => { console.error(`[claims-90] ${e.message}`); process.exitCode = 2; });
}

module.exports = { parseArgs, parseItems, verifySnapshot, linksUnder, stageSandbox, main };
