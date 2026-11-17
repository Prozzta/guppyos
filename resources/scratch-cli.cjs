#!/usr/bin/env node
/* Managed _work lifecycle.  The broker, not this executable, establishes owner identity. */
'use strict';
const http = require('http');
const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3, timeout: 4 };
const USAGE = 'usage: scratch register <path> --card CARD-ID | scratch touch <path> | scratch detach --private <path> | scratch status | scratch reap\n';

function parseArgs(argv) {
  if (argv.length === 1 && /^(?:-h|--help)$/.test(argv[0])) return { help: true };
  if (argv.length === 1 && (argv[0] === 'status' || argv[0] === 'reap')) return { op: argv[0] };
  if (argv.length === 2 && argv[0] === 'touch' && argv[1]) return { op: 'touch', path: argv[1] };
  if (argv.length === 3 && argv[0] === 'detach' && argv[1] === '--private' && argv[2]) return { op: 'detach-private', path: argv[2] };
  if (argv.length === 4 && argv[0] === 'register' && argv[1] && argv[2] === '--card' && argv[3]) return { op: 'register', path: argv[1], card: argv[3] };
  throw new Error('expected a managed scratch command');
}
function post(urlText, data) {
  return new Promise((resolve) => {
    let url; try { url = new URL(urlText); } catch { resolve({ status: 0, error: 'bad-url' }); return; }
    const req = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 15000 }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => { let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode || 0, body }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.code || e) })); req.end(data);
  });
}
async function main(argv, env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let args; try { args = parseArgs(argv); } catch (e) { io.err(`scratch: ${e.message}\n${USAGE}`); return EXIT.usage; }
  if (args.help) { io.out(USAGE); return EXIT.ok; }
  const url = String(env.HIVE_LEDGER_URL || '').replace('/ledger/', '/scratch/');
  if (!/^http:\/\/127\.0\.0\.1:\d+\/scratch\//.test(url)) { io.err('scratch: unavailable (HIVE_LEDGER_URL is not set)\n'); return EXIT.unavailable; }
  const r = await post(url, Buffer.from(JSON.stringify(args)));
  if (r.error === 'timeout') { io.err('scratch: the app did not answer in time; retrying is safe\n'); return EXIT.timeout; }
  if (r.status === 0) { io.err(`scratch: app unavailable (${r.error})\n`); return EXIT.unavailable; }
  const line = r.body && typeof r.body.line === 'string' ? r.body.line : `HTTP ${r.status}`;
  if (r.status === 200 && r.body && r.body.ok) { io.out(`scratch: ${line}\n`); return EXIT.ok; }
  if (r.status === 403) { io.err('scratch: not authorized (stale spawn token)\n'); return EXIT.unavailable; }
  io.err(`scratch: ${line}\n`); return EXIT.refused;
}
if (require.main === module) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`scratch: ${e.stack || e}\n`); process.exitCode = EXIT.unavailable; });
module.exports = { EXIT, main, parseArgs };
