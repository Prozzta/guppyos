/* CLAIMS-BOOTSTRAP: god-only client for the main-process, heavy-locked legacy import.
 * CLAIMS-REKEY-ENTRYPOINT-108: `claims rekey --floor <hive folder>` asks main to rekey that floor's
 * claim ledgers. Main shows the Human a dialog in the Guppy window and runs the rekey only on a yes;
 * this client cannot confirm anything itself. */
'use strict';
const http = require('http');
const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3, timeout: 4 };
const USAGE = 'usage: claims bootstrap [--status] | claims rekey --floor <hive folder>\n';
// The Human has 5 minutes to answer main's dialog (rekeyCommand.ts REKEY_CONFIRM_MS); the rekey follows.
const REKEY_TIMEOUT_MS = 10 * 60000;

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) return { help: true };
  if (argv.length === 1 && argv[0] === 'bootstrap') return { action: 'run' };
  if (argv.length === 2 && argv[0] === 'bootstrap' && argv[1] === '--status') return { action: 'status' };
  if (argv[0] === 'rekey') {
    if (argv.length !== 3 || argv[1] !== '--floor' || !argv[2] || argv[2].startsWith('-')) throw new Error('rekey: --floor <hive folder> is required (the floor to rekey; the Human confirms in the Guppy window)');
    return { action: 'rekey', floor: argv[2] };
  }
  throw new Error('expected bootstrap, bootstrap --status or rekey --floor <hive folder>');
}
function post(urlText, body, timeout = 120000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlText); } catch { resolve({ status: 0, error: 'bad-url' }); return; }
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => { try { resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { resolve({ status: res.statusCode || 0, body: null }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.code || e) })); req.end(data);
  });
}
async function main(argv, env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let a; try { a = parseArgs(argv); } catch (e) { io.err(`claims: ${e.message}\n${USAGE}`); return EXIT.usage; }
  if (a.help) { io.out(USAGE); return EXIT.ok; }
  if (!env.HIVE_CLAIMS_URL) { io.err('claims: unavailable (HIVE_CLAIMS_URL is not set: the claims command is god-only)\n'); return EXIT.unavailable; }
  if (a.action === 'rekey') io.err('claims: waiting for the Human to confirm the rekey in the Guppy window (up to 5 minutes)...\n');
  const r = a.action === 'rekey' ? await post(env.HIVE_CLAIMS_URL, { action: 'rekey', floor: a.floor }, REKEY_TIMEOUT_MS) : await post(env.HIVE_CLAIMS_URL, { action: a.action });
  if (r.status === 0) { io.err(`claims: unavailable (${r.error})\n`); return r.error === 'timeout' ? EXIT.timeout : EXIT.unavailable; }
  const b = r.body || {}; const line = typeof b.line === 'string' ? b.line : `HTTP ${r.status}`;
  const more = Array.isArray(b.lines) ? b.lines.filter((l) => typeof l === 'string').map((l) => `${l}\n`).join('') : '';
  if (r.status === 200 && b.ok) { io.out(`${line}\n${more}`); if (b.state) io.out(`${JSON.stringify(b.state)}\n`); return EXIT.ok; }
  io.err(`claims: ${line}\n${more}`); return EXIT.refused;
}
if (require.main === module) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`claims: ${e}\n`); process.exitCode = EXIT.unavailable; });
module.exports = { main, parseArgs, EXIT, REKEY_TIMEOUT_MS };
