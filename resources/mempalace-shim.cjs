#!/usr/bin/env node
/*
 * NATIVE-MEMORY section 6: the `mempalace` command agents run. A small Node client OUTSIDE the
 * asar (the `kg.cjs` precedent). It never opens the index and never starts Python: it talks to
 * the app's memory engine over the loopback endpoint with the agent's own MEMORY_TOKEN.
 * MEMPALACE-REMOVAL (1.1.59): the memory engine is the only memory; there is no legacy CLI, no
 * mode file and no shadow path. The command keeps its name, so agents' habits keep working.
 * Exit codes: 0 ok, 2 bad arguments / unsupported command, 3 app unavailable,
 * 4 timeout / degraded, 5 unauthorized.
 *
 * Env (injected by the app at spawn): MUNDER_HIVE_ROOT, MUNDER_MEMORY_URL, MEMORY_TOKEN.
 */
'use strict';
const http = require('http');

const EXIT = { ok: 0, usage: 2, unavailable: 3, degraded: 4, unauthorized: 5 };
const REQUEST_TIMEOUT_MS = 10000;

/** Parse argv the way MemPalace 3.7.1 accepts it: a global --palace before the command. */
function parseArgs(argv) {
  const out = { palace: null, version: false, help: false, cmd: null, args: {}, format: 'text', rest: [] };
  const a = argv.slice();
  const take = (i, name) => {
    if (i + 1 >= a.length) throw new Error(`${name} needs a value`);
    return a[i + 1];
  };
  let i = 0;
  while (i < a.length && a[i].startsWith('-')) {
    if (a[i] === '--palace') { out.palace = take(i, '--palace'); i += 2; continue; }
    if (a[i].startsWith('--palace=')) { out.palace = a[i].slice(9); i += 1; continue; }
    if (a[i] === '--version') { out.version = true; i += 1; continue; }
    if (a[i] === '-h' || a[i] === '--help') { out.help = true; i += 1; continue; }
    throw new Error(`unknown option ${a[i]}`);
  }
  if (i >= a.length) return out;
  out.cmd = a[i++];
  const positional = [];
  let optionsDone = false;
  while (i < a.length) {
    const t = a[i];
    // argparse's rules, so the same argv means the same thing to both engines: `--` ends the
    // options, and a dash-led token that contains whitespace is positional text (an agent's
    // quoted query like "--format json --session-id <uuid>"), not an option.
    if (!optionsDone && t === '--') { optionsDone = true; i += 1; continue; }
    const eq = t.indexOf('=');
    const flag = !optionsDone && t.startsWith('--') && !/\s/.test(t) ? (eq > 0 ? t.slice(0, eq) : t) : null;
    const val = () => (eq > 0 ? t.slice(eq + 1) : take(i, flag));
    const step = () => (eq > 0 ? 1 : 2);
    if (flag === '--wing' || flag === '--room' || flag === '--since' || flag === '--before') { out.args[flag.slice(2)] = val(); i += step(); continue; }
    if (flag === '--results') { out.args.results = Number(val()); i += step(); continue; }
    if (flag === '--format') { out.format = val(); i += step(); continue; }
    if (flag === '--palace') { out.palace = val(); i += step(); continue; }
    if (flag) { out.rest.push(t); i += 1; continue; }
    positional.push(t);
    i += 1;
  }
  if (out.cmd === 'search') out.args.query = positional.join(' ');
  else out.rest.push(...positional);
  return out;
}

function post(env, body, timeoutMs) {
  return new Promise((resolve) => {
    const base = env.MUNDER_MEMORY_URL;
    const token = env.MEMORY_TOKEN;
    if (!base || !token) { resolve({ status: 0, error: 'no-endpoint' }); return; }
    let url;
    try { url = new URL(`${base.replace(/\/+$/, '')}/${token}`); } catch (_) { resolve({ status: 0, error: 'bad-endpoint' }); return; }
    if (url.hostname !== '127.0.0.1') { resolve({ status: 0, error: 'bad-endpoint' }); return; }
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code === 'ECONNREFUSED' ? 'refused' : String(e.message) }));
    req.end(data);
  });
}

async function native(env, p, io) {
  // --palace is accepted and ignored (one index per hive): an old habit keeps working.
  const r = await post(env, { cmd: p.cmd, args: p.args }, REQUEST_TIMEOUT_MS);
  if (r.status === 403) { io.err('mempalace: unauthorized (this terminal has no valid MEMORY_TOKEN; restart the agent from Munder Difflin)\n'); return EXIT.unauthorized; }
  if (r.status === 0) {
    if (r.error === 'timeout') { io.err('mempalace: the memory engine did not answer in time; try again\n'); return EXIT.degraded; }
    io.err('mempalace: Munder Difflin is not running (or its memory endpoint is down); start the app, then restart this agent from it\n');
    return EXIT.unavailable;
  }
  const j = r.json || {};
  if (p.format === 'json' && j.json !== undefined) io.out(JSON.stringify(j.json) + '\n');
  else if (typeof j.text === 'string') io.out(j.text);
  if (j.error) io.err(`mempalace: ${j.error}\n`);
  return typeof j.exit === 'number' ? j.exit : EXIT.degraded;
}

const STDIO = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

async function main(argv, env, io = STDIO) {
  let p;
  try { p = parseArgs(argv); } catch (e) {
    io.err(`mempalace: ${e.message}\n`);
    return EXIT.usage;
  }
  if (p.version) { io.out('MemPalace 3.7.1-compatible (Munder Difflin memory engine)\n'); return EXIT.ok; }
  if (p.help || !p.cmd) { io.out('usage: mempalace [--palace HIVE] {search QUERY [--wing W] [--room R] [--results N] [--since ISO] [--before ISO] | wake-up [--wing W] | status}\n'); return p.cmd ? EXIT.ok : EXIT.usage; }
  if (p.cmd === 'search' || p.cmd === 'wake-up' || p.cmd === 'status') {
    if (p.rest.length) { io.err(`mempalace: unsupported arguments: ${p.rest.join(' ')}\n`); return EXIT.usage; }
    return native(env, p, io);
  }
  io.err(`mempalace ${p.cmd}: not needed: the memory engine indexes memory.md and your durable notes automatically; use search, wake-up or status.\n`);
  return EXIT.usage;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`mempalace: ${e && e.stack ? e.stack : e}\n`); process.exitCode = EXIT.degraded; });
}
module.exports = { parseArgs, main, EXIT };
