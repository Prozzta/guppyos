#!/usr/bin/env node
/*
 * TASKS-JSON-SPLIT: the hot/cold task ledger's commands (src/main/taskArchive.ts has the model).
 * hot = <hive>/tasks.json (live cards + done < 48 h); cold = <hive>/tasks-archive/YYYY-MM.jsonl.
 *
 *   tasks-all                 print every card ever made as one { "tasks": [...] } (hot wins)
 *   tasks-revive <CARD-ID>    move one archived card back to hot (through the app's ledger route)
 *   tasks-unsplit --yes       rollback: write hot + archive back into one tasks.json and set the
 *                             archive aside (tasks-archive.unsplit-<ts>). Refused while Guppy is
 *                             live (it bypasses the app's merged write); a split build re-splits
 *                             at its next start, so roll the build back first. Run with Guppy closed,
 *                             or just before starting an older build: a running new build splits
 *                             again on its next hourly pass.
 *
 * The hive root comes from --root (the shims pass it), else HIVE_ROOT.
 * Exit codes: 0 ok, 1 refused, 2 bad arguments, 3 unavailable.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3 };
const ARCHIVE_DIR = 'tasks-archive';
/** The app rewrites fleet.json every few seconds while it runs. */
const LIVE_FLEET_MS = 60_000;
const USAGE = 'usage: tasks-all | tasks-revive <CARD-ID> | tasks-unsplit --yes   [--root <hive>]\n';

const idOf = (c) => (c && typeof c === 'object' && typeof c.id === 'string' && c.id ? c.id : null);

/** Same reading rules as taskArchive.readArchive: latest line per id, tombstones applied. */
function readArchive(root) {
  const out = new Map();
  const dir = path.join(root, ARCHIVE_DIR);
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      if (typeof row.revived === 'string') { out.delete(row.revived); continue; }
      const id = idOf(row.card);
      if (id) out.set(id, row.card);
    }
  }
  return out;
}

/** Why the app looks live (unsplit must not race its writes), or null. An agent shell always
 *  has HIVE_LEDGER_URL, and the running app keeps fleet.json fresh. */
function appLive(root, env, now = Date.now()) {
  if (env.HIVE_LEDGER_URL) return 'HIVE_LEDGER_URL is set (this shell belongs to a running Guppy)';
  try {
    const age = now - fs.statSync(path.join(root, 'fleet.json')).mtimeMs;
    if (age < LIVE_FLEET_MS) return `fleet.json was written ${Math.max(0, Math.round(age / 1000))} s ago (Guppy is running)`;
  } catch { /* no fleet.json: not live */ }
  return null;
}

function readHot(root) {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'));
  return Array.isArray(parsed && parsed.tasks) ? parsed.tasks : [];
}

function parseArgs(argv) {
  const a = { cmd: null, rest: [], root: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--root') { a.root = argv[++i]; if (!a.root) throw new Error('--root needs a path'); }
    else if (v === '--yes') a.yes = true;
    else if (v === '-h' || v === '--help') a.cmd = 'help';
    else if (!a.cmd) a.cmd = v;
    else a.rest.push(v);
  }
  return a;
}

async function main(argv, env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let a;
  try { a = parseArgs(argv); } catch (e) { io.err(`tasks: ${e.message}\n${USAGE}`); return EXIT.usage; }
  if (a.cmd === 'help' || !a.cmd) { io.out(USAGE); return a.cmd ? EXIT.ok : EXIT.usage; }
  const root = a.root || env.HIVE_ROOT;
  if (!root || !fs.existsSync(path.join(root, 'tasks.json'))) { io.err(`tasks: no hive tasks.json (give --root or set HIVE_ROOT)\n`); return EXIT.unavailable; }

  if (a.cmd === 'all') {
    if (a.rest.length) { io.err(USAGE); return EXIT.usage; }
    const hot = readHot(root);
    const inHot = new Set(hot.map(idOf).filter(Boolean));
    const tasks = hot.slice();
    for (const [id, card] of readArchive(root)) if (!inHot.has(id)) tasks.push(card);
    io.out(JSON.stringify({ tasks }, null, 2) + '\n');
    return EXIT.ok;
  }

  if (a.cmd === 'revive') {
    const id = a.rest[0];
    if (!id || a.rest.length !== 1) { io.err(USAGE); return EXIT.usage; }
    if (readHot(root).some((c) => idOf(c) === id)) { io.out(`${id} is already in tasks.json\n`); return EXIT.ok; }
    if (!readArchive(root).has(id)) { io.err(`tasks: no archived card ${id}\n`); return EXIT.refused; }
    // Through the app (merge, validation, attribution): a patch of an archived card revives it.
    const op = { op: `tasks-revive-${id}-${Date.now()}`, card: { id, appendNote: 'revived from the task archive (tasks-revive)' } };
    const ledger = require('./ledger-cli.cjs');
    return ledger.main([], env, { out: io.out, err: io.err, stdin: Readable.from([Buffer.from(JSON.stringify(op))]) });
  }

  if (a.cmd === 'unsplit') {
    if (!a.yes) { io.err('tasks: unsplit rewrites tasks.json; run it with Guppy closed and pass --yes\n'); return EXIT.usage; }
    const live = appLive(root, env);
    if (live) { io.err(`tasks: unsplit refused: ${live}. Close Guppy, then run it from a plain shell.\n`); return EXIT.refused; }
    const archived = readArchive(root);
    const dir = path.join(root, ARCHIVE_DIR);
    if (!fs.existsSync(dir)) { io.out('nothing to unsplit (no tasks-archive/)\n'); return EXIT.ok; }
    const hot = readHot(root);
    const inHot = new Set(hot.map(idOf).filter(Boolean));
    const tasks = [];
    for (const [id, card] of archived) if (!inHot.has(id)) tasks.push(card);
    const all = tasks.concat(hot);
    const target = path.join(root, 'tasks.json');
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ tasks: all }, null, 2));
    fs.renameSync(tmp, target);
    const aside = `${ARCHIVE_DIR}.unsplit-${Date.now()}`;
    fs.renameSync(dir, path.join(root, aside));
    io.out(`unsplit: tasks.json has ${all.length} cards (${tasks.length} from the archive); the archive is now ${aside}\n`);
    return EXIT.ok;
  }

  io.err(`tasks: unknown command ${a.cmd}\n${USAGE}`);
  return EXIT.usage;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`tasks: ${e && e.stack ? e.stack : e}\n`); process.exitCode = EXIT.unavailable; });
}

module.exports = { appLive, LIVE_FLEET_MS, main, parseArgs, readArchive, EXIT };
