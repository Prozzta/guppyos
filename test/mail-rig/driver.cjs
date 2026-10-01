'use strict';
/**
 * ZT-I1-MAIL slice 8: the TEST DRIVER for the fake-agent rig (INBOX-DESIGN §8.2). It starts the
 * sandbox instance (rig-host.cjs) in its own throwaway directory, talks to it over its loopback
 * control port, cues the fake CLIs through their control files, reads their transcripts, and owns
 * the cleanup: every instance and every stub process is killed at the end of the test, on failure
 * too, and the sandbox directory is removed (a leak fails loudly, as in electron-harness/run.cjs).
 *
 * Nothing here touches the live floor: the child env is scrubbed (HIVE_*, AGENT_*, MEMORY_*,
 * MUNDER_*, CTH_*, KG_*, CLAUDE*), HOME / USERPROFILE / CODEX_HOME / GEMINI_CLI_HOME point into the
 * sandbox, and the hive dirs are dropped from PATH. The host re-asserts all of it before loading.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createSandbox, removeSandbox } = require('../electron-harness/run.cjs');
const { rigEnv } = require('./isolation.cjs');

const HOST = path.join(__dirname, 'rig-host.cjs');
const BAD_ENV = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_|MD_SLACK_|CLAUDE)/i;

/** The host's ENTIRE env: an allowlist (isolation.cjs rigEnv), never the parent minus a few keys. */
function scrubbedEnv(sandbox) {
  const env = rigEnv(sandbox);
  for (const k of Object.keys(env)) if (BAD_ENV.test(k)) throw new Error(`rig env: ${k} is not allowlisted`);
  return env;
}

function post(port, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`rig reply not JSON: ${out.slice(0, 300)}`)); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`rig call timed out: ${body.cmd}`)); });
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

class Rig {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.rigDir = path.join(sandbox, 'rig');
    this.child = null;
    this.port = 0;
    this.hostPids = [];
    this.log = '';
  }

  async boot(timeoutMs = 45_000) {
    const env = scrubbedEnv(this.sandbox);
    this.child = spawn(process.execPath, [HOST, '--sandbox', this.sandbox, '--parent', String(process.pid)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.hostPids.push(this.child.pid);
    const child = this.child;
    this.exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
    const ready = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`rig host did not start in ${timeoutMs} ms\n${out}\n${this.log}`)), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { this.log = (this.log + d).slice(-20_000); });
      child.stdout.on('data', (d) => {
        out += d;
        this.log = (this.log + d).slice(-20_000);
        const at = out.indexOf('__RIG_READY__');
        if (at >= 0 && out.indexOf('\n', at) > 0) { clearTimeout(timer); resolve(JSON.parse(out.slice(at + 13, out.indexOf('\n', at)))); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`rig host exited (${code}) before it was ready\n${this.log}`)); });
    });
    this.port = ready.port;
    this.info = ready;
    return ready;
  }

  async call(cmd, args = {}, timeoutMs = 60_000) {
    const r = await post(this.port, { cmd, args }, timeoutMs);
    if (!r.ok) throw new Error(`rig ${cmd} failed: ${r.error}`);
    return r.value;
  }

  // ——— the app ———

  /** kill -9 the instance (no quit path, no flush). Its stubs follow it (their lifeline). */
  async kill9() {
    const child = this.child;
    if (!child) return;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    await Promise.race([this.exited, sleep(10_000)]);
    this.child = null;
    await this.waitStubsGone();
  }

  async restart() {
    if (this.child) await this.kill9();
    return this.boot();
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    try { await this.call('shutdown', {}, 5_000); } catch { /* already gone */ }
    const r = await Promise.race([this.exited, sleep(8_000).then(() => null)]);
    if (!r) killTree(child.pid);
    this.child = null;
  }

  stubPids() {
    const dir = path.join(this.rigDir, 'stubs');
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const n of names) {
      try { const pid = Number(fs.readFileSync(path.join(dir, n, 'pid'), 'utf8')); if (pid > 0) out.push(pid); } catch { /* none */ }
    }
    return out;
  }

  async waitStubsGone(ms = 8_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!this.stubPids().some(pidAlive)) return;
      await sleep(100);
    }
    for (const pid of this.stubPids()) killTree(pid);
  }

  /** Kill EVERYTHING this rig started (hosts, stubs, their trees), then remove the sandbox. */
  async destroy() {
    if (process.env.RIG_DEBUG) await this.dump().catch((e) => process.stderr.write(`dump failed: ${e}\n`));
    try { await this.stop(); } catch { /* keep going */ }
    for (const pid of this.hostPids) killTree(pid);
    await this.waitStubsGone(4_000);
    for (const pid of this.stubPids()) killTree(pid);
    await removeSandbox(this.sandbox);
  }

  /** RIG_DEBUG=1: what happened, for a failing test (wake diagnostics, owner outcomes, stubs). */
  async dump() {
    const lines = [`===== rig dump ${this.sandbox}`];
    if (this.child) {
      const diags = await this.call('diags', {}, 5_000).catch(() => []);
      lines.push('diags: ' + diags.filter((d) => !['enter', 'facts', 'schedule'].includes(d.stage)).map((d) => `${d.agentId ?? '-'}:${d.stage}:${d.why ?? d.outcome ?? d.reason ?? d.event ?? ''}`).join(' '));
      lines.push('outcomes: ' + JSON.stringify((await this.call('outcomes', {}, 5_000).catch(() => [])).map((o) => [o.agentId, o.outcome.kind, o.outcome.reason ?? ''])));
      const rows = await this.call('logRows', { n: 400 }, 5_000).catch(() => []);
      lines.push('log: ' + rows.filter((r) => /^mail|drop|bounce|archive/.test(String(r.kind))).map((r) => `${r.kind}${r.stage ? `/${r.stage}` : ''}${r.reason ? `(${r.reason})` : ''}`).join(' '));
    }
    let names = [];
    try { names = fs.readdirSync(path.join(this.rigDir, 'stubs')); } catch { names = []; }
    for (const n of names) {
      lines.push(`--- ${n}: ` + this.transcript(n).filter((r) => !['pty-input', 'settings', 'start'].includes(r.kind)).map((r) => `${r.kind}${r.event ? `:${r.event}` : ''}${r.exit !== undefined ? `=${r.exit}` : ''}${r.ids ? `[${r.ids.length}]` : ''}${r.cue ? `{${r.cue.cue}}` : ''}${r.how ? `(${r.how})` : ''}`).join(' '));
    }
    process.stderr.write(`${lines.join('\n')}\n`);
  }

  /**
   * A failure dump for one agent (C1 and any waitFor given `diag`): its ledger entries, the mail
   * and late rows, the wake diagnostics, and the stub's hook records WITH their timings and
   * transports, prompts, contexts and turn ends.
   */
  async diagnose(agentId) {
    const lines = [`----- rig diagnostics for ${agentId} (${this.sandbox})`];
    const call = (cmd, args) => this.call(cmd, args, 5_000).catch((e) => ({ error: String(e) }));
    const led = await call('ledger', { id: agentId });
    for (const e of Object.values(led?.entries ?? {})) lines.push(`ledger ${e.id}: state=${e.state} epoch=${e.epoch ?? null} surfaceCount=${e.surfaceCount} redelivered=${e.redelivered} confirm=${e.confirmMethod ?? null}`);
    const rows = await call('logRows', { n: 2000 });
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (r.agentId !== agentId || !/^mail/.test(String(r.kind))) continue;
      lines.push(`row ${r.kind}${r.stage ? '/' + r.stage : ''} ${JSON.stringify({ ids: r.ids, epoch: r.epoch, reason: r.reason, transport: r.transport, latencyMs: r.latencyMs, limitMs: r.limitMs, hookKind: r.hookKind })}`);
    }
    const diags = await call('diags', {});
    lines.push('wake: ' + (Array.isArray(diags) ? diags : []).filter((d) => d.agentId === agentId && !['enter', 'facts', 'schedule'].includes(d.stage)).map((d) => `${d.stage}:${d.why ?? d.outcome ?? d.event ?? ''}`).join(' '));
    const outs = await call('outcomes', {});
    for (const o of (Array.isArray(outs) ? outs : [])) if (o.agentId === agentId) lines.push('outcome ' + o.cls + ' ' + JSON.stringify(o.outcome));
    for (const r of this.transcript(agentId)) {
      if (r.kind === 'hook') lines.push(`stub hook ${r.event} transport=${r.transport} exit=${r.exit} ms=${r.ms ?? null} t=${r.t ?? null} response=${r.response ? JSON.stringify(r.response).slice(0, 120) : null}`);
      else if (['prompt', 'context', 'turn-end', 'cue', 'exit', 'host-gone'].includes(r.kind)) lines.push(`stub ${r.kind} ${JSON.stringify({ t: r.t, event: r.event, ids: r.ids, how: r.how, cue: r.cue?.cue })}`);
    }
    return lines.join('\n');
  }

  // ——— the fake CLIs ———

  stubDir(agentId) { return path.join(this.rigDir, 'stubs', agentId); }

  cue(agentId, cue) {
    fs.mkdirSync(this.stubDir(agentId), { recursive: true });
    fs.appendFileSync(path.join(this.stubDir(agentId), 'control.jsonl'), `${JSON.stringify(cue)}\n`);
  }

  transcript(agentId) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.stubDir(agentId), 'transcript.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  /** Every context block the "model" of this agent received, in order. */
  contexts(agentId) { return this.transcript(agentId).filter((r) => r.kind === 'context'); }
  prompts(agentId) { return this.transcript(agentId).filter((r) => r.kind === 'prompt'); }
  hooks(agentId, event) { return this.transcript(agentId).filter((r) => r.kind === 'hook' && (!event || r.event === event)); }
  turnEnds(agentId) { return this.transcript(agentId).filter((r) => r.kind === 'turn-end'); }

  // ——— common floor steps ———

  /** god (registered, no PTY) + the given fake agents, each up and past its boot grace. */
  async setup(specs, { god = true } = {}) {
    if (god) await this.call('register', { id: 'god-1', name: 'Michael', provider: 'claude', isGod: true });
    for (const s of specs) {
      const r = await this.call('spawn', s);
      if (!r.ok) throw new Error(`spawn ${s.id} failed: ${r.error}`);
    }
    for (const s of specs) await this.waitReady(s);
    await this.settleBoot(specs.map((s) => s.id));
    // WORKER_WAKE_BOOT_GRACE_MS (35 s) on the coordinator's (simulated) clock.
    await this.call('advance', { ms: 40_000 });
  }

  /**
   * An EVENT barrier: the simulated clock moves only after the HOST's PTY stream has carried each
   * stub's boot-complete sentinel, the last bytes a stub writes at boot. PTY output is mapped onto
   * the simulated clock with the offset in force when it ARRIVES, so boot output that ConPTY
   * delivered after setup's 40 s advance (seen under full-suite load) was stamped "now" and the
   * first reconcile beat refused the wake as lifecycle-unknown-not-quiescent. The timeout is a
   * failure (with diagnostics), never a pass.
   */
  async settleBoot(ids) {
    for (const id of ids) {
      await waitFor(() => this.call('bootSeen', { id }), { what: `${id}'s boot-complete sentinel in the host's PTY stream`, timeoutMs: 60_000, intervalMs: 50, diag: () => this.diagnose(id) });
    }
  }

  async waitReady(s, minStarts = 1) {
    const withSessionStart = s.flavour === 'claude' || s.flavour === 'codex' || s.flavour === 'gemini';
    await waitFor(() => {
      const tr = this.transcript(s.id);
      const starts = tr.filter((r) => r.kind === 'start');
      if (starts.length < minStarts) return false;
      const lastStart = starts[starts.length - 1].t;
      return !withSessionStart || tr.some((r) => r.kind === 'hook' && r.event === 'SessionStart' && r.t >= lastStart);
    }, { what: `${s.id} to start (#${minStarts})`, timeoutMs: 30_000 });
  }

  /** Spawn an agent AGAIN (a restart in place, or the tab restored after an app restart). */
  async respawn(s) {
    const before = this.transcript(s.id).filter((r) => r.kind === 'start').length;
    const r = await this.call('spawn', s);
    if (!r.ok) throw new Error(`respawn ${s.id} failed: ${r.error}`);
    await this.waitReady(s, before + 1);
    await this.settleBoot([s.id]);
    await this.call('advance', { ms: 40_000 });
    return r;
  }

  async entry(agentId, id) { return (await this.call('ledger', { id: agentId })).entries[id] ?? null; }
  async rows(kinds) { return this.call('logRows', { kinds: Array.isArray(kinds) ? kinds : [kinds] }); }
  async beat() { return this.call('beat'); }

  /**
   * Beat until `fn` holds, passing simulated time between beats (the 15 s beat, the cooldowns,
   * the retry backoffs). With `settle`, it first waits for running turns to end: real turns take
   * real time, and the simulated clock must never move under one.
   */
  async beatUntil(fn, { what, stepMs = 70_000, tries = 40, pauseMs = 250, settle = true } = {}) {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      if (settle) await this.quiet();
      await this.call('advance', { ms: stepMs });
      await this.beat();
      await sleep(pauseMs);
    }
    if (await fn()) return true;
    throw new Error(`beatUntil: ${what ?? 'condition'} never held`);
  }

  /** Wait (bounded) until no live agent has a wake in flight or a turn running. */
  async quiet(timeoutMs = 10_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!(await this.call('busy'))) return true;
      await sleep(80);
    }
    return false;
  }

  agentDir(agentId) { return path.join(this.sandbox, 'harness', 'hive', 'agents', agentId); }
  inboxFiles(agentId) { try { return fs.readdirSync(path.join(this.agentDir(agentId), 'inbox')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; } }
  doneFiles(agentId) { try { return fs.readdirSync(path.join(this.agentDir(agentId), 'inbox', '.done')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; } }
  ledgerFile(agentId) { return path.join(this.sandbox, 'harness', 'hive', 'state', 'mail', `${agentId}.json`); }
}

/**
 * A rig for one test: booted, and destroyed after the test whatever happens.
 * @param {import('node:test').TestContext} t
 */
async function startRig(t) {
  const sandbox = createSandbox('md-mailrig-');
  const rig = new Rig(sandbox);
  t.after(() => rig.destroy());
  await rig.boot();
  return rig;
}

/** Poll `fn` until it returns a truthy value; fail naming `what` after `timeoutMs`. */
async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 60, what = 'condition', diag = null } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); } catch (e) { last = e; }
    if (last && !(last instanceof Error)) return last;
    await sleep(intervalMs);
  }
  // `diag`: an async dump appended to the failure (e.g. () => rig.diagnose(agentId)).
  let extra = '';
  if (diag) { try { extra = `\n${await diag()}`; } catch (e) { extra = `\n(diagnostics failed: ${e})`; } }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}${extra}`);
}

const markersIn = (text) => [...String(text ?? '').matchAll(/\[hive-mail:([^\]]+)\]/g)].map((m) => m[1]);
const REDELIVERED = '(re-delivered: this may already have been handled';

module.exports = { startRig, waitFor, sleep, markersIn, REDELIVERED, scrubbedEnv, Rig, pidAlive };
