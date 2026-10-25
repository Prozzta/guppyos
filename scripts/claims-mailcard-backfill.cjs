#!/usr/bin/env node
'use strict';
/**
 * C90-MAILCARD: the per-card mail index backfill over a hive COPY (the runner's T_s sandbox), never
 * the live hive. It links every message the hive's primary records prove was delivered (main's
 * MailLedger, or an inbox copy matched by the sender's own outbox/.sent copy) and appends it to
 * <hive>/state/mail-cards through the product's own writer (src/main/mailCards.ts).
 *
 *   node scripts/claims-mailcard-backfill.cjs --hive <sandbox hive> [--now <ISO>] [--unlinked <file>]
 *
 * --now: the link records' `at` (the runner passes T_s). --unlinked: write the unlinked message ids
 * (method none or ambiguous), one per line. It refuses a hive that is, holds or sits under the live
 * hive root (by real path and file identity), or one in or around the app's own user data. Mail
 * files are only read. Prints the counts as one JSON line.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(hive|now|unlinked)$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument ${argv[i]}`);
    o[m[1]] = argv[++i];
  }
  if (!o.hive) throw new Error('--hive is required');
  return o;
}

/** A folder's real path, lower case (claims-derived-backfill.cjs realOf). */
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

/** A folder's file identity (volume + file id), or null. */
function idOf(p) {
  try { const s = fs.statSync(p, { bigint: true }); return s.ino ? `${s.dev}/${s.ino}` : null; } catch { return null; }
}

function chainOf(p) {
  const ids = [];
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    const id = idOf(cur);
    if (id) ids.push(id);
    if (path.dirname(cur) === cur) return ids;
  }
}

/** Whether a and b are the same folder or one holds the other, by real path and by file identity. */
function overlaps(a, b) {
  const ra = realOf(a);
  const rb = realOf(b);
  const under = (x, y) => x === y || x.startsWith(y.endsWith(path.sep) ? y : y + path.sep);
  if (under(ra, rb) || under(rb, ra)) return true;
  const ia = idOf(a);
  const ib = idOf(b);
  return (ib !== null && chainOf(a).includes(ib)) || (ia !== null && chainOf(b).includes(ia));
}

const appDataRoots = () => [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean).map((d) => path.join(d, 'Munder Difflin'));

function main() {
  const o = parseArgs(process.argv.slice(2));
  const hive = path.resolve(o.hive);
  const live = path.resolve(process.env.MUNDER_HIVE_ROOT || 'C:/Dunder/hive');
  if (overlaps(hive, live)) throw new Error('refused: the backfill runs on a hive copy, never the live hive (nor a folder above it)');
  if (appDataRoots().some((r) => overlaps(hive, r))) throw new Error('refused: --hive must be a sandbox folder, never in or around the app\'s own user data');
  if (!fs.existsSync(path.join(hive, 'agents'))) throw new Error('--hive has no agents folder');
  const now = o.now ? new Date(o.now).toISOString() : new Date().toISOString();
  const { backfillMailCards } = loadTs(path.join(REPO, 'src/main/mailCards.ts'));
  const counts = backfillMailCards(hive, now);
  if (o.unlinked) fs.writeFileSync(o.unlinked, counts.unlinked.join('\n') + (counts.unlinked.length ? '\n' : ''));
  const { unlinked, ...rest } = counts;
  process.stdout.write(`${JSON.stringify({ ok: true, ...rest, unlinked: unlinked.length })}\n`);
}

try { main(); } catch (e) { process.stderr.write(`${e && e.message ? e.message : e}\n`); process.exit(2); }
