#!/usr/bin/env node
/*
 * GOD-TERMINAL-CONTROL M1: the `term` command god runs to drive another agent's terminal directly:
 * read its live screen, type, press keys, send (type + Enter). The app does the work (main's
 * headless mirror and PTY writer, origin GOD); this script only carries one request.
 *
 *   term read <agent> [--rows N]           the screen as plain text, with the cursor
 *   term type <agent> [--raw] [--file F]   text from stdin (or F), written as ONE write, no Enter
 *   term send <agent> [--raw] [--file F]   the same, then Enter once the echo settles
 *   term keys <agent> <key> [<key>...]     enter esc tab shift-tab backspace space ctrl-c ctrl-d
 *                                          ctrl-l ctrl-u up down left right home end pgup pgdn y n 0-9
 *   term hold on [reason] | term hold off  the floor hold (a Human pause): no owed-work continuations
 *   term rule <agent> send-again|already-handled --id <requestId>
 *                                          rule on a held-interfered latch (term read shows it), as
 *                                          the Human's message box does; it types nothing
 *
 * Text is NEVER taken from arguments: a shell string gets its backticks and $(...) executed
 * (MSG-COMPOSE-SHELL-INJECTION). The one exception is the `hold on` reason, a short label god
 * writes itself: single-quote it, and never paste a broadcast into it (backticks or $(...) would
 * run in the shell before term sees them). One trailing newline of the input is dropped (echo/here-doc add it).
 * The app refuses a lone "?" and a leading "!" or "/" (they act as keys) unless --raw.
 *
 * God only: the app checks the caller against the registry's god on every request.
 * Exit codes: 0 ok, 1 refused (the reason is printed), 2 bad arguments, 3 app unavailable,
 * 4 timeout. Env (set by the app at god's spawn): HIVE_TERM_URL.
 */
'use strict';
const fs = require('fs');
const http = require('http');

const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3, timeout: 4 };
const REQUEST_TIMEOUT_MS = 60000;
const INPUT_MAX = 16 * 1024;
const ROWS_MAX = 200;
const USAGE = 'usage: term read <agent> [--rows N] | term type|send <agent> [--raw] [--file <path>] (text on stdin) | term keys <agent> <key>... | term hold on [reason] | term hold off | term rule <agent> send-again|already-handled --id <requestId>\n';
const RULINGS = { 'send-again': 'SEND_AGAIN', 'already-handled': 'ALREADY_HANDLED' };

/** The request body, or throws with the reason. `needsText` = the text still has to be read. */
function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) return { help: true };
  const [action, agent, ...rest] = argv;
  if (action === 'hold') {
    // The floor hold: floor state, no agent. The reason is a short label (single-quote it).
    if (agent === 'off' && rest.length === 0) return { body: { action, state: 'off' } };
    if (agent === 'on') return { body: { action, state: 'on', reason: rest.join(' ') } };
    throw new Error('hold: on [reason] or off');
  }
  if (!['read', 'type', 'send', 'keys', 'rule'].includes(action)) throw new Error('the first argument is read, type, send, keys, hold or rule');
  if (!agent || agent.startsWith('-')) throw new Error('an agent id is required');
  if (action === 'rule') {
    // No default: a bare `term rule <agent>` is refused, as the message box refuses a bare "resolved".
    // GTC-ID: --id <requestId> (what `term read` printed) is required: god rules on the hold it
    // read, never on whatever is held by the time the command lands (the app answers 409 then).
    const how = rest.length > 0 && Object.prototype.hasOwnProperty.call(RULINGS, rest[0]) ? RULINGS[rest[0]] : null;
    if (!how) throw new Error('rule: send-again or already-handled (there is no default)');
    if (rest.length !== 3 || rest[1] !== '--id' || !rest[2] || rest[2].startsWith('-')) throw new Error('rule: --id <requestId> is required (term read <agent> prints it)');
    return { body: { action, agent, how, id: rest[2] } };
  }
  if (action === 'keys') {
    if (rest.length === 0) throw new Error('keys: name at least one key');
    return { body: { action, agent, keys: rest } };
  }
  if (action === 'read') {
    if (rest.length === 0) return { body: { action, agent } };
    if (rest.length === 2 && rest[0] === '--rows' && /^[1-9][0-9]*$/.test(rest[1]) && Number(rest[1]) <= ROWS_MAX) return { body: { action, agent, rows: Number(rest[1]) } };
    throw new Error(`read: only --rows N (1-${ROWS_MAX})`);
  }
  let raw = false;
  let file = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--raw') raw = true;
    else if (rest[i] === '--file' && rest[i + 1]) file = rest[++i];
    else throw new Error(`${action}: only --raw and --file <path> (the text comes from stdin or the file, never from arguments)`);
  }
  return { body: { action, agent, raw }, file, needsText: true };
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stdin.on('data', (d) => { size += d.length; if (size <= INPUT_MAX * 4 + 4) chunks.push(d); });
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
  try { a = parseArgs(argv); } catch (e) { io.err(`term: ${e.message}\n${USAGE}`); return EXIT.usage; }
  if (a.help) { io.out(USAGE); return EXIT.ok; }
  if (a.needsText) {
    let buf;
    try { buf = a.file ? fs.readFileSync(a.file) : await readStdin(io.stdin); } catch (e) { io.err(`term: cannot read ${a.file || 'stdin'}: ${e.message}\n`); return EXIT.usage; }
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r?\n$/, '');
    if (!text) { io.err(`term: no text (pipe it on stdin or pass --file)\n${USAGE}`); return EXIT.usage; }
    if (text.length > INPUT_MAX) { io.err(`term: the text is over ${INPUT_MAX} characters\n`); return EXIT.usage; }
    a.body.text = text;
  }
  const url = env.HIVE_TERM_URL;
  if (!url) { io.err('term: unavailable (HIVE_TERM_URL is not set: term is god-only, or the app\'s hook broker was down at spawn)\n'); return EXIT.unavailable; }
  const r = await post(url, Buffer.from(JSON.stringify(a.body), 'utf8'), REQUEST_TIMEOUT_MS);
  if (r.error === 'timeout') { io.err('term: the app did not answer in time; read the screen before you repeat a type or send\n'); return EXIT.timeout; }
  if (r.status === 0) { io.err(`term: the app is unavailable (${r.error})\n`); return EXIT.unavailable; }
  const b = r.body || {};
  const line = typeof b.line === 'string' ? b.line : `HTTP ${r.status}`;
  if (r.status === 200 && b.ok) {
    io.out(`${line}\n`);
    if (Array.isArray(b.screen)) io.out(`${b.screen.join('\n')}\n`);
    return EXIT.ok;
  }
  // 404 with no term reply: the route is not wired (an older app). A stale token answers 403.
  if (r.status === 404 && !b.line) { io.err('term: unavailable (this app has no term route)\n'); return EXIT.unavailable; }
  if (r.status === 403 && !b.line) { io.err('term: not authorized (a stale HIVE_TERM_URL: this agent was respawned)\n'); return EXIT.unavailable; }
  if (r.status === 503) { io.err(`term: ${line}\n`); return EXIT.unavailable; }
  io.err(`term: ${line}\n`);
  return EXIT.refused;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`term: ${e && e.stack ? e.stack : e}\n`); process.exitCode = EXIT.unavailable; });
}

module.exports = { main, parseArgs, EXIT };
