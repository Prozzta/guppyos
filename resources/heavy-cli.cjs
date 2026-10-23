#!/usr/bin/env node
/*
 * HEAVY-LOCK-RESERVATION-RELEASE: the `heavy` command agents run, on the heavy lock's /heavy route
 * (the per-spawn token the heavy preload uses; HIVE_LEDGER_URL with /ledger/ made /heavy/).
 *
 *   heavy status                 who holds the slot, who waits, who has a slot reserved
 *   heavy release                give up my reserved slot, or my place in the queue: it passes on at once
 *   heavy release --to <agent>   ... to that queued agent first (else to the oldest waiter)
 *   heavy next <agent>           HEAVY-HANDOFF-RACE: the next freed slot goes to that agent, ahead of the
 *                                queue (a holder, an agent with a slot reserved, or god may say so)
 *
 * A held slot (HEAVY-HANDOFF-RACE (e)) is released here only when no process of its job runs any more;
 * else the release is refused, naming the open call and the pids.
 * Exit codes: 0 ok, 2 bad arguments, 3 app unavailable, 4 timeout.
 */
'use strict';
const http = require('http');

const EXIT = { ok: 0, usage: 2, unavailable: 3, timeout: 4 };
const REQUEST_TIMEOUT_MS = 15000;
const USAGE = 'usage: heavy status | heavy release [--to <agent>] | heavy next <agent>\n  release: give up my reserved slot, or my place in the queue (a denial queued me), or the slot I hold (once its job is over)\n  next: the next freed slot goes to that agent first (a holder, a reserved agent, or god may say so)\n';
const AGENT = /^[A-Za-z0-9._-]{1,80}$/;

/** { op: 'status' } | { op: 'unreserve', to? } | { op: 'next', to } | { help: true }, or throws. */
function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) return { help: true };
  if (argv.length === 1 && argv[0] === 'status') return { op: 'status' };
  if (argv.length === 2 && argv[0] === 'next') {
    if (!AGENT.test(argv[1])) throw new Error(`not an agent id: ${JSON.stringify(argv[1]).slice(0, 90)}`);
    return { op: 'next', to: argv[1] };
  }
  if (argv.length === 1 && argv[0] === 'release') return { op: 'unreserve' };
  if (argv.length === 3 && argv[0] === 'release' && argv[1] === '--to') {
    if (!AGENT.test(argv[2])) throw new Error(`not an agent id: ${JSON.stringify(argv[2]).slice(0, 90)}`);
    return { op: 'unreserve', to: argv[2] };
  }
  throw new Error(argv.length ? `unknown arguments: ${argv.join(' ').slice(0, 120)}` : 'no command');
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

/** The answer as one or two lines a person (or an agent) reads. */
function describe(b) {
  if (b.state === 'status') {
    const reserved = b.reserved.map((r) => `${r.agentId} until ${String(r.until).slice(11, 19)}Z`);
    const next = b.next ? `; next: ${b.next}` : '';
    // HEAVY-HANDOFF-RACE (c): the caller's own standing, in the words the deny and the notices use.
    const y = b.you;
    const you = !y ? ''
      : y.holding ? 'you: holding a slot (it frees when your job ends)\n'
        : y.reserved ? `you: the slot is reserved for you until ${String(y.reserved).slice(11, 19)}Z (run your job now, or \`heavy release\`)\n`
          : y.position ? `you: queued #${y.position} (you are told "HEAVY SLOT FREE" when it is yours)\n`
            : 'you: not queued, nothing reserved, nothing held\n';
    return `held: ${b.holders.join(', ') || 'none'}; reserved: ${reserved.join(', ') || 'none'}; queue: ${b.waiters.join(', ') || 'empty'}${next}\n${you}`;
  }
  if (b.state === 'next') {
    if (b.refused === 'self') return 'heavy: name another agent, not yourself\n';
    if (b.refused) return 'heavy: refused: only a holder, an agent with a slot reserved, or god may name the next holder\n';
    return `heavy: the next freed slot goes to ${b.to} ${b.queued ? '(queued: now at the head of the queue)' : '(not queued yet: it goes to the head when it next asks)'}\n`;
  }
  const to = b.to === 'not-queued' ? ' (the agent you named is not queued, so it went in queue order)' : '';
  // HEAVY-HANDOFF-RACE (e): a holder's release never says "nothing".
  if (b.held) {
    const calls = b.held.calls.length ? `call ${b.held.calls.join(', ')}` : 'no open call';
    if (!b.held.dropped) {
      const pids = b.held.pids.length ? `, pids ${b.held.pids.join(', ')}` : '';
      return b.held.checked === 'failed'
        ? `heavy: refused: you hold the ${b.held.kind} slot and the process check failed, so its job may still run (${calls}); it frees when the job ends, or run heavy release again\n`
        : `heavy: refused: you hold the ${b.held.kind} slot and its job still runs (${calls}${pids}); stop the job first, or it frees when the job ends\n`;
    }
    const idle = b.held.checked === 'ok' ? ': no process of its job runs' : '';
    return `heavy: released your held ${b.held.kind} slot (${calls} dropped${idle}); it is now ${b.next ? `reserved for ${b.next}` : 'free (no one is queued)'}${to}\n`;
  }
  if (!b.reserved && !b.queued) return 'heavy: nothing to release: no slot is reserved for you and you are not queued (a slot you hold frees when its job ends)\n';
  const gave = b.reserved ? 'released your reserved slot' : 'left the queue';
  const next = b.reserved ? `; it is now ${b.next ? `reserved for ${b.next}` : 'free (no one is queued)'}${to}` : '';
  const waiting = b.waiting ? '\nheavy: a test process of yours is still waiting for the slot; within 25 s it asks again and queues you again (at the back). Stop it if you do not need it.' : '';
  return `heavy: ${gave}${next}${waiting}\n`;
}

async function main(argv, env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let a;
  try { a = parseArgs(argv); } catch (e) { io.err(`heavy: ${e.message}\n${USAGE}`); return EXIT.usage; }
  if (a.help) { io.out(USAGE); return EXIT.ok; }
  const url = String(env.HIVE_LEDGER_URL || '').replace('/ledger/', '/heavy/');
  if (!/^http:\/\/127\.0\.0\.1:\d+\/heavy\//.test(url)) {
    io.err('heavy: unavailable (HIVE_LEDGER_URL is not set: the app\'s hook broker was down at spawn, or this is not a hive agent)\n');
    return EXIT.unavailable;
  }
  const r = await post(url, Buffer.from(JSON.stringify(a.to ? { op: a.op, to: a.to } : { op: a.op })), REQUEST_TIMEOUT_MS);
  if (r.error === 'timeout') { io.err('heavy: the app did not answer in time\n'); return EXIT.timeout; }
  if (r.status === 0) { io.err(`heavy: the app is unavailable (${r.error})\n`); return EXIT.unavailable; }
  if (r.status === 403) { io.err('heavy: not authorized (a stale HIVE_LEDGER_URL: this agent was respawned)\n'); return EXIT.unavailable; }
  const b = r.body;
  if (r.status !== 200 || !b || (b.state !== 'status' && b.state !== 'unreserved' && b.state !== 'next')) {
    // An older app has no such op: it answers as if a lease were asked (or 400/404).
    io.err(`heavy: unavailable (this app build has no \`heavy ${argv[0]}\`: HTTP ${r.status}${b && b.line ? `, ${b.line}` : ''})\n`);
    return EXIT.unavailable;
  }
  io.out(describe(b));
  return EXIT.ok;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`heavy: ${e && e.stack ? e.stack : e}\n`); process.exitCode = EXIT.unavailable; });
}

module.exports = { main, parseArgs, describe, EXIT };
