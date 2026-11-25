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
 *   created no later than SPAWN_CLOCK_SKEW_MS after the recorded birth. The birth `bornMs` is any
 *   time taken while ours was known to be alive: `Date.now()` right after the spawn, or bornNow()
 *   inside the process. One-sided: a process created before bornMs that is alive now held that pid at
 *   bornMs, when ours did, which is impossible; so a LIVE row under the pid created after bornMs is a
 *   reuse (a stranger), and one created at or before it with another name means the record itself
 *   is wrong (`older`: callers that check a run fail loudly on it, it is a bug, not a stranger).
 *   The skew is there because bornMs and the CreationDate are read from two clocks, and they agree
 *   only to about a millisecond (see SPAWN_CLOCK_SKEW_MS); there is no slack on the other side;
 * - just before a kill, the pid must still have the name and CreationDate it was found with.
 * Not on win32: no process table, so nothing can be verified and nothing is killed.
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { psEnv } = require('./ps-env.cjs');

/**
 * ONLY for the orphans of a root that is gone: how far before `bornMs` a child of ours may have been
 * created (clock rounding; ours was created at most this long before bornMs). Never used for the root.
 */
const ORPHAN_LEAD_MS = 1_000;
/**
 * FLAKE-OWN-PROCS-STILLOURS-NULL-LIVE-CHILD-108: how far AFTER `bornMs` the CreationDate of a live root may
 * be and the root still be ours. Measured 2026-11-25 (200 children, 10 fresh node processes x 20, idle box):
 * `Date.now()` right after spawn() minus the CreationDate was min -1 ms, median 0, max 4; 4 of 200 were -1 ms
 * and 113 were 0. (An older note here said "always LATER, by 8-37 ms"; that no longer holds.) With no skew
 * the rule called such a live child of ours a stranger: stillOurs answered null, and a caller that kills
 * through this file then killed nothing, silently.
 * Why 50: above one default Windows timer tick (15.6 ms), in case either reading is only tick-fine, with
 * margin (about 3 ticks); the measured worst case is 1 ms.
 * The cost: another process with the SAME image name that takes the pid within this long after the recorded
 * birth reads as ours. For a record taken right after a spawn, our child would have to exit and its pid be
 * freed and reused inside the window. Never raise it without a new measurement (a test pins the bound).
 */
const SPAWN_CLOCK_SKEW_MS = 50;
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
 * - A live row under the pid created no later than bornMs + SPAWN_CLOCK_SKEW_MS, with the name: ours,
 *   with its tree.
 * - Created later than that: the pid was reused, a `stranger`; nothing is ours, not its tree either.
 * - Created at or before bornMs with ANOTHER name: impossible for a stranger, so the record is wrong:
 *   `stranger` and `older: true`. Callers that judge a run must fail on it (a bug, never "nothing left").
 * - ANOTHER name, created inside the skew after bornMs: a `stranger` with `older: false`. The two clocks
 *   cannot order it against the birth, so it is not called a wrong record; it is not ours either way.
 * - No row (ours is gone): its orphans still are, the rows that name it as parent, created no earlier
 *   than ORPHAN_LEAD_MS before bornMs and, when `goneBy` is known, no later than it (a later process
 *   that took the pid after ours died can only have had its children after that).
 */
function ownTree(rows, rec, leadMs = ORPHAN_LEAD_MS) {
  const r = rows.find((x) => x.pid === rec.pid);
  if (r) {
    if (r.created > rec.bornMs + SPAWN_CLOCK_SKEW_MS) return { root: null, tree: [], stranger: r, older: false };
    if (rec.name && r.name.toLowerCase() !== String(rec.name).toLowerCase()) return { root: null, tree: [], stranger: r, older: r.created <= rec.bornMs };
    return { root: r, tree: ruled([r, ...treeOf(rows, r)], 'own-tree') };
  }
  const tree = treeOf(rows, { pid: rec.pid, created: rec.bornMs - leadMs });
  return { root: null, tree: ruled(Number.isFinite(rec.goneBy) ? cutAfter(tree, rec.goneBy) : tree, 'orphan') };
}

/**
 * FLAKE-OWN-PROCS-POWERSHELL-EXIT-NEG1-EMPTY-108: which ownTree rule took a row ('own-tree': under a live root of
 * ours; 'orphan': the child of a root that is gone), kept beside the rows so no row changes shape. Only the stops
 * journal reads it; a row no ownTree call returned is 'direct' there (the caller passed it itself).
 */
const ruleOf = new WeakMap();
function ruled(tree, rule) {
  for (const r of tree) ruleOf.set(r, rule);
  return tree;
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
/** How many PowerShell processes this module has started (each costs seconds on a loaded box). */
let starts = 0;
const powershellStarts = () => starts;
function powershell(script) {
  return runPowershell(script);
}
/**
 * One PowerShell run. When it fails, the error says HOW (FLAKE-BARE-OWNER-CIM-LOOKUP-TIMEOUT-108): Node's own
 * message is only "Command failed: <command>" and TAP prints nothing else, so a timeout, a start-up death under
 * load (status 3221225794 = 0xC0000142, empty stderr) and a script error looked the same. Nothing else changes:
 * same command, same 60 s timeout, no retry. `exe` and `exec` are for tests. The line also names the child's pid and
 * the UTC wall time before and after the call, when the failed run had a child.
 */
function runPowershell(script, { exe = 'powershell.exe', exec = execFileSync } = {}) {
  starts += 1;
  const body = `$ProgressPreference = 'SilentlyContinue'
${script}`;
  const t0 = Date.now();
  try {
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')];
    const opts = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };
    // The real PowerShell spawn stays a literal call below, so the ps-modcache-leak census sees it and its psEnv.
    if (exe === 'powershell.exe' && exec === execFileSync) return execFileSync('powershell.exe', args, { ...opts, env: psEnv() });
    return exec(exe, args, { ...opts, env: psEnv() });
  } catch (e) {
    const err = e && typeof e === 'object' ? e : new Error(String(e));
    const text = (v) => (v === undefined || v === null ? '' : String(v));
    const t1 = Date.now();
    // FLAKE-OWN-PROCS-POWERSHELL-EXIT-NEG1-EMPTY-108: a run that had a child names it and the wall time around the
    // call, so the Windows PowerShell event log (engine start 400 / stop 403) can be matched to this one process.
    // (pid 0 is a spawn that itself failed: there was no child to name.)
    const child = Number.isInteger(err.pid) && err.pid > 0 ? ` [own-procs powershell child pid=${err.pid} started=${new Date(t0).toISOString()} ended=${new Date(t1).toISOString()}]` : '';
    const why = `[own-procs powershell #${starts} failed after ${t1 - t0} ms: status=${err.status ?? null} signal=${err.signal ?? null} code=${err.code ?? null} stderr=${JSON.stringify(text(err.stderr).slice(0, 400))} stdout=${JSON.stringify(text(err.stdout).slice(0, 200))}]${child}${child ? stopsNaming(err.pid) : ''}`;
    try { err.message = `${err.message} ${why}`; } catch { /* read-only message */ }
    err.powershellWhy = why;
    throw err;
  }
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
  if ($q -and $q.Name -eq $t.name -and ([DateTimeOffset]$q.CreationDate).ToUnixTimeMilliseconds() -eq $t.created) {
    try { Stop-Process -Id $t.pid -Force -ErrorAction Stop }
    catch {
      if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { continue }
      throw
    }
  }
}
exit 0`;
}

/** Stop each row's pid, but only if it still has that name and CreationDate (checked here, again). `run` is for tests. */
function stopIfSame(rows, run = powershell) {
  if (process.platform !== 'win32' || !rows.length) return;
  noteStops(rows);
  run(stopScript(rows));
}

/**
 * FLAKE-OWN-PROCS-POWERSHELL-EXIT-NEG1-EMPTY-108: the stops journal. Stop-Process -Force ends its target with exit
 * code 4294967295 and leaves nothing in the target's output, and a kill made that way was in no record (the
 * preload's <starts>.kills holds only process.kill and taskkill). So each row handed to a stop script is one line
 * in <starts>.stops: { t, pid, ppid, name, created, rule, file, by }. A row means HANDED to a stop script, not
 * stopped: the script checks the name and CreationDate again and may skip. The path is the one
 * file-backstop-preload.cjs keeps on `process` for a test file of a run; anywhere else this does nothing.
 * Append-only; a journal that cannot be written or read never changes a stop or an error.
 */
const BACKSTOP_KEY = Symbol.for('guppy.file-backstop');
function stopsJournal() {
  const b = process[BACKSTOP_KEY];
  return b && typeof b === 'object' && typeof b.stops === 'string' && b.stops ? { stops: b.stops, file: typeof b.file === 'string' ? b.file : '' } : null;
}
// A test that drives stopIfSame's real stop path with made-up pids writes rows for those pids too: one more
// reason a row reads as "handed to a stop script", never as "stopped".
function noteStops(rows) {
  try {
    const j = stopsJournal();
    if (!j) return;
    const t = Date.now();
    fs.appendFileSync(j.stops, rows.map((r) => `${JSON.stringify({ t, pid: r.pid, ppid: r.ppid ?? null, name: r.name, created: r.created, rule: ruleOf.get(r) || 'direct', file: j.file, by: process.pid })}\n`).join(''));
  } catch { /* the stop itself still runs */ }
}
/** For a failed run's line: the journal rows that carry the child's pid, or that none of N does ('' outside a run). */
function stopsNaming(pid) {
  try {
    const j = stopsJournal();
    if (!j) return '';
    let rows = [];
    try {
      rows = fs.readFileSync(j.stops, 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === 'object');
    } catch { /* no journal yet: no stop was handed over */ }
    const hit = rows.filter((r) => r.pid === pid);
    if (!hit.length) return ` [own-procs stops: none of ${rows.length} rows names pid ${pid}; a row means handed to a stop script, not stopped]`;
    const at = (t) => { try { return new Date(t).toISOString(); } catch { return String(t); } };
    return ` [own-procs stops: pid ${pid} was handed to a stop script (handed, not proven stopped): ${hit.slice(0, 5).map((r) => `${r.name} created=${r.created} ppid=${r.ppid} rule=${r.rule} by ${r.file} (pid ${r.by}) at ${at(r.t)}`).join('; ')}${hit.length > 5 ? `; and ${hit.length - 5} more` : ''}]`;
  } catch { return ''; }
}
/**
 * FS-REMOVE-GAP-RACE-FAILED-PID-JOURNAL-108: the same for the preload's <starts>.kills (beside <starts>.stops):
 * the process.kill / taskkill rows made by a run's test file that name `pid` at or after `sinceMs` (the child's
 * spawn; an earlier row named an older owner of the number). '' outside a run.
 */
function killsNaming(pid, sinceMs = -Infinity) {
  try {
    const j = stopsJournal();
    if (!j || !/\.stops$/.test(j.stops)) return '';
    let rows = [];
    try {
      rows = fs.readFileSync(j.stops.replace(/\.stops$/, '.kills'), 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => r && typeof r === 'object' && Array.isArray(r.targets) && Number.isFinite(r.t));
    } catch { /* no kills file yet: no kill by number was recorded */ }
    const hit = rows.filter((r) => r.targets.includes(pid) && r.t >= sinceMs);
    const at = (t) => { try { return new Date(t).toISOString(); } catch { return String(t); } };
    if (!hit.length) return ` [kills: none of ${rows.length} rows names pid ${pid} since its spawn; only a run file's own process.kill/taskkill is recorded]`;
    return ` [kills: ${hit.slice(0, 5).map((r) => `pid ${pid} was named by a kill (${r.via || 'kill'}) from ${r.file || 'an unnamed file'} (pid ${r.pid}) at ${at(r.t)}`).join('; ')}${hit.length > 5 ? `; and ${hit.length - 5} more` : ''}]`;
  } catch { return ''; }
}

module.exports = { runPowershell, ORPHAN_LEAD_MS, SPAWN_CLOCK_SKEW_MS, BIRTH_SLACK_MS, bornNow, parseRows, sameProcess, childrenOf, treeOf, ownTree, ownTreeOrThrow, cutAfter, stillOurs, readRec, killVerified, killOwnTree, processTable, lookupPids, stopScript, stopIfSame, powershellStarts, stopsNaming, killsNaming };
