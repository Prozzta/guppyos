'use strict';
/**
 * TEST-GLOB-PID-RECYCLE (1.1.88): a test kills only what it started.
 *
 * Windows reuses pids, and a process keeps the ParentProcessId of a parent that is long gone. So
 * "ParentProcessId = X" also matches an OLDER process whose parent once had pid X: the Human's
 * HWiNFO64.EXE (pid 20664) was listed as a hung test file's child and then process.kill'ed; it
 * survived only because it runs elevated. `taskkill /T` walks the same links, so it is not used
 * here. The rules:
 * - a child is one created at or after its parent (CreationDate);
 * - a pid recorded by a test is ours only while it still has the name it was recorded with and was
 *   created AT OR BEFORE the recorded birth. The birth `bornMs` is any time taken while ours was
 *   known to be alive: `Date.now()` right after the spawn, or bornNow() inside the process (both are
 *   always LATER than the CreationDate, by 8-37 ms and 62-317 ms measured). Exact, one-sided, no
 *   slack: a process created before bornMs that is alive now held that pid at bornMs, when ours did,
 *   which is impossible; so a LIVE row under the pid created after bornMs is a reuse (a stranger),
 *   and one created before it with another name means the record itself is wrong (`older`: callers
 *   that check a run fail loudly on it, it is a bug, not a stranger);
 * - just before a kill, the pid must still have the name and CreationDate it was found with.
 * Not on win32: no process table, so nothing can be verified and nothing is killed.
 */
const { execFileSync } = require('node:child_process');

/**
 * ONLY for the orphans of a root that is gone: how far before `bornMs` a child of ours may have been
 * created (clock rounding; ours was created at most this long before bornMs). Never used for the root.
 */
const ORPHAN_LEAD_MS = 1_000;
/** @deprecated the old two-sided slack; kept so callers that import it still load. Same as ORPHAN_LEAD_MS. */
const BIRTH_SLACK_MS = ORPHAN_LEAD_MS;

/** The birth of the calling process, for a test that records its own pid. */
const bornNow = () => Math.round(Date.now() - process.uptime() * 1000);

/** Rows `pid|ppid|createdMs|name` (one per line) -> [{ pid, ppid, created, name }]. */
function parseRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(-?\d+)\|(.*)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]), name: m[4] });
  }
  return rows;
}

/** PURE: the same process, not just the same pid: name and creation time too. */
function sameProcess(a, b) {
  return !!a && !!b && a.pid === b.pid && a.created === b.created && String(a.name).toLowerCase() === String(b.name).toLowerCase();
}

/** PURE: the children of `parent` ({ pid, created }): its ParentProcessId AND created at or after it. */
function childrenOf(rows, parent) {
  return rows.filter((r) => r.ppid === parent.pid && r.pid !== parent.pid && r.created >= parent.created);
}

/** PURE: every descendant of `parent`, each link checked the same way (not the parent itself). */
function treeOf(rows, parent) {
  const out = [], seen = new Set([parent.pid]), todo = [parent];
  while (todo.length) {
    for (const c of childrenOf(rows, todo.shift())) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid); out.push(c); todo.push(c);
    }
  }
  return out;
}

/**
 * PURE: what of a recorded process is ours. `rec` = { pid, bornMs, name?, goneBy? } (the pid and
 * birth a test wrote down; `goneBy`, optional: a time by which ours was known to be gone).
 * - A live row under the pid created at or before bornMs, with the name: ours, with its tree.
 * - Created AFTER bornMs: the pid was reused, a `stranger`; nothing is ours, not its tree either.
 * - Created at or before bornMs with ANOTHER name: impossible for a stranger, so the record is wrong:
 *   `stranger` and `older: true`. Callers that judge a run must fail on it (a bug, never "nothing left").
 * - No row (ours is gone): its orphans still are, the rows that name it as parent, created no earlier
 *   than ORPHAN_LEAD_MS before bornMs and, when `goneBy` is known, no later than it (a later process
 *   that took the pid after ours died can only have had its children after that).
 */
function ownTree(rows, rec, leadMs = ORPHAN_LEAD_MS) {
  const r = rows.find((x) => x.pid === rec.pid);
  if (r) {
    if (r.created > rec.bornMs) return { root: null, tree: [], stranger: r, older: false };
    if (rec.name && r.name.toLowerCase() !== String(rec.name).toLowerCase()) return { root: null, tree: [], stranger: r, older: true };
    return { root: r, tree: [r, ...treeOf(rows, r)] };
  }
  const tree = treeOf(rows, { pid: rec.pid, created: rec.bornMs - leadMs });
  return { root: null, tree: Number.isFinite(rec.goneBy) ? cutAfter(tree, rec.goneBy) : tree };
}

/** The tree without the rows created after `t` (in a treeOf tree a child is never older than its parent, so
 *  what is below a cut row is cut too). */
function cutAfter(tree, t) {
  return tree.filter((r) => r.created <= t);
}

/** ownTree, but an `older` stranger (a wrong record) throws: for a check that must not pass vacuously. */
function ownTreeOrThrow(rows, rec) {
  const t = ownTree(rows, rec);
  if (t.older) throw new Error(`own-procs: pid ${rec.pid} is ${t.stranger.name}, created at ${t.stranger.created}, BEFORE the recorded birth ${rec.bornMs} of ${rec.name}: the record is wrong`);
  return t;
}

/**
 * Kill each of `targets` (rows) that is STILL the same process. `lookup(pids)` returns their rows
 * now; `kill(rows)` kills those (the real one checks the name and CreationDate once more, in the
 * same PowerShell that stops them). Returns { attempted, skipped } (rows): `attempted` were handed to
 * the kill, which may still fail (Stop-Process on an elevated process fails silently). `killed` is the
 * same list under its old name, for older callers.
 */
function killVerified(targets, { lookup = lookupPids, kill = stopIfSame } = {}) {
  if (!targets.length) return { attempted: [], killed: [], skipped: [] };
  const now = new Map(lookup(targets.map((t) => t.pid)).map((r) => [r.pid, r]));
  const same = targets.filter((t) => sameProcess(t, now.get(t.pid)));
  const skipped = targets.filter((t) => !same.includes(t));
  // Deepest first, the root last (targets come parent first): a killed root ends the run that then stops
  // the killer (the file watchdog), and a tree kill cut off there orphaned the ConPTY conhost.
  if (same.length) kill(same.slice().reverse());
  return { attempted: same, killed: same, skipped };
}

/** The recorded process's row while it still runs as ours; null when it is gone or its pid is another's. */
function stillOurs(rec, { table = processTable } = {}) {
  return ownTree(table(), rec).root;
}

/** "pid born" as a test wrote it (born: `Date.now()` right after a spawn, or bornNow() in the process). */
function readRec(file, name) {
  const [pid, bornMs] = require('node:fs').readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
  return { pid, bornMs, name };
}

/** Kill what of `rec` is ours (ownTree), verified. Returns { attempted, killed, skipped, stranger }. */
function killOwnTree(rec, { table = processTable, lookup = lookupPids, kill = stopIfSame } = {}) {
  const t = ownTree(table(), rec);
  return { ...killVerified(t.tree, { lookup, kill }), stranger: t.stranger || null };
}

const ROW = '"$($_.ProcessId)|$($_.ParentProcessId)|$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())|$($_.Name)"';
function powershell(script) {
  const body = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
}

/** The process table (win32; [] elsewhere). `filter` is a WQL filter, e.g. "ParentProcessId=12". */
function processTable(filter = '') {
  if (process.platform !== 'win32') return [];
  return parseRows(powershell(`Get-CimInstance Win32_Process${filter ? ` -Filter '${filter.replace(/'/g, "''")}'` : ''} | ForEach-Object { ${ROW} }`));
}

/** The rows of these pids now. */
function lookupPids(pids) {
  const ids = pids.map(Number).filter((p) => Number.isInteger(p) && p > 0);
  return ids.length ? processTable(ids.map((p) => `ProcessId=${p}`).join(' OR ')) : [];
}

/** The PowerShell that stops each row's pid only if it still has that name and CreationDate. */
function stopScript(rows) {
  const json = JSON.stringify(rows.map((r) => ({ pid: r.pid, created: r.created, name: r.name }))).replace(/'/g, "''");
  // assigned first: PowerShell 5.1 passes ConvertFrom-Json's array down a pipeline as ONE object
  return `$list = '${json}' | ConvertFrom-Json
foreach ($t in $list) {
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$($t.pid)"
  if ($q -and $q.Name -eq $t.name -and ([DateTimeOffset]$q.CreationDate).ToUnixTimeMilliseconds() -eq $t.created) { Stop-Process -Id $t.pid -Force -ErrorAction SilentlyContinue }
}`;
}

/** Stop each row's pid, but only if it still has that name and CreationDate (checked here, again). `run` is for tests. */
function stopIfSame(rows, run = powershell) {
  if (process.platform !== 'win32' || !rows.length) return;
  run(stopScript(rows));
}

module.exports = { ORPHAN_LEAD_MS, BIRTH_SLACK_MS, bornNow, parseRows, sameProcess, childrenOf, treeOf, ownTree, ownTreeOrThrow, cutAfter, stillOurs, readRec, killVerified, killOwnTree, processTable, lookupPids, stopScript, stopIfSame };
