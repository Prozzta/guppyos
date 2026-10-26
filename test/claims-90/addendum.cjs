'use strict';
/**
 * CLAIMS-90 spec v2 §5.2: the hashed addendum to the frozen snapshot (the manifest is never edited).
 *
 *   node test/claims-90/addendum.cjs --snapshot <snapshot dir> --repo <guppyos repo> --out <addendum dir>
 *
 * It writes, from sources dated <= T_s (the manifest's takenFrom):
 *   refs-at-ts.json   every branch and remote ref's value at T_s, from its reflog (the newest entry at
 *                     or before T_s); a tag only if its tagger date (or a light tag's commit date) is
 *                     <= T_s. A ref with no reflog entry at or before T_s is dropped and counted.
 *   repo-at-ts.bundle a git bundle of exactly those refs (built in a scratch repo that borrows the
 *                     objects through alternates, so the source repo is only read).
 *   world.json        the delivery world view, recorded once (M3): for each ledger agent's registry
 *                     cwd, whether git answers there, and fileExists for every file ref its claims cite.
 *                     The runner answers delivery's git and fileExists from this file, never the disk.
 *   addendum.json     the sha256 of each file above, T_s, the snapshot manifest's sha, the sources.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (/^--(snapshot|repo|out)$/.test(argv[i])) o[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const k of ['snapshot', 'repo', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

/** A ref's value at T_s from its reflog lines (`old new who <unix> <tz>\tmsg`), or null. */
function valueAt(reflog, tsSec) {
  let v = null;
  for (const line of reflog.split('\n')) {
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) .*> (\d+) [+-]\d{4}/.exec(line);
    if (!m) continue;
    if (Number(m[3]) > tsSec) break;
    v = /^0{40}$/.test(m[2]) ? null : m[2];
  }
  return v;
}

function refsAtTs(repo, tsSec) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  const gitDir = path.resolve(repo, git(['rev-parse', '--git-dir']).trim());
  const refs = {};
  const dropped = [];
  for (const line of git(['for-each-ref', '--format=%(refname) %(objecttype) %(taggerdate:unix) %(committerdate:unix)', 'refs/heads', 'refs/remotes', 'refs/tags']).split('\n').filter(Boolean)) {
    const [name, type, tagger, committer] = line.split(' ');
    if (name.endsWith('/HEAD')) continue;
    if (name.startsWith('refs/tags/')) {
      const when = Number(type === 'tag' ? tagger : committer);
      if (when && when <= tsSec) refs[name] = { value: git(['rev-parse', name]).trim(), source: type === 'tag' ? 'tagger-date' : 'commit-date' };
      continue;
    }
    const log = path.join(gitDir, 'logs', ...name.split('/'));
    const v = fs.existsSync(log) ? valueAt(fs.readFileSync(log, 'utf8'), tsSec) : null;
    if (v) refs[name] = { value: v, source: 'reflog' };
    else dropped.push({ ref: name, reason: fs.existsSync(log) ? 'no reflog entry at or before T_s' : 'no reflog' });
  }
  return { gitDir, refs, dropped };
}

function bundleOf(gitDir, refs, file) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-bundle-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', maxBuffer: 64 << 20 });
    g(['init', '--bare', '-q', '.']);
    fs.writeFileSync(path.join(scratch, 'objects', 'info', 'alternates'), `${path.join(gitDir, 'objects').replace(/\\/g, '/')}\n`);
    const updates = Object.entries(refs).map(([name, r]) => `create ${name} ${r.value}\n`).join('');
    const u = spawnSync('git', ['update-ref', '--stdin'], { cwd: scratch, input: updates, encoding: 'utf8' });
    if (u.status !== 0) throw new Error(`update-ref failed: ${u.stderr.slice(0, 300)}`);
    g(['bundle', 'create', '-q', file, '--all']);
    const verify = spawnSync('git', ['bundle', 'list-heads', file], { cwd: scratch, encoding: 'utf8', maxBuffer: 64 << 20 });
    return verify.stdout.split('\n').filter(Boolean).length;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** M3: delivery's world questions for each ledger agent, answered once from the disk. */
function recordWorld(snap) {
  const hive = path.join(snap, 'hive');
  const reg = JSON.parse(fs.readFileSync(path.join(hive, 'registry.json'), 'utf8'));
  const cwds = {};
  const files = {};
  const perAgent = {};
  for (const agent of fs.readdirSync(path.join(hive, 'agents'))) {
    const dir = path.join(hive, 'agents', agent, 'memory', 'claims');
    if (!fs.existsSync(dir)) continue;
    const cwd = reg.agents?.[agent]?.cwd;
    if (!cwd) throw new Error(`${agent} has a ledger but no registry cwd`);
    if (!(cwd in cwds)) {
      const r = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8', windowsHide: true });
      cwds[cwd] = { exists: fs.existsSync(cwd), git: r.status === 0 ? 'repository' : 'not-a-repository' };
    }
    let refs = 0;
    for (const f of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n))) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec?.t !== 'claim') continue;
        for (const ref of rec.refs ?? []) {
          if (ref?.type !== 'file' || typeof ref.value !== 'string') continue;
          const abs = path.resolve(cwd, ref.value);
          if (!(abs in files)) files[abs] = fs.existsSync(abs);
          refs++;
        }
      }
    }
    perAgent[agent] = { cwd, fileRefs: refs };
  }
  return { recordedAt: new Date().toISOString(), cwds, perAgent, files };
}

function main(argv) {
  const o = parseArgs(argv);
  const snap = path.resolve(o.snapshot);
  const mbuf = fs.readFileSync(path.join(snap, 'manifest.json'));
  const manifest = JSON.parse(mbuf);
  const ts = manifest.takenFrom;
  const tsSec = Math.floor(Date.parse(ts) / 1000);
  const out = path.resolve(o.out);
  if (fs.existsSync(out)) throw new Error(`${out} exists: an addendum is written once`);
  fs.mkdirSync(out, { recursive: true });

  const { gitDir, refs, dropped } = refsAtTs(path.resolve(o.repo), tsSec);
  fs.writeFileSync(path.join(out, 'refs-at-ts.json'), JSON.stringify({ ts, repo: path.resolve(o.repo), refs, dropped }, null, 1));
  const heads = bundleOf(gitDir, refs, path.join(out, 'repo-at-ts.bundle'));
  if (heads !== Object.keys(refs).length) throw new Error(`the bundle lists ${heads} heads, expected ${Object.keys(refs).length}`);
  const world = recordWorld(snap);
  fs.writeFileSync(path.join(out, 'world.json'), JSON.stringify(world, null, 1));

  const files = ['refs-at-ts.json', 'repo-at-ts.bundle', 'world.json'].map((f) => ({ path: f, sha256: sha256(fs.readFileSync(path.join(out, f))), bytes: fs.statSync(path.join(out, f)).size }));
  const addendum = {
    card: 'CLAIMS-90', ts, snapshot: path.basename(snap), snapshotManifestSha256: sha256(mbuf), createdAt: new Date().toISOString(),
    sources: { repo: path.resolve(o.repo), refs: Object.keys(refs).length, dropped: dropped.length, worldRecordedAt: world.recordedAt },
    files,
  };
  fs.writeFileSync(path.join(out, 'addendum.json'), JSON.stringify(addendum, null, 1));
  return { out, addendumSha256: sha256(fs.readFileSync(path.join(out, 'addendum.json'))), refs: Object.keys(refs).length, dropped: dropped.length, cwds: world.cwds, files: Object.keys(world.files).length, fileRefs: world.perAgent };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 1)); } catch (e) { console.error(`[claims-90 addendum] ${e.message}`); process.exitCode = 2; }
}

module.exports = { valueAt, parseArgs };
