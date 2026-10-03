#!/usr/bin/env node
'use strict';
/**
 * READS-MEASURE (1.1.81): how much context each hive agent RE-READS, per day, from the Claude Code
 * transcripts. Read-only: it opens every transcript for reading and writes nothing.
 *
 * Every model request re-reads the whole conversation so far (mostly as cache reads, which still
 * count against the usage budget). So the cost of a turn is roughly its context size, and anything
 * large pulled into context (a tool output, a file read) is paid again on every later request.
 *
 * Source: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/<session>.jsonl, plus
 * <session>/subagents/*.jsonl (counted under the parent agent, as "sub").
 * Agent: the hive hook URL in the transcript (/hook/<agent-id>/), else the identity line
 * 'You are "<Name>" (<agent-id>)'; sessions with neither are not hive agents and are skipped
 * (--all keeps them as "(other)").
 * Request: Claude Code writes one row per content block, all with the same requestId and usage, so
 * rows are folded by requestId (else message.id). Day = the UTC date of the request.
 *
 * Tool outputs: each tool result is re-read by every later request of its transcript until the
 * context is reset (a compaction or a resume: the context drops below half the previous request's).
 * Its re-read cost is estimated as chars/4 tokens times those requests, and --caps simulates a
 * per-result cap (chars kept) to estimate what a cap would have saved. Images count as 0 chars.
 *
 * Compactions: each compact_boundary row (Claude Code's own record: trigger, preTokens) is counted,
 * with an ESTIMATED cost of its summary call, which no transcript records: the context before it
 * read once from the cache (preTokens x 0.1) plus the summary's output (the "This session is being
 * continued" message that follows, chars/4). Jim's suggestion, READS-181 pilot.
 *
 * Usage: node reads-measure.cjs [--day YYYY-MM-DD] [--since YYYY-MM-DD] [--agent <id>] [--top N]
 *                               [--tz <hours from UTC for the day boundary>] [--caps 1500,2000,30000]
 *                               [--dir <projects dir>] [--json] [--all]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function parseArgs(argv) {
  const o = { top: 5, json: false, all: false, tz: 0, caps: [1500, 2000, 30000] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[i + 1]; i += 1; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--day') o.day = next();
    else if (a === '--since') o.since = next();
    else if (a === '--agent') o.agent = next();
    else if (a === '--top') o.top = Math.max(0, Number(next()) || 0);
    else if (a === '--dir') o.dir = next();
    else if (a === '--tz') o.tz = Number(next()) || 0;
    else if (a === '--caps') o.caps = next().split(',').map(Number).filter((n) => n > 0);
    else if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function projectsDir(env = process.env) {
  const cfg = (env.CLAUDE_CONFIG_DIR || '').trim();
  return path.join(cfg || path.join(os.homedir(), '.claude'), 'projects');
}

/** Every transcript: { file, sub } (sub = a subagent transcript of a session). */
function listTranscripts(dir) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(dir, p.name);
    let entries = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(pdir, e.name), sub: false, session: e.name.slice(0, -6) });
      else if (e.isDirectory()) {
        const sdir = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sdir); } catch { continue; }
        for (const s of subs) if (s.endsWith('.jsonl')) out.push({ file: path.join(sdir, s), sub: true, session: e.name });
      }
    }
  }
  return out;
}

const HOOK_RE = /\/hook\/([A-Za-z0-9_-]+)\//;
const IDENT_RE = /You are \\?"[^"\\]{1,40}\\?" \(([a-z0-9][a-z0-9-]{1,40})\)/;

/** The agent a transcript belongs to, from its first identity marker, or null. */
function agentOf(line) {
  const h = HOOK_RE.exec(line);
  if (h) return h[1];
  const m = IDENT_RE.exec(line);
  return m ? m[1] : null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A tool_result's size in characters (text blocks and strings; an image counts as 0 here). */
function resultChars(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((n, b) => n + (b && typeof b.text === 'string' ? b.text.length : 0), 0);
  return 0;
}

/**
 * Read one transcript. Returns { agent, requests: [{ day, at, read, write, input, output, ctx, cause }] }.
 * `cause` = the tool results that arrived just before this request (what it was the first to read):
 * [{ tool, chars }]. The tool name comes from the matching tool_use earlier in the same transcript.
 */
async function readTranscript(file, { sizeHint } = {}) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let agent = null;
  const toolName = new Map(); // tool_use id -> name
  let pending = []; // tool results since the last request
  const byReq = new Map();
  const results = []; // every tool result; `at` = the index of the first request that reads it
  const compactions = []; // { at, preTokens, trigger, summaryChars }
  for await (const line of rl) {
    if (!line) continue;
    if (agent === null && (line.includes('/hook/') || line.includes('You are'))) agent = agentOf(line);
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.type === 'system' && row.subtype === 'compact_boundary' && row.isSidechain !== true) {
      const meta = row.compactMetadata && typeof row.compactMetadata === 'object' ? row.compactMetadata : {};
      compactions.push({ at: typeof row.timestamp === 'string' ? row.timestamp : '', preTokens: num(meta.preTokens), trigger: typeof meta.trigger === 'string' ? meta.trigger : null, summaryChars: 0 });
      continue;
    }
    const msg = row && row.message;
    if (!msg || typeof msg !== 'object') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (row.type === 'user') {
      const last = compactions[compactions.length - 1];
      if (last && !last.summaryChars) {
        const text = typeof msg.content === 'string' ? msg.content : content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
        if (text.startsWith('This session is being continued')) last.summaryChars = text.length;
      }
      for (const b of content) {
        if (b && b.type === 'tool_result') {
          const r = { tool: toolName.get(b.tool_use_id) || '?', chars: resultChars(b), at: byReq.size };
          pending.push(r); results.push(r);
        }
      }
      continue;
    }
    if (row.type !== 'assistant' || !msg.usage) continue;
    for (const b of content) if (b && b.type === 'tool_use' && b.id) toolName.set(b.id, b.name || '?');
    const key = row.requestId || msg.id || `${file}:${byReq.size}`;
    const u = msg.usage;
    const prev = byReq.get(key);
    if (prev) { prev.output = Math.max(prev.output, num(u.output_tokens)); continue; }
    const at = typeof row.timestamp === 'string' ? row.timestamp : '';
    const read = num(u.cache_read_input_tokens);
    const write = num(u.cache_creation_input_tokens);
    const input = num(u.input_tokens);
    byReq.set(key, { day: at.slice(0, 10), at, read, write, input, output: num(u.output_tokens), ctx: read + write + input, cause: pending });
    pending = [];
  }
  void sizeHint;
  const requests = [...byReq.values()];
  // where each context lifetime ends (exclusive): a request below half the previous one = a reset
  const end = new Array(requests.length).fill(requests.length);
  for (let i = requests.length - 1, e = requests.length; i >= 0; i -= 1) {
    end[i] = e;
    if (i > 0 && requests[i].ctx < requests[i - 1].ctx / 2) e = i;
  }
  for (const r of results) r.reads = r.at < requests.length ? end[r.at] - r.at : 0;
  return { agent, requests, results, compactions };
}

const shiftDay = (at, tz) => (tz && at ? new Date(Date.parse(at) + tz * 3_600_000).toISOString().slice(0, 10) : at.slice(0, 10));

function inRange(day, o) {
  if (!day) return false;
  if (o.day && day !== o.day) return false;
  if (o.since && day < o.since) return false;
  return true;
}

/** Fold requests into per (agent, day) rows. */
function aggregate(transcripts, o) {
  const rows = new Map();
  for (const t of transcripts) {
    const agent = t.agent || (o.all ? '(other)' : null);
    if (!agent) continue;
    if (o.agent && agent !== o.agent) continue;
    for (const r of t.requests) {
      const day = shiftDay(r.at, o.tz);
      if (!inRange(day, o)) continue;
      const k = `${agent}\t${day}`;
      let a = rows.get(k);
      if (!a) { a = { compactions: 0, compactCallBE: 0, agent, day, requests: 0, subRequests: 0, sessions: new Set(), read: 0, write: 0, input: 0, output: 0, maxCtx: 0, turns: [], tools: {} }; rows.set(k, a); }
      a.requests += 1;
      if (t.sub) a.subRequests += 1;
      a.sessions.add(t.session);
      a.read += r.read; a.write += r.write; a.input += r.input; a.output += r.output;
      a.maxCtx = Math.max(a.maxCtx, r.ctx);
      a.turns.push({ at: r.at, session: t.session, sub: t.sub, ctx: r.ctx, write: r.write, cause: r.cause });
    }
    for (const c of t.compactions || []) {
      if (!c.at) continue;
      const a = rows.get(`${agent}\t${shiftDay(c.at, o.tz)}`);
      if (!a) continue;
      a.compactions += 1;
      a.compactCallBE += Math.round(0.1 * c.preTokens + c.summaryChars / 4);
    }
    for (const x of t.results || []) {
      const req = t.requests[x.at];
      if (!req) continue;
      const a = rows.get(`${agent}\t${shiftDay(req.at, o.tz)}`);
      if (!a) continue;
      const k = /^mcp__/.test(x.tool) ? 'mcp' : x.tool;
      const tt = a.tools[k] || (a.tools[k] = { results: 0, chars: 0, maxChars: 0, reread: 0, saved: {} });
      tt.results += 1; tt.chars += x.chars; tt.maxChars = Math.max(tt.maxChars, x.chars);
      tt.reread += Math.round(x.chars / 4) * x.reads;
      for (const c of o.caps) tt.saved[c] = (tt.saved[c] || 0) + Math.round(Math.max(0, x.chars - c) / 4) * x.reads;
    }
  }
  const out = [...rows.values()].map((a) => {
    const top = o.top > 0 ? [...a.turns].sort((x, y) => y.write - x.write).slice(0, o.top).map((t) => ({
      at: t.at, session: t.session.slice(0, 8), sub: t.sub, added: t.write, ctx: t.ctx,
      cause: t.cause.map((c) => `${c.tool}:${c.chars}`).join(' ') || '(text/none)'
    })) : [];
    return {
      agent: a.agent, day: a.day, requests: a.requests, subRequests: a.subRequests, sessions: a.sessions.size,
      cacheRead: a.read, cacheWrite: a.write, input: a.input, output: a.output,
      avgReadPerRequest: a.requests ? Math.round(a.read / a.requests) : 0,
      maxContext: a.maxCtx, largestAdds: top, tools: a.tools, compactions: a.compactions, compactCallBE: a.compactCallBE
    };
  });
  out.sort((x, y) => (x.day === y.day ? y.cacheRead - x.cacheRead : x.day < y.day ? -1 : 1));
  return out;
}

const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function render(rows, caps = []) {
  const lines = ['| day (UTC) | agent | requests (sub) | cache reads | avg read/request | max context | cache writes | output | compactions (est. summary-call BE) |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.day} | ${r.agent} | ${r.requests} (${r.subRequests}) | ${M(r.cacheRead)} | ${M(r.avgReadPerRequest)} | ${M(r.maxContext)} | ${M(r.cacheWrite)} | ${M(r.output)} | ${r.compactions} (${M(r.compactCallBE)}) |`);
  }
  lines.push('', 'Tool outputs (est. tokens = chars/4; re-read = tokens x later requests until a reset; "saved at N" = what a per-result cap of N chars would have saved; tools under 50k re-read omitted):', '',
    `| day | agent | tool | results | chars | largest | est. re-read | ${caps.map((c) => `saved at ${c}`).join(' | ')} |`,
    `|---|---|---|---|---|---|---|${caps.map(() => '---|').join('')}`);
  for (const r of rows) {
    for (const [name, t] of Object.entries(r.tools).sort((x, y) => y[1].reread - x[1].reread)) {
      if (t.reread < 50_000) continue;
      lines.push(`| ${r.day} | ${r.agent} | ${name} | ${t.results} | ${M(t.chars)} | ${M(t.maxChars)} | ${M(t.reread)} | ${caps.map((c) => M(t.saved[c] || 0)).join(' | ')} |`);
    }
  }
  const withTop = rows.filter((r) => r.largestAdds.length);
  if (withTop.length) {
    lines.push('', 'Largest turns (the requests that ADDED the most to the context, and the tool results just before them):');
    for (const r of withTop) {
      lines.push(`- ${r.day} ${r.agent}:`);
      for (const t of r.largestAdds) lines.push(`  - ${t.at.slice(11, 19)}Z ${t.session}${t.sub ? ' (sub)' : ''} +${M(t.added)} -> ctx ${M(t.ctx)}; ${t.cause}`);
    }
  }
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const dir = o.dir || projectsDir();
  const files = listTranscripts(dir);
  const sinceMs = o.since ? Date.parse(`${o.since}T00:00:00Z`) : o.day ? Date.parse(`${o.day}T00:00:00Z`) : 0;
  const transcripts = [];
  for (const f of files) {
    // a transcript not written to since the window opened cannot hold a request in it
    try { if (sinceMs && fs.statSync(f.file).mtimeMs < sinceMs) continue; } catch { continue; }
    const t = await readTranscript(f.file);
    transcripts.push({ ...t, sub: f.sub, session: f.session });
  }
  // a subagent transcript has no hook line of its own: it belongs to its parent session's agent
  const bySession = new Map(transcripts.filter((t) => !t.sub && t.agent).map((t) => [t.session, t.agent]));
  for (const t of transcripts) if (t.sub && !t.agent) t.agent = bySession.get(t.session) || null;
  const rows = aggregate(transcripts, o);
  process.stdout.write(o.json ? `${JSON.stringify(rows, null, 2)}\n` : `${render(rows, o.caps)}\n`);
}

if (require.main === module) main().catch((e) => { process.stderr.write(`reads-measure: ${e.message}\n`); process.exit(2); });

module.exports = { parseArgs, projectsDir, listTranscripts, agentOf, readTranscript, aggregate, render };
