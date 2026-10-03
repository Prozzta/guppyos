#!/usr/bin/env node
/*
 * READS-181 A: the `ledger` command agents run. One call updates a task card, writes one outbox
 * message and appends to the caller's memory.md, applied by the app (not by this script).
 *
 * The input is ONE JSON object, read from a file (--file <path>) or stdin, NEVER from shell
 * arguments: a message body inside a shell string gets its backticks and $(...) executed
 * (MSG-COMPOSE-SHELL-INJECTION). Any other argument is refused.
 *
 *   ledger --file op.json
 *   ledger <<'EOF'            (bash: the quoted 'EOF' turns off every expansion)
 *   { "op": "...", ... }
 *   EOF
 *   @' { "op": "...", ... } '@ | ledger      (PowerShell: a single-quoted here-string)
 *
 * Exit codes: 0 ok, 1 refused (the reason is printed), 2 bad arguments, 3 app unavailable,
 * 4 timeout. Env (set by the app at spawn): HIVE_LEDGER_URL.
 */
'use strict';
const fs = require('fs');
const http = require('http');

const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3, timeout: 4 };
const REQUEST_TIMEOUT_MS = 15000;
const INPUT_MAX = 256 * 1024;
const USAGE = 'usage: ledger [--file <op.json> | -]   (with no file, the JSON op is read from stdin)\n'
  + '  op: { "op": "<unique name>", "card": {...}, "message": {...}, "memory": {...} } (see PROTOCOL.md "The ledger command")\n';

/** { file } | { stdin: true } | { help: true }, or throws on anything else. */
function parseArgs(argv) {
  if (argv.length === 0) return { stdin: true };
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) return { help: true };
  if (argv.length === 1 && argv[0] === '-') return { stdin: true };
  if (argv.length === 2 && argv[0] === '--file' && argv[1]) return { file: argv[1] };
  if (argv.length === 1 && argv[0].startsWith('--file=') && argv[0].length > 7) return { file: argv[0].slice(7) };
  throw new Error('only --file <path> or stdin is accepted (put the JSON in a file or pipe it; never in arguments)');
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stdin.on('data', (d) => { size += d.length; if (size <= INPUT_MAX) chunks.push(d); });
    stdin.on('end', () => resolve(Buffer.concat(chunks)));
    stdin.on('error', reject);
  });
}

function post(urlText, data, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlText); } catch { resolve({ status: 0, error: 'bad-url' }); return; }
    const req = http.request({
      host: '127.0.0.1', port: url.port, path: url.pathname, method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length }, timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.code || e) }));
    req.end(data);
  });
}

async function main(argv, env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), stdin: process.stdin }) {
  let a;
  try { a = parseArgs(argv); } catch (e) { io.err(`ledger: ${e.message}\n${USAGE}`); return EXIT.usage; }
  if (a.help) { io.out(USAGE); return EXIT.ok; }
  let data;
  try {
    data = a.file ? fs.readFileSync(a.file) : await readStdin(io.stdin);
  } catch (e) { io.err(`ledger: cannot read ${a.file || 'stdin'}: ${e.message}\n`); return EXIT.usage; }
  if (!data.length) { io.err(`ledger: no input\n${USAGE}`); return EXIT.usage; }
  if (data.length > INPUT_MAX) { io.err(`ledger: the input is over ${INPUT_MAX} bytes\n`); return EXIT.usage; }
  const url = env.HIVE_LEDGER_URL;
  if (!url) {
    io.err('ledger: unavailable (HIVE_LEDGER_URL is not set: the app\'s hook broker was down at spawn, or this agent is not a Claude agent). Write the card, outbox file and memory note by hand.\n');
    return EXIT.unavailable;
  }
  const r = await post(url, data, REQUEST_TIMEOUT_MS);
  if (r.error === 'timeout') { io.err('ledger: the app did not answer in time; run the same op again (it is idempotent)\n'); return EXIT.timeout; }
  if (r.status === 0) { io.err(`ledger: the app is unavailable (${r.error}); run the same op again later\n`); return EXIT.unavailable; }
  const line = r.body && typeof r.body.line === 'string' ? r.body.line : `HTTP ${r.status}`;
  if (r.status === 200 && r.body && r.body.ok) { io.out(`${line}\n`); return EXIT.ok; }
  // 403: a stale token (this agent was respawned); 404 without a ledger reply: no ledger route.
  // A 404 the ledger itself answered ("no card X") is a refusal like any other.
  if (r.status === 403) { io.err('ledger: not authorized (a stale HIVE_LEDGER_URL: this agent was respawned)\n'); return EXIT.unavailable; }
  if (r.status === 404 && (!r.body || /not available|not a registered agent/.test(line))) { io.err(`ledger: unavailable (${line})\n`); return EXIT.unavailable; }
  io.err(`ledger: ${line}\n`);
  return EXIT.refused;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`ledger: ${e && e.stack ? e.stack : e}\n`); process.exitCode = EXIT.unavailable; });
}

module.exports = { main, parseArgs, EXIT };
