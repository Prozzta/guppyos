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
 * - a pid recorded by a test is ours only while it still has the name and the birth it was
 *   recorded with (a birth taken in node, `Date.now() - process.uptime() * 1000`, is an estimate:
 *   it is matched within `slackMs`);
 * - just before a kill, the pid must still have the name and CreationDate it was found with.
 * Not on win32: no process table, so nothing can be verified and nothing is killed.
 */
const { execFileSync } = require('node:child_process');

/** How far a birth measured in node may be from the process's CreationDate. */
const BIRTH_SLACK_MS = 2_000;

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
 * PURE: what of a recorded process is ours. `rec` = { pid, bornMs, name? } (the pid and birth a test
 * wrote down). The row under that pid is ours when its name matches and it was created within
 * `slackMs` of the birth; then it and its tree are ours. When no row has that pid (it is gone), its
 * orphans still are: the processes that name it as parent and were created after its birth. When the
 * pid now belongs to ANOTHER process, nothing is ours: its tree is not the test's.
 */
function ownTree(rows, rec, slackMs = BIRTH_SLACK_MS) {
  const r = rows.find((x) => x.pid === rec.pid);
  if (r) {
    const ours = Math.abs(r.created - rec.bornMs) <= slackMs && (!rec.name || r.name.toLowerCase() === String(rec.name).toLowerCase());
    return ours ? { root: r, tree: [r, ...treeOf(rows, r)] } : { root: null, tree: [], stranger: r };
  }
  return { root: null, tree: treeOf(rows, { pid: rec.pid, created: rec.bornMs - slackMs }) };
}

/**
 * Kill each of `targets` (rows) that is STILL the same process. `lookup(pids)` returns their rows
 * now; `kill(rows)` kills those (the real one checks the name and CreationDate once more, in the
 * same PowerShell that stops them). Returns { killed, skipped } (rows).
 */
function killVerified(targets, { lookup = lookupPids, kill = stopIfSame } = {}) {
  if (!targets.length) return { killed: [], skipped: [] };
  const now = new Map(lookup(targets.map((t) => t.pid)).map((r) => [r.pid, r]));
  const same = targets.filter((t) => sameProcess(t, now.get(t.pid)));
  const skipped = targets.filter((t) => !same.includes(t));
  // Deepest first, the root last (targets come parent first): a killed root ends the run that then stops
  // the killer (the file watchdog), and a tree kill cut off there orphaned the ConPTY conhost.
  if (same.length) kill(same.slice().reverse());
  return { killed: same, skipped };
}

/** The recorded process's row while it still runs as ours; null when it is gone or its pid is another's. */
function stillOurs(rec, { table = processTable, slackMs = BIRTH_SLACK_MS } = {}) {
  return ownTree(table(), rec, slackMs).root;
}

/** "pid born" as a test wrote it (born: `Date.now()` right after a spawn, or bornNow() in the process). */
function readRec(file, name) {
  const [pid, bornMs] = require('node:fs').readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
  return { pid, bornMs, name };
}

/** Kill what of `rec` is ours (ownTree), verified. Returns { killed, skipped, stranger }. */
function killOwnTree(rec, { table = processTable, lookup = lookupPids, kill = stopIfSame, slackMs = BIRTH_SLACK_MS } = {}) {
  const t = ownTree(table(), rec, slackMs);
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

/** Stop each row's pid, but only if it still has that name and CreationDate (checked here, again). */
function stopIfSame(rows) {
  if (process.platform !== 'win32' || !rows.length) return;
  const json = JSON.stringify(rows.map((r) => ({ pid: r.pid, created: r.created, name: r.name }))).replace(/'/g, "''");
  // assigned first: PowerShell 5.1 passes ConvertFrom-Json's array down a pipeline as ONE object
  powershell(`$list = '${json}' | ConvertFrom-Json
foreach ($t in $list) {
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$($t.pid)"
  if ($q -and $q.Name -eq $t.name -and ([DateTimeOffset]$q.CreationDate).ToUnixTimeMilliseconds() -eq $t.created) { Stop-Process -Id $t.pid -Force -ErrorAction SilentlyContinue }
}`);
}

module.exports = { BIRTH_SLACK_MS, bornNow, parseRows, sameProcess, childrenOf, treeOf, ownTree, stillOurs, readRec, killVerified, killOwnTree, processTable, lookupPids, stopIfSame };
