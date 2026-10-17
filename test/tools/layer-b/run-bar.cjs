'use strict';

/** The run-bar policy is pure: it can be checked without a hive, app, or CLI. */
const DRY_RUN_WALL_MS = 900_000;

function runBarProblems({ rows, plumbing, durationMs, dryRun, launched }) {
  const exhausted = rows.filter((r) => r && r.kind === 'wake' && r.stage === 'wake-ids-exhausted');
  const stalls = rows.filter((r) => r && r.kind === 'wake' && r.stage === 'stall');
  const checks = [
    { ok: exhausted.length === 0, label: 'run bar: no wake-ids-exhausted row (no F4 backoff)', detail: exhausted.map((r) => `${r.agentId} ${JSON.stringify(r.idList)} attempt ${r.attempt} retry ${r.retryInMs} ms`).join('; ') || 'none' },
    { ok: stalls.length === 0, label: 'run bar: no wake stall row', detail: stalls.map((r) => `${r.agentId} ${r.why} ${r.inboxIds} id(s) ${r.stalledMs} ms`).join('; ') || 'none' }
  ];
  if (dryRun && launched) {
    const missing = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].filter((id) => plumbing[id] !== true);
    checks.push({ ok: missing.length === 0, label: 'run bar (dry run): B1-B6 plumbing complete (every reply; acted for B1, B5 and all 4 B6 turns)', detail: missing.length ? `incomplete: ${missing.map((id) => `${id}=${plumbing[id] === undefined ? 'not reached' : plumbing[id]}`).join(', ')}` : 'all complete' });
    checks.push({ ok: durationMs !== null && durationMs <= DRY_RUN_WALL_MS, label: `run bar (dry run): the agent phases within ${DRY_RUN_WALL_MS / 1000} s`, detail: `${durationMs === null ? 'unknown' : Math.round(durationMs / 1000)} s` });
  }
  return { exhausted, stalls, checks };
}

module.exports = { DRY_RUN_WALL_MS, runBarProblems };
