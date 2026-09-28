'use strict';
/**
 * ZT-I1-MAIL slice 8 (INBOX-DESIGN §8.2): the FAKE AGENT. One stub CLI, several provider
 * flavours. The rig spawns it through the app's normal PTY path (PtyManager.spawn, the npm-shim
 * route) with the agent's `command` set to a `fake-<flavour>.cmd` shim, so it receives exactly
 * the argv and env a real CLI would (the `--settings` file, CODEX_HOME, GEMINI_CLI_SYSTEM_SETTINGS_PATH,
 * HIVE_SOCK, AGENT_ID ...).
 *
 * ZERO MODEL TOKENS: nothing here ever talks to a model. The only network peers are the app's own
 * loopback hook broker / MCP endpoint / named pipe, and (proxy flavour) the app's loopback proxy
 * sidecar, whose upstream the rig points at its own fake LLM. Any non-loopback URL is refused.
 *
 * The stub:
 *  - emits the provider's REAL hook events with real payload shapes, through the SAME transport
 *    the real CLI uses (Claude: the settings.json http hook / command shim; Codex: config.toml
 *    command hooks + mcp_tool hooks, a real rollout file; AGY: ~/.gemini/config/hooks.json
 *    commands + the one-way pipe; gemini: the per-agent system settings command hooks);
 *  - follows a scenario (`scenario.json`) and a control file (`control.jsonl`, one cue per line)
 *    that the test driver appends to mid-run;
 *  - records EVERYTHING it receives (PTY input, prompts, hook responses and additionalContext) to
 *    `transcript.jsonl`, which the assertions read;
 *  - mirrors its composer line to `composer.json` (the rig's headless screen stand-in reads it).
 *
 * Plain Node, no product code: it is a CLI, not part of the app.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const FLAVOURS = new Set(['claude', 'codex', 'agy', 'gemini', 'custom', 'cursor', 'qwen']);

function main(flavour) {
  if (!FLAVOURS.has(flavour)) { process.stderr.write(`fake-agent: unknown flavour ${flavour}\n`); process.exit(2); }
  const rigDir = process.env.RIG_DIR;
  const agentId = process.env.AGENT_ID;
  if (!rigDir || !agentId) { process.stderr.write('fake-agent: RIG_DIR and AGENT_ID are required\n'); process.exit(2); }
  const dir = path.join(rigDir, 'stubs', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const agent = new FakeAgent(flavour, agentId, dir, process.argv.slice(2));
  agent.start();
}

const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const isLoopbackUrl = (u) => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '::1'; } catch { return false; } };

class FakeAgent {
  constructor(flavour, agentId, dir, argv) {
    this.flavour = flavour;
    this.agentId = agentId;
    this.dir = dir;
    this.argv = argv;
    this.transcriptFile = path.join(dir, 'transcript.jsonl');
    this.controlFile = path.join(dir, 'control.jsonl');
    this.composerFile = path.join(dir, 'composer.json');
    this.scenario = readJson(path.join(dir, 'scenario.json')) || {};
    this.hookMode = this.scenario.hookMode || 'normal';   // normal | discard | exit127 | ups-silent
    // A new incarnation (respawn) starts at the END of the control file: old cues were for the old one.
    try { this.controlOffset = fs.statSync(this.controlFile).size; } catch { this.controlOffset = 0; }
    this.draft = '';
    this.inPaste = false;
    this.turn = null;           // { id, prompt, startedAt, mode }
    this.queue = Promise.resolve();
    this.hung = false;
    this.seen = new Set();      // mail ids the "model" has seen in its context
    this.sessionId = uuid();
    this.turnSeq = 0;
    this.lastTurnId = null;
    this.agentDir = process.env.AGENT_DIR || null;
  }

  // ————————————————————————————————————————————————————————————— recording

  rec(kind, fields = {}) {
    try { fs.appendFileSync(this.transcriptFile, `${JSON.stringify({ t: now(), kind, flavour: this.flavour, ...fields })}\n`); } catch { /* best effort */ }
  }

  writeComposer() {
    try {
      const tmp = `${this.composerFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ draft: this.draft, t: now(), busy: !!this.turn }));
      fs.renameSync(tmp, this.composerFile);
    } catch { /* best effort */ }
  }

  out(text) { if (!this.hung) { try { process.stdout.write(text); } catch { /* pty gone */ } } }

  // ————————————————————————————————————————————————————————————— start-up

  start() {
    fs.writeFileSync(path.join(this.dir, 'pid'), String(process.pid));
    // Isolation (allowlist env, jailed PATH): the stub checks ITSELF, as the host does, and records
    // every problem (the RIG test and the negative control assert none).
    let isolation = [];
    try { require('./isolation.cjs').checkIsolation(process.env, path.dirname(process.env.RIG_DIR || '.'), { allow: require('./isolation.cjs').allowRigBaseUrls, who: 'stub' }); } catch (e) { isolation = String(e.message).split('\n').slice(1).map((s) => s.trim()); }
    this.rec('start', { isolation, envNames: Object.keys(process.env).sort(), path: process.env.PATH || process.env.Path || '', argv: this.argv.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…(${a.length})` : a)), pid: process.pid, cwd: process.cwd(), env: pickEnv(), envAll: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_|CLAUDE|CODEX_|GEMINI_|HOME$|USERPROFILE$|OPENAI_|ANTHROPIC_)/i.test(k))) });
    this.setupFlavour();
    this.writeComposer();
    // The rig host is this process's lifeline: a kill -9 of the app ends its CLIs too (as the
    // ConPTY teardown would), so no stub outlives a test.
    const hostPid = Number(process.env.RIG_HOST_PID || 0);
    this.lifeline = setInterval(() => {
      if (hostPid > 0) { try { process.kill(hostPid, 0); } catch { this.rec('host-gone'); process.exit(0); } }
    }, 400);
    this.control = setInterval(() => this.pollControl(), 40);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch { /* not a tty */ } }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => this.onInput(d));
    process.stdin.resume();
    this.out(`fake ${this.flavour} agent ${this.agentId}\r\n`);
    this.enqueue(() => this.onSessionStart());
    this.out('> ');
    // The boot-complete sentinel: the LAST bytes this stub writes at boot (nothing is written again
    // until input arrives). The driver moves the simulated clock only after the HOST's PTY stream
    // has carried it (Rig.settleBoot).
    this.out(BOOT_SENTINEL);
  }

  setupFlavour() {
    const argAfter = (flag) => { const i = this.argv.indexOf(flag); return i >= 0 ? this.argv[i + 1] : undefined; };
    if (this.flavour === 'claude') {
      const settingsPath = argAfter('--settings');
      this.settings = settingsPath ? readJson(settingsPath) : null;
      this.resumed = argAfter('--resume');
      if (this.resumed) this.sessionId = this.resumed;
      this.rec('settings', { path: settingsPath ?? null, hooks: this.settings ? Object.keys(this.settings.hooks || {}) : [] });
      const tdir = path.join(this.dir, 'claude-projects');
      fs.mkdirSync(tdir, { recursive: true });
      this.transcriptPath = path.join(tdir, `${this.sessionId}.jsonl`);
      if (!fs.existsSync(this.transcriptPath)) fs.writeFileSync(this.transcriptPath, '');
    } else if (this.flavour === 'codex') {
      this.codexHome = process.env.CODEX_HOME;
      this.codexConfig = this.codexHome ? parseCodexConfig(safeRead(path.join(this.codexHome, 'config.toml'))) : { hooks: {}, mcpUrl: null };
      this.rec('settings', { codexHome: this.codexHome ?? null, hooks: Object.keys(this.codexConfig.hooks), mcpUrl: this.codexConfig.mcpUrl });
      const d = new Date();
      const day = path.join(this.codexHome || this.dir, 'sessions', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
      fs.mkdirSync(day, { recursive: true });
      this.rolloutPath = path.join(day, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${this.sessionId}.jsonl`);
      this.rollout({ type: 'session_meta', payload: { id: this.sessionId, cwd: process.cwd(), originator: 'fake_codex' } });
    } else if (this.flavour === 'agy') {
      const home = process.env.USERPROFILE || process.env.HOME;
      const hooks = readJson(path.join(home, '.gemini', 'config', 'hooks.json'));
      this.agyHooks = hooks && hooks['munder-hive'] ? hooks['munder-hive'] : {};
      this.rec('settings', { hooks: Object.keys(this.agyHooks) });
      this.transcriptPath = path.join(this.dir, `agy-${this.sessionId}.jsonl`);
    } else if (this.flavour === 'gemini') {
      const p = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      const s = p ? readJson(p) : null;
      this.geminiHooks = (s && s.hooks) || {};
      this.rec('settings', { path: p ?? null, hooks: Object.keys(this.geminiHooks) });
      this.transcriptPath = path.join(this.dir, `gemini-${this.sessionId}.jsonl`);
    }
  }

  async onSessionStart() {
    if (this.flavour === 'claude') await this.hook('SessionStart', { source: this.resumed ? 'resume' : 'startup' });
    else if (this.flavour === 'codex') await this.hook('SessionStart', { source: 'startup' });
    else if (this.flavour === 'gemini') await this.hook('SessionStart', { source: 'startup' });
  }

  // ————————————————————————————————————————————————————————————— the terminal

  onInput(d) {
    this.rec('pty-input', { data: d });
    if (this.hung) return;
    let s = d;
    while (s.length) {
      if (s.startsWith('\x1b[200~')) { this.inPaste = true; s = s.slice(6); continue; }
      if (s.startsWith('\x1b[201~')) { this.inPaste = false; s = s.slice(6); continue; }
      const ch = s[0];
      s = s.slice(1);
      if (this.inPaste) { this.draft += ch === '\r' ? '\n' : ch; continue; }
      if (ch === '\r') { this.submit(); continue; }
      if (ch === '\n') { this.draft += '\n'; continue; }
      if (ch === '\x15') { this.draft = ''; continue; }                       // Ctrl-U
      if (ch === '\x03') { this.interrupt('ctrl-c'); continue; }             // Ctrl-C
      if (ch === '\x7f' || ch === '\b') { this.draft = this.draft.slice(0, -1); continue; }
      if (ch === '\x1b') { const m = /^\[[0-9;?]*[A-Za-z~]/.exec(s); if (m) s = s.slice(m[0].length); continue; }
      if (ch < ' ' && ch !== '\t') continue;
      this.draft += ch;
    }
    this.writeComposer();
    this.out(`\r\x1b[K> ${this.draft.split('\n').pop()}`);
  }

  submit() {
    const prompt = this.draft;
    this.draft = '';
    this.writeComposer();
    this.out('\r\n');
    if (!prompt.trim()) return;
    this.rec('prompt', { text: prompt, midTurn: !!this.turn });
    if (this.turn && this.flavour === 'claude') {
      // A prompt typed while a turn runs (N3): Claude submits it as a new UserPromptSubmit
      // that JOINS the live turn (queued input). The turn carries on.
      this.enqueue(async () => { await this.promptHook(prompt, { midTurn: true }); });
      return;
    }
    if (this.turn) { this.rec('prompt-queued', { text: prompt }); this.enqueue(() => this.runTurn(prompt)); return; }
    this.enqueue(() => this.runTurn(prompt));
  }

  interrupt(why) {
    if (!this.turn) return;
    this.rec('interrupt', { why, turn: this.turn.id });
    this.turn.interrupted = true;   // the turn ends with NO Stop hook (a user interrupt)
    if (this.manual()) {            // no scripted steps to unwind: it is over now
      this.rec('turn-end', { how: 'interrupted', turn: this.turn.id });
      this.turn = null;
      this.writeComposer();
      this.out('\r\n> ');
    }
  }

  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => this.rec('error', { error: String((e && e.stack) || e) }));
    return this.queue;
  }

  // ————————————————————————————————————————————————————————————— the control file

  pollControl() {
    let text = '';
    try {
      const st = fs.statSync(this.controlFile);
      if (st.size <= this.controlOffset) return;
      const fd = fs.openSync(this.controlFile, 'r');
      const buf = Buffer.alloc(st.size - this.controlOffset);
      fs.readSync(fd, buf, 0, buf.length, this.controlOffset);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { return; }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return;
    this.controlOffset += Buffer.byteLength(text.slice(0, lastNl + 1));
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line.trim()) continue;
      let cue;
      try { cue = JSON.parse(line); } catch { continue; }
      this.onCue(cue);
    }
  }

  onCue(cue) {
    this.rec('cue', { cue });
    switch (cue.cue) {
      case 'crash': this.rec('exit', { code: cue.code ?? 1 }); process.exit(cue.code ?? 1); return;
      case 'hang': this.hung = true; return;
      case 'unhang': this.hung = false; return;
      case 'interrupt': this.interrupt('cue'); return;
      default: break;
    }
    if (this.hung) return;
    // Everything else happens in order with the turn's own steps.
    this.enqueue(() => this.runCue(cue));
  }

  async runCue(cue) {
    switch (cue.cue) {
      case 'tool': return this.toolCall(cue.name || 'Bash', cue.input || { command: 'echo hi' }, cue.midContext !== false);
      case 'stop': return this.endTurn('stop');
      case 'stop-failure': return this.endTurn('stop-failure');
      case 'reply': return this.writeOutbox(cue);
      case 'bulk-move': return this.bulkMove();
      case 'read-inbox': return this.readInbox(cue.ids, cue.move === true);
      case 'compact': return this.compact();
      case 'slow': await sleep(cue.ms || 1000); return undefined;
      case 'stale-complete': return this.codexStaleComplete();
      case 'lost-stop': return this.endTurn('lost-stop');
      case 'pre-invocation': return this.agyPreInvocation(false);
      case 'statusline': return this.agyStatusline(cue.state || 'idle');
      case 'status': return this.hook('Notification', { message: cue.message || 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
      default: this.rec('cue-unknown', { cue }); return undefined;
    }
  }

  // ————————————————————————————————————————————————————————————— turns

  manual() { return this.scenario.manualTurns === true; }

  async runTurn(prompt) {
    if (this.flavour === 'custom' || this.flavour === 'cursor' || this.flavour === 'qwen') return this.hooklessTurn(prompt);
    this.turn = { id: this.flavour === 'codex' ? `turn-${uuid()}` : `t${++this.turnSeq}`, prompt, startedAt: now() };
    this.writeComposer();
    if (this.flavour === 'codex') this.rollout({ type: 'event_msg', payload: { type: 'task_started', turn_id: this.turn.id } });
    const ctx = await this.promptHook(prompt, { midTurn: false });
    // A slash command runs no model turn and no Stop (C6): /compact compacts.
    if (prompt.trimStart().startsWith('/')) {
      if (prompt.trim() === '/compact') await this.compact();
      this.turn = null; this.writeComposer();
      return;
    }
    await this.legacyHabits(prompt, ctx);
    if (this.manual()) return;   // the driver steps the turn with cues
    const t = this.scenario.turn || {};
    for (let i = 0; i < (t.tools ?? 0); i++) {
      if (!this.turn || this.turn.interrupted) break;
      await sleep(t.toolMs ?? 30);
      await this.toolCall('Bash', { command: `echo step ${i}` }, true);
    }
    if (t.slowMs) await sleep(t.slowMs);
    for (const r of t.replies || []) await this.writeOutbox(r);
    if (this.turn && !this.turn.interrupted) await this.endTurn(t.end || 'stop');
    else if (this.turn) { this.rec('turn-end', { how: 'interrupted', turn: this.turn.id }); this.turn = null; this.writeComposer(); }
  }

  /** The turn-start hook of this flavour; returns the context the "model" received. */
  async promptHook(prompt, { midTurn }) {
    if (this.flavour === 'claude') {
      const r = await this.hook('UserPromptSubmit', { prompt });
      return this.takeContext(r, 'UserPromptSubmit', { midTurn });
    }
    if (this.flavour === 'codex') {
      const r = await this.hook('UserPromptSubmit', { prompt, turn_id: this.turn ? this.turn.id : undefined });
      return this.takeContext(r, 'UserPromptSubmit', { midTurn });
    }
    if (this.flavour === 'agy') return this.agyPreInvocation(true);
    if (this.flavour === 'gemini') {
      const r = await this.hook('BeforeAgent', { prompt });
      return this.takeContext(r, 'BeforeAgent', { midTurn });
    }
    return '';
  }

  /** One AGY model call: PreInvocation (the context sink) ... the call ... PostInvocation. */
  async agyPreInvocation(first) {
    const r = await this.hook('PreInvocation', {});
    const ctx = this.takeContext(r, 'PreInvocation', { midTurn: !first });
    await this.hook('PostInvocation', {});
    return ctx;
  }

  /** What the "model" gets from a hook response (unless this stub discards context). */
  takeContext(r, event, extra = {}) {
    if (!r) return '';
    const ctx = contextOf(r.response, this.flavour, event);
    if (!ctx) return '';
    const ids = [...ctx.matchAll(/\[hive-mail:([^\]]+)\]/g)].map((m) => m[1]);
    const discarded = this.hookMode === 'discard';
    this.rec('context', { event, context: ctx, ids, discarded, turn: this.turn ? this.turn.id : null, ...extra });
    if (discarded) return '';
    for (const id of ids) this.seen.add(id);
    // The provider's own delivery record, which the harness reads as §11.1 evidence.
    if (this.flavour === 'claude') {
      appendLine(this.transcriptPath, { type: 'attachment', attachment: { type: 'hook_additional_context', content: [ctx], hookName: event } });
    } else if (this.flavour === 'codex') {
      this.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: ctx }] } });
    }
    return ctx;
  }

  async toolCall(name, input, midContext) {
    if (this.flavour === 'codex') {
      const callId = `call_${uuid().slice(0, 8)}`;
      this.rollout({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify(input), call_id: callId } });
      await this.hook('PreToolUse', {});
      this.rollout({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: 'ok' } });
      const r = await this.hook('PostToolUse', {});
      if (midContext) await this.legacyHabits('', this.takeContext(r, 'PostToolUse', { midTurn: true }));
      return;
    }
    if (this.flavour === 'agy') {
      await this.hook('PreToolUse', { toolCall: { name, args: input } });
      await this.hook('PostToolUse', { toolCall: { name, args: input } });
      // AGY's context arrives before the NEXT model call (PreInvocation), not on the tool hook.
      if (midContext) await this.legacyHabits('', await this.agyPreInvocation(false));
      return;
    }
    if (this.flavour === 'gemini') {
      await this.hook('BeforeTool', { tool_name: name, tool_input: input });
      const r = await this.hook('AfterTool', { tool_name: name, tool_input: input, tool_response: { ok: true } });
      if (midContext) await this.legacyHabits('', this.takeContext(r, 'AfterTool', { midTurn: true }));
      return;
    }
    await this.hook('PreToolUse', { tool_name: name, tool_input: input });
    const r = await this.hook('PostToolUse', { tool_name: name, tool_input: input, tool_response: { stdout: 'ok' } });
    if (midContext) await this.legacyHabits('', this.takeContext(r, 'PostToolUse', { midTurn: true }));
  }

  async endTurn(how) {
    const turn = this.turn;
    if (!turn) { this.rec('turn-end', { how, turn: null }); return; }
    if (how === 'stop') {
      if (this.flavour === 'claude') await this.hook('Stop', { stop_hook_active: false });
      else if (this.flavour === 'codex') { await this.hook('Stop', { turn_id: turn.id, stop_hook_active: false }); this.rollout({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } }); }
      else if (this.flavour === 'agy') await this.hook('Stop', { fullyIdle: true });
      else if (this.flavour === 'gemini') await this.hook('AfterAgent', {});
    } else if (how === 'stop-failure') {
      await this.hook('StopFailure', { error: 'overloaded_error' });
    } else if (how === 'lost-stop' && this.flavour === 'codex') {
      this.rollout({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } });   // #45: rollout only
    }
    this.lastTurnId = turn.id;
    this.rec('turn-end', { how, turn: turn.id });
    this.turn = null;
    this.writeComposer();
    this.out('\r\n> ');
  }

  codexStaleComplete() {
    // #52: the rollout replays the PREVIOUS turn's task_complete while a new turn runs.
    if (!this.lastTurnId) { this.rec('stale-complete', { skipped: true }); return; }
    this.rollout({ type: 'event_msg', payload: { type: 'task_complete', turn_id: this.lastTurnId } });
    this.rec('stale-complete', { turn: this.lastTurnId });
  }

  async compact() {
    // Compaction: PreCompact, the "conversation" is dropped, then SessionStart(compact) re-injects.
    if (this.flavour !== 'claude') { this.rec('compact-unsupported'); return; }
    await this.hook('PreCompact', { trigger: 'manual' });
    this.seen.clear();
    this.rec('compacted');
    const r = await this.hook('SessionStart', { source: 'compact' });
    this.takeContext(r, 'SessionStart', { compact: true });
    await this.hook('PostCompact', { trigger: 'manual' });
  }

  /** Terminal work-order providers: the typed text IS the message. */
  async hooklessTurn(prompt) {
    this.turn = { id: `w${++this.turnSeq}`, prompt, startedAt: now() };
    const m = /Message: (\S+)/.exec(prompt);
    if (m) { this.seen.add(m[1]); this.rec('work-order', { id: m[1], text: prompt }); }
    await this.legacyHabits(prompt, '');
    if (this.flavour === 'qwen') await this.proxyCall(prompt);
    this.rec('turn-end', { how: 'idle', turn: this.turn.id });
    this.turn = null;
    this.writeComposer();
    this.out('\r\n> ');
  }

  async proxyCall(prompt) {
    const base = process.env.OPENAI_BASE_URL;
    if (!base || !isLoopbackUrl(base)) { this.rec('proxy-refused', { base: base ?? null }); return; }
    const body = JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: prompt.slice(0, 200) }], stream: false });
    const res = await httpPost(`${base.replace(/\/$/, '')}/chat/completions`, body, 5000);
    this.rec('proxy-call', { status: res.status, body: res.body.slice(0, 200) });
  }

  /**
   * The fake MODEL follows its instructions, which is how every mail mode reaches it:
   *  - a wake or notice that tells it to read (and move) inbox files: the legacy-read and
   *    legacy-move nudges, the degraded nudges (Creed Q27), the `<inbox-update>` notice;
   *  - the Codex wake sentinel names no file: the model then does what its start-up
   *    instructions (P1) say, reading the whole inbox only when P1 tells it to.
   * The injection-mode texts ("delivered in context below", "You do not read, list or move
   * inbox files") never make it touch a file. `scenario.obey === false` turns this off.
   */
  async legacyHabits(prompt, ctx) {
    if (this.scenario.obey === false || !this.agentDir) return;
    const text = `${prompt}\n${ctx}`;
    if (prompt.trim() === '[hive] check inbox') {
      const p1 = this.systemPrompt();
      if (/read EVERY file in/i.test(p1)) {
        this.rec('obeys', { source: 'p1', move: /move its file into/i.test(p1) });
        await this.readInbox(null, /move its file into/i.test(p1));
      }
      return;
    }
    const move = /\bmove\b[^\n]*?inbox[\\/]\.done/i.test(text);
    const read = move || /read (each|every|those) file|read those files|read your inbox|<inbox-update>/i.test(text);
    if (!read) return;
    // The ids the text names: every inbox file whose id is in it.
    let files = [];
    try { files = fs.readdirSync(path.join(this.agentDir, 'inbox')).filter((f) => f.endsWith('.json')); } catch { files = []; }
    const named = files.map((f) => f.replace(/\.json$/, '')).filter((id) => text.includes(id));
    this.rec('obeys', { source: 'text', move, named });
    if (!named.length) return;
    await this.readInbox(named, move);
  }

  /** The start-up instructions this CLI was given (P1): Claude's --append-system-prompt, Codex's
   *  developer_instructions in its config.toml, or any argv text. */
  systemPrompt() {
    const i = this.argv.indexOf('--append-system-prompt');
    const parts = [i >= 0 ? this.argv[i + 1] : '', this.argv.join(' ')];
    if (this.flavour === 'codex' && this.codexHome) parts.push(safeRead(path.join(this.codexHome, 'config.toml')));
    return parts.join('\n');
  }

  async readInbox(ids, move) {
    if (!this.agentDir) return;
    const inbox = path.join(this.agentDir, 'inbox');
    let files = [];
    try { files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json')); } catch { files = []; }
    const want = ids && ids.length ? new Set(ids.map((i) => `${i}.json`)) : null;
    for (const f of files) {
      if (want && !want.has(f)) continue;
      const body = safeRead(path.join(inbox, f));
      let msg = null;
      try { msg = JSON.parse(body); } catch { msg = null; }
      const id = msg && msg.id ? msg.id : f.replace(/\.json$/, '');
      this.seen.add(id);
      this.rec('read-file', { id, file: f });
      if (move) {
        fs.mkdirSync(path.join(inbox, '.done'), { recursive: true });
        try { fs.renameSync(path.join(inbox, f), path.join(inbox, '.done', f)); this.rec('moved-file', { id, file: f }); } catch (e) { this.rec('move-failed', { file: f, error: String(e) }); }
      }
    }
  }

  bulkMove() {
    // The old habit (F10): `mv inbox/*.json inbox/.done/`, whatever was or was not surfaced.
    if (!this.agentDir) return;
    const inbox = path.join(this.agentDir, 'inbox');
    fs.mkdirSync(path.join(inbox, '.done'), { recursive: true });
    const moved = [];
    for (const f of fs.readdirSync(inbox).filter((x) => x.endsWith('.json'))) {
      try { fs.renameSync(path.join(inbox, f), path.join(inbox, '.done', f)); moved.push(f.replace(/\.json$/, '')); } catch { /* raced */ }
    }
    this.rec('bulk-move', { ids: moved });
  }

  writeOutbox(r) {
    if (!this.agentDir) return;
    const out = path.join(this.agentDir, 'outbox');
    fs.mkdirSync(out, { recursive: true });
    const msg = { to: r.to, act: r.act || 'inform', subject: r.subject || 'reply', body: r.body || 'done' };
    if (r.id !== undefined) msg.id = r.id;
    if (r.in_reply_to !== undefined) msg.in_reply_to = r.in_reply_to;
    if (r.requires_reply !== undefined) msg.requires_reply = r.requires_reply;
    if (r.supersedes !== undefined) msg.supersedes = r.supersedes;
    const name = `${r.file || `rig-${now()}-${crypto.randomBytes(3).toString('hex')}`}.json`;
    const tmp = path.join(out, `.${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(msg));
    fs.renameSync(tmp, path.join(out, name));
    this.rec('outbox', { file: name, msg });
  }

  // ————————————————————————————————————————————————————————————— hook transports

  /** Fire one hook through this flavour's real transport. Resolves {response, transport, exit}. */
  async hook(event, extra) {
    if (this.hung) return null;
    const payload = this.payloadFor(event, extra);
    let r;
    if (this.hookMode === 'exit127' || (this.hookMode === 'ups-silent' && (event === 'UserPromptSubmit' || event === 'PreInvocation' || event === 'BeforeAgent'))) {
      // The hook command cannot run (`node: not found`, exit 127, #16) or dies before it reaches
      // the app: nothing is delivered, the CLI carries on.
      r = { transport: 'none', exit: 127, response: null };
    } else if (this.flavour === 'claude') r = await this.claudeHook(event, payload);
    else if (this.flavour === 'codex') r = await this.codexHook(event, payload);
    else if (this.flavour === 'agy') r = await this.agyHook(event, payload);
    else if (this.flavour === 'gemini') r = await this.geminiHook(event, payload);
    else r = { transport: 'none', exit: 0, response: null };
    this.rec('hook', { event, transport: r.transport, exit: r.exit, ms: r.ms, request: summarize(payload), response: r.response });
    return r;
  }

  payloadFor(event, extra) {
    const cwd = process.cwd();
    if (this.flavour === 'agy') {
      // AGY's own stdin shape (the shim normalises it).
      return { conversationId: this.sessionId, transcriptPath: this.transcriptPath, workspacePaths: [cwd], ...extra };
    }
    const p = { session_id: this.sessionId, transcript_path: this.flavour === 'codex' ? this.rolloutPath : this.transcriptPath, cwd, hook_event_name: event, ...extra };
    if (this.flavour === 'codex' && this.turn && p.turn_id === undefined && event !== 'SessionStart') p.turn_id = this.turn.id;
    return p;
  }

  async claudeHook(event, payload) {
    const entry = this.settings && this.settings.hooks && this.settings.hooks[event] && this.settings.hooks[event][0];
    const h = entry && entry.hooks && entry.hooks[0];
    if (!h) return { transport: 'unregistered', exit: 0, response: null };
    if (h.type === 'http') {
      if (!isLoopbackUrl(h.url)) return { transport: 'refused', exit: 0, response: null };
      const t0 = now();
      const res = await httpPost(h.url, JSON.stringify(payload), (h.timeout || 30) * 1000);
      return { transport: 'http', exit: res.status, ms: now() - t0, response: parseJson(res.body) };
    }
    return this.command(h.command, payload, 'command');
  }

  async codexHook(event, payload) {
    const h = this.codexConfig.hooks[event];
    if (!h) return { transport: 'unregistered', exit: 0, response: null };
    if (h.type === 'mcp_tool') {
      const url = this.codexConfig.mcpUrl;
      if (!url || !isLoopbackUrl(url)) return { transport: 'refused', exit: 0, response: null };
      const t0 = now();
      const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name: h.tool, arguments: h.input, _meta: { threadId: this.sessionId } } });
      const res = await httpPost(url, body, 30_000, { accept: 'application/json, text/event-stream' });
      const j = parseJson(res.body);
      const response = j && j.result ? (j.result.structuredContent ?? null) : null;
      return { transport: 'mcp', exit: res.status, ms: now() - t0, response };
    }
    return this.command(h.command, payload, 'command');
  }

  async agyHook(event, payload) {
    const group = this.agyHooks[event];
    if (!group || !group.length) return { transport: 'unregistered', exit: 0, response: null };
    const first = group[0];
    const h = first.hooks ? first.hooks[0] : first;   // tool events are grouped, the rest flat (Y2)
    const oneway = / agy [A-Za-z]+$/.test(h.command);
    return this.command(h.command, payload, oneway ? 'oneway' : 'command');
  }

  async geminiHook(event, payload) {
    const group = this.geminiHooks[event];
    const h = group && group[0] && group[0].hooks && group[0].hooks[0];
    if (!h) return { transport: 'unregistered', exit: 0, response: null };
    return this.command(h.command, payload, 'command');
  }

  /** Run a hook command the way the CLIs do: through the platform shell, payload on stdin. */
  command(cmd, payload, transport) {
    const t0 = now();
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const done = (exit) => { if (settled) return; settled = true; resolve({ transport, exit, ms: now() - t0, response: parseJson(out) }); };
      let child;
      try {
        child = spawn(cmd, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
      } catch { done(127); return; }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => done(127));
      child.on('close', (code) => done(code ?? 1));
      try { child.stdin.end(`${JSON.stringify(payload)}\n`); } catch { /* the child died */ }
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(124); }, 30_000).unref();
    });
  }

  /** One AGY statusline render: AGY runs the installed statusLine command with its status JSON. */
  async agyStatusline(state) {
    if (this.flavour !== 'agy') return;
    const gem = process.env.GEMINI_CLI_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.gemini');
    const s = readJson(path.join(gem, 'antigravity-cli', 'settings.json'));
    const cmd = s && s.statusLine && s.statusLine.command;
    if (!cmd) { this.rec('statusline', { state, installed: false }); return; }
    const reset = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const bucket = { remaining_fraction: 0.9, reset_time: reset, reset_in_seconds: 3600 };
    const body = {
      version: '1.0.0', agent_state: state, tool_confirmation_pending: false, model: { id: 'Gemini 3.7 Flash' },
      quota: { '3p-5h': bucket, '3p-weekly': bucket, 'gemini-5h': bucket, 'gemini-weekly': bucket },
      conversation_id: this.sessionId
    };
    const r = await this.command(cmd, body, 'statusline');
    this.rec('statusline', { state, installed: true, exit: r.exit });
  }

  rollout(obj) {
    if (!this.rolloutPath) return;
    appendLine(this.rolloutPath, { timestamp: new Date().toISOString(), ...obj });
  }
}

// ————————————————————————————————————————————————————————————— helpers

/** The context the provider hands its model, from a hook response in the provider's own contract. */
function contextOf(resp, flavour, event) {
  if (!resp || typeof resp !== 'object') return '';
  if (flavour === 'agy') {
    const steps = Array.isArray(resp.injectSteps) ? resp.injectSteps : [];
    const um = steps.map((s) => (s && typeof s.userMessage === 'string' ? s.userMessage : '')).join('\n');
    return um || (typeof resp.systemMessage === 'string' ? resp.systemMessage : '');
  }
  const h = resp.hookSpecificOutput;
  if (h && typeof h.additionalContext === 'string') return h.additionalContext;
  if (event === 'SessionStart' && typeof resp.additionalContext === 'string') return resp.additionalContext;
  return '';
}

function parseCodexConfig(text) {
  const out = { hooks: {}, mcpUrl: null };
  const mcp = /\[mcp_servers\.munder_hooks\][^[]*?url\s*=\s*"([^"]+)"/s.exec(text);
  if (mcp) out.mcpUrl = mcp[1];
  const re = /\[\[hooks\.([A-Za-z]+)\.hooks\]\]\n([\s\S]*?)(?=\n\[|\n#|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const [, event, body] = m;
    const type = /type\s*=\s*"([^"]+)"/.exec(body);
    if (!type) continue;
    if (type[1] === 'command') {
      const c = /command\s*=\s*'([^']*)'/.exec(body) || /command\s*=\s*"([^"]*)"/.exec(body);
      if (c) out.hooks[event] = { type: 'command', command: c[1] };
    } else if (type[1] === 'mcp_tool') {
      const tool = /tool\s*=\s*"([^"]+)"/.exec(body);
      const ev = /event\s*=\s*"([^"]+)"/.exec(body);
      const k = /k\s*=\s*"([^"]+)"/.exec(body);
      out.hooks[event] = { type: 'mcp_tool', tool: tool ? tool[1] : '', input: { event: ev ? ev[1] : event, k: k ? k[1] : '' } };
    }
  }
  return out;
}

function httpPost(url, body, timeoutMs, headers = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, body: '' }); return; }
    const req = http.request({ hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      res.on('error', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end(body);
  });
}

function summarize(p) {
  const o = { ...p };
  for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].length > 400) o[k] = `${o[k].slice(0, 400)}…`;
  return o;
}

/** See start(): the host looks for it in the PTY stream (rig-host bootSeen). */
const BOOT_SENTINEL = '[rig-boot-complete]';

function pickEnv() {
  const keys = ['AGENT_ID', 'HIVE_ROOT', 'HIVE_SOCK', 'CODEX_HOME', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'HOME', 'USERPROFILE', 'OPENAI_BASE_URL', 'HIVE_PROXY_SESSION'];
  const o = {};
  for (const k of keys) if (process.env[k] !== undefined) o[k] = process.env[k];
  return o;
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const safeRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const parseJson = (s) => { if (!s || !s.trim()) return null; try { return JSON.parse(s); } catch { return null; } };
const appendLine = (p, obj) => { try { fs.appendFileSync(p, `${JSON.stringify(obj)}\n`); } catch { /* best effort */ } };
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { main, parseCodexConfig, contextOf };
