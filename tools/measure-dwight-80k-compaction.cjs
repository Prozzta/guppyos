'use strict';
// Stage 1b companion to Andy's owncon/fleet.cjs. Refuses a one-day, mixed-build, or non-shipped
// comparison: lower input/request is not a win if compaction makes a turn use more total tokens.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const values = (name) => args.flatMap((arg, i) => arg === name && args[i + 1] ? [args[i + 1]] : []);
const before = values('--before'); const after = values('--after');
const fleet = values('--fleet')[0] || process.env.FLEET_SCRIPT || 'C:/Dunder/_work/andy-scratch/owncon/fleet.cjs';
const hiveRoot = values('--hive-root')[0] || 'C:/Dunder/hive';
const agent = 'dwight-mu32ztys'; const DATE = /^\d{4}-\d{2}-\d{2}$/;
const unique = (items) => [...new Set(items)]; const fail = (message) => { throw new Error(message); };
if (before.length < 3 || after.length < 3) fail('require at least three --before days and three --after days');
if (![...before, ...after].every((day) => DATE.test(day))) fail('days must use YYYY-MM-DD (local UTC+2 fleet dates)');
if (unique(before).length !== before.length || unique(after).length !== after.length) fail('each comparison side must name distinct days');
if (!fs.existsSync(fleet)) fail(`fleet reader not found: ${fleet}`);
const run = spawnSync(process.execPath, [fleet], { encoding: 'utf8' });
if (run.status !== 0) fail(`fleet reader failed (${run.status}): ${run.stderr.slice(-800)}`);
const rows = run.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const source = rows.find((row) => row && row.files);
const rowFor = (day) => {
  const row = rows.find((candidate) => candidate.agent === agent && candidate.day === day && candidate.period === 'shipped');
  if (!row) fail(`no shipped fleet row for ${agent} on ${day}; do not substitute a pre-shipment or empty day`);
  return row;
};
const dayStart = (day) => Date.parse(`${day}T00:00:00+02:00`);
const dayEnd = (day) => dayStart(day) + 24 * 60 * 60 * 1000;
const starts = (() => {
  if (!fs.existsSync(hiveRoot)) fail(`hive root not found: ${hiveRoot}`);
  const events = [];
  for (const file of fs.readdirSync(hiveRoot).filter((name) => /^log(?:\..+)?\.jsonl$/.test(name))) {
    for (const line of fs.readFileSync(path.join(hiveRoot, file), 'utf8').split(/\r?\n/)) {
      try { const event = JSON.parse(line); if (event.kind === 'app-start' && Number.isFinite(event.ts) && typeof event.version === 'string') events.push(event); } catch { /* partial final line */ }
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
})();
const buildForDay = (day) => {
  const start = dayStart(day); const end = dayEnd(day); const prior = starts.filter((event) => event.ts < start).at(-1);
  if (!prior) fail(`no app-start before ${day}; cannot prove its app build`);
  if (starts.some((event) => event.ts >= start && event.ts < end)) fail(`${day} contains an app restart; choose a full clean shipped day instead`);
  return prior.version;
};
const summary = (day) => {
  const row = rowFor(day);
  // inp is complete CLI input (cached included); it plus output/reasoning covers compaction requests too.
  const totalTokens = row.inp + row.out + row.reas;
  return { day, requests: row.req, turnsStarted: row.turnsStarted, inputPerRequest: row.real,
    compactions: row.compactions, compactionsPerTurn: +(row.compactions / Math.max(1, row.turnsStarted)).toFixed(4),
    totalTokens, totalTokensPerStartedTurn: Math.round(totalTokens / Math.max(1, row.turnsStarted)),
    models: Object.keys(row.models || {}), appBuild: buildForDay(day) };
};
const exactMedian = (numbers) => { const sorted = [...numbers].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2); };
const side = (days) => {
  const daily = days.map(summary); const models = unique(daily.flatMap((item) => item.models)); const builds = unique(daily.map((item) => item.appBuild));
  if (models.length !== 1) fail(`mixed or unknown models in ${days.join(', ')}: ${models.join(', ') || 'none'}`);
  if (builds.length !== 1) fail(`mixed app builds in ${days.join(', ')}: ${builds.join(', ')}`);
  const totalTokens = daily.reduce((sum, item) => sum + item.totalTokens, 0); const turnsStarted = daily.reduce((sum, item) => sum + item.turnsStarted, 0); const compactions = daily.reduce((sum, item) => sum + item.compactions, 0);
  return { days: daily, model: models[0], appBuild: builds[0], totals: {
    requests: daily.reduce((sum, item) => sum + item.requests, 0), turnsStarted, totalTokens,
    totalTokensPerStartedTurn: Math.round(totalTokens / Math.max(1, turnsStarted)), compactions,
    compactionsPerStartedTurn: +(compactions / Math.max(1, turnsStarted)).toFixed(4),
    // fleet.cjs exposes exact percentiles per day, not raw samples. Never claim this is pooled.
    medianOfDailyRequestMedians: exactMedian(daily.map((item) => item.inputPerRequest.med)),
    maxDailyRequestP90: Math.max(...daily.map((item) => item.inputPerRequest.p90))
  } };
};
const readQuality = (flag) => {
  const file = values(flag)[0]; if (!file) return null; const q = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  for (const key of ['reviewed', 'accepted', 'reworked', 'failed']) if (!Number.isInteger(q[key]) || q[key] < 0) fail(`${flag} ${key} must be a non-negative integer`);
  if (q.accepted + q.reworked + q.failed > q.reviewed) fail(`${flag} outcomes exceed reviewed tasks`);
  return { ...q, rates: q.reviewed ? { accepted: +(q.accepted / q.reviewed).toFixed(4), reworked: +(q.reworked / q.reviewed).toFixed(4), failed: +(q.failed / q.reviewed).toFixed(4) } : null };
};
const beforeSummary = side(before); const afterSummary = side(after);
if (beforeSummary.model !== afterSummary.model) fail(`model differs: before ${beforeSummary.model}, after ${afterSummary.model}`);
if (beforeSummary.appBuild !== afterSummary.appBuild) fail(`app build differs: before ${beforeSummary.appBuild}, after ${afterSummary.appBuild}`);
const cliVersions = unique((source?.files || []).filter((file) => file.agent === agent && file.threadStartUTC && [...before, ...after].includes(new Date(Date.parse(file.threadStartUTC) + 2 * 3600e3).toISOString().slice(0, 10))).map((file) => file.cli).filter(Boolean));
if (cliVersions.length !== 1) fail(`could not establish one Codex cli_version from comparison-day session starts: ${cliVersions.join(', ') || 'none'}`);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), source: { fleet, hiveRoot, agent, period: 'shipped', cliVersion: cliVersions[0] }, before: { ...beforeSummary, quality: readQuality('--quality-before') }, after: { ...afterSummary, quality: readQuality('--quality-after') }, notes: ['Both sides contain at least three full local days.', 'All values include actual observed compaction requests; compactions are not simulated.', 'Use comparable task mix for optional manual quality samples.'] }, null, 2));
