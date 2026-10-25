#!/usr/bin/env node
'use strict';
/**
 * CLAIMS-90 M5: the derived writer's backfill over a hive COPY (the runner's T_s sandbox), never the
 * live hive. It appends the derived claims into <hive>/agents/derived through the product's own store.
 *
 *   node scripts/claims-derived-backfill.cjs --hive <sandbox hive> --user-data <sandbox user data>
 *        [--repo <git repo at T_s>] [--changelog-ref <ref> | --changelog-file <file>] [--now <ISO>]
 *        < key.hex
 *
 * stdin: the ledger MAC key as 64 hex (the runner unwraps it from the copy, run.cjs unwrapKey).
 * --repo: a clone of the addendum's repo-at-ts.bundle. Without it, lastsha, tags and done-mail shas
 *   are skipped (git tells a commit from any hex word). --changelog-ref defaults to the newest tag.
 * --now: the store's clock (the runner passes T_s, so every claim's wt is T_s).
 * It refuses a hive that is, holds or sits under the live hive root (by real path and file identity),
 * a user-data dir in or around the app's own (LOCALAPPDATA or APPDATA\Munder Difflin), and one whose
 * key record or head anchors name another hive or key. Prints the counts as one JSON line.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(hive|user-data|repo|changelog-ref|changelog-file|now)$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument ${argv[i]}`);
    o[m[1]] = argv[++i];
  }
  for (const k of ['hive', 'user-data']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

/**
 * A folder's real path, lower case: junctions, symlinks, subst drives and the \\?\ prefix resolved
 * (fs.realpathSync.native). A tail that does not exist yet is kept as typed below its nearest real
 * ancestor.
 */
function realOf(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest).toLowerCase(); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p).toLowerCase();
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

/** A folder's file identity (volume + file id), or null: the same for every spelling, \\host\C$ included. */
function idOf(p) {
  try { const s = fs.statSync(p, { bigint: true }); return s.ino ? `${s.dev}/${s.ino}` : null; } catch { return null; }
}

/** The identities of p and every existing folder above it. */
function chainOf(p) {
  const ids = [];
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    const id = idOf(cur);
    if (id) ids.push(id);
    if (path.dirname(cur) === cur) return ids;
  }
}

/**
 * Whether a and b are the same folder or one holds the other (Jim's M5 audit SHOULD a), by real path
 * and by file identity, so a UNC admin share, junction, symlink, subst drive or \\?\ path of the live
 * hive, or a folder above it, is caught.
 */
function overlaps(a, b) {
  const ra = realOf(a);
  const rb = realOf(b);
  const under = (x, y) => x === y || x.startsWith(y.endsWith(path.sep) ? y : y + path.sep);
  if (under(ra, rb) || under(rb, ra)) return true;
  const ia = idOf(a);
  const ib = idOf(b);
  return (ib !== null && chainOf(a).includes(ib)) || (ia !== null && chainOf(b).includes(ia));
}

/** The app's own user-data roots (the packaged app keeps its key record under one of them). */
const appDataRoots = () => [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean).map((d) => path.join(d, 'Munder Difflin'));

/**
 * The key record or head anchor file in `ud` that this run must not touch (SHOULD b), or null: one
 * that is unreadable, names another hive, or records another key for this hive. A record a previous
 * run over this same copy wrote (this hive, this key) is fine.
 */
function foreignRecord(ud, hive, key, k) {
  const id = k.hiveIdOf(hive);
  for (const f of [k.KEY_RECORD_FILE, k.HEAD_ANCHOR_FILE]) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(ud, f), 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') continue; return f; }
    const hives = j && typeof j.hives === 'object' && j.hives ? j.hives : null;
    if (!hives || Object.keys(hives).some((h) => h !== id)) return f;
    if (f === k.KEY_RECORD_FILE && hives[id] && hives[id].keyId !== k.keyIdOf(key)) return f;
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const newest = (tags) => tags
  .map((t) => ({ t, v: (/^v?(\d+(?:\.\d+){1,3})$/.exec(t.name) || [])[1] }))
  .filter((x) => x.v)
  .sort((a, b) => { const x = a.v.split('.').map(Number); const y = b.v.split('.').map(Number); for (let i = 0; i < 4; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; })
  .pop()?.t;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const hive = path.resolve(o.hive);
  const live = path.resolve(process.env.MUNDER_HIVE_ROOT || 'C:/Dunder/hive');
  if (overlaps(hive, live)) throw new Error('refused: the backfill runs on a hive copy, never the live hive (nor a folder above it)');
  const ud = path.resolve(o['user-data']);
  if (overlaps(ud, live) || appDataRoots().some((r) => overlaps(ud, r))) throw new Error('refused: --user-data must be a sandbox folder, never the app\'s own user data or the live hive');
  const keyHex = await readStdin();
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('stdin must be the 64-hex ledger key');
  const { ClaimStore } = loadTs(path.join(REPO, 'src/main/claims/store.ts'));
  const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE, hiveIdOf } = loadTs(path.join(REPO, 'src/main/claims/keyProvider.ts'));
  const { keyIdOf } = loadTs(path.join(REPO, 'src/main/claims/canonical.ts'));
  const key = Buffer.from(keyHex, 'hex');
  const foreign = foreignRecord(ud, hive, key, { hiveIdOf, keyIdOf, KEY_RECORD_FILE, HEAD_ANCHOR_FILE });
  if (foreign) throw new Error(`refused: ${foreign} in --user-data belongs to another hive or key; use a fresh sandbox folder`);
  const { derive } = loadTs(path.join(REPO, 'src/main/claims/derive.ts'));
  const { DEFAULT_KEY_REGISTRY, loadRegistry } = loadTs(path.join(REPO, 'src/main/claims/registry.ts'));
  const { runDerivedBackfill } = loadTs(path.join(REPO, 'src/main/claims/derivedWriter.ts'));
  const { DerivedGit } = loadTs(path.join(REPO, 'src/main/claims/derivedGit.ts'));
  const logs = [];
  const store = new ClaimStore({
    hiveRoot: hive,
    keys: new SandboxKeyProvider(key),
    keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)),
    headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)),
    log: (row) => logs.push(row),
    ...(o.now ? { now: () => new Date(o.now) } : {}),
  });
  try {
    const git = o.repo ? new DerivedGit(path.resolve(o.repo)) : null;
    if (git && !(await git.ok())) throw new Error('--repo is not a git repository');
    const tags = git ? await git.tags() : [];
    let changelog = null;
    if (o['changelog-file']) changelog = fs.readFileSync(o['changelog-file'], 'utf8');
    else if (git) { const ref = o['changelog-ref'] || newest(tags)?.name; changelog = ref ? await git.show(ref, 'CHANGELOG.md') : null; }
    const reg = () => { try { return loadRegistry(hive); } catch { return DEFAULT_KEY_REGISTRY; } };
    const counts = await runDerivedBackfill(
      { store, derive: (records) => derive(records, reg(), { r4: false }), log: (row) => logs.push(row) },
      { hiveRoot: hive, git, releases: { changelog, tags, ...(git ? { bumps: await git.bumps() } : {}) }, ...(git ? { prefetch: (s) => git.prefetch(s) } : {}) },
    );
    const failed = logs.filter((r) => r.kind === 'claims-derived-append-failed').length;
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, ...counts, tags: tags.length, changelog: changelog !== null, logKinds: [...new Set(logs.map((r) => r.kind))] })}\n`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    store.close();
  }
}

main().catch((e) => { process.stderr.write(`${e && e.message ? e.message : e}\n`); process.exit(2); });
