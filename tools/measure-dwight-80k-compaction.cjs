'use strict';
// Stage 1b companion to Andy's owncon/fleet.cjs; shares its token/compaction definitions.
// Usage: node tools/measure-dwight-80k-compaction.cjs --before 2026-09-28 --after 2026-09-30
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const before = value('--before'); const after = value('--after');
const fleet = value('--fleet') || process.env.FLEET_SCRIPT || 'C:/Dunder/_work/andy-scratch/owncon/fleet.cjs';
if (!/^\d{4}-\d{2}-\d{2}$/.test(before || '') || !/^\d{4}-\d{2}-\d{2}$/.test(after || '')) throw new Error('require --before YYYY-MM-DD and --after YYYY-MM-DD (local UTC+2 fleet dates)');
if (!fs.existsSync(fleet)) throw new Error(`fleet reader not found: ${fleet}`);
const run = spawnSync(process.execPath, [fleet], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(`fleet reader failed (${run.status}): ${run.stderr.slice(-800)}`);
const rows = run.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const rowFor = (day) => rows.find((r) => r.agent === 'dwight-mu32ztys' && r.day === day && r.period === 'shipped');
const summarize = (row) => row && { requests: row.req, turns: row.turnsStarted, inputPerRequest: row.real, compactions: row.compactions, compactionsPerTurn: +(row.compactions / Math.max(1, row.turnsStarted)).toFixed(4), requestPerTurn: row.reqPerTurn };
const readQuality = (flag) => { const file = value(flag); return file ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) : null; };
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), source: { fleet, agent: 'dwight-mu32ztys', period: 'shipped' }, before: { day: before, metrics: summarize(rowFor(before)), quality: readQuality('--quality-before') }, after: { day: after, metrics: summarize(rowFor(after)), quality: readQuality('--quality-after') }, qualitySchema: { reviewed: 'number of completed tasks manually reviewed', accepted: 'tasks accepted without corrective follow-up', reworked: 'tasks requiring a substantive corrective follow-up', failed: 'tasks ending blocked/failed for a quality reason', notes: 'short array of task IDs and outcomes; no prompt content' } }, null, 2));
