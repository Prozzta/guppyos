/**
 * HOOK-BROKER P3 (Jim's spike, god's go): Codex's high-volume hooks (PreToolUse/PostToolUse)
 * as `mcp_tool` hooks into the in-app MCP endpoint instead of cold-starting the shim (2
 * processes, ~450 ms each). Measured by the spike: 0 processes, 2-4 ms, 0 model tokens.
 *
 * The catch: an `mcp_tool` hook receives only its STATIC `input` table and `_meta.threadId`,
 * not the hook payload (no tool_name, tool_input, turn_id). Codex has already written the
 * payload to the rollout by the time the hook runs (the pending tool call lands ~25 ms before
 * PreToolUse), so the payload is rebuilt from a bounded rollout tail. What cannot be found is
 * delivered as DEGRADED, and the gates treat that conservatively (hooks.ts).
 *
 * Pure helpers here; the route lives in HookServer.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTail } from './codexRolloutCapacity';

export const MCP_SERVER_NAME = 'munder_hooks';
export const HIVE_HOOK_TOOL = 'hive_hook';
/** The only events routed through mcp_tool; every other Codex hook keeps the command shim. */
export const MCP_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export type McpHookEvent = typeof MCP_HOOK_EVENTS[number];
/** The rollout tail read for one hook (the same bound as the lifecycle probe). */
export const MCP_HOOK_TAIL_BYTES = 64 * 1024;

export interface RebuiltToolHook {
  turnId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  callId?: string;
  degraded: boolean;
}

const CALL_TYPES = new Set(['custom_tool_call', 'function_call', 'local_shell_call']);
const OUTPUT_TYPES = new Set(['custom_tool_call_output', 'function_call_output', 'local_shell_call_output']);

function toolInputOf(p: Record<string, unknown>): unknown {
  if (typeof p.input === 'string') return { input: p.input };
  if (typeof p.arguments === 'string') {
    try { return JSON.parse(p.arguments); } catch { return { arguments: p.arguments }; }
  }
  if (p.action !== undefined) return p.action;
  return {};
}

/** The balanced `{...}` starting at `from` (string-aware), or null. */
function objectSpan(src: string, from: number): string | null {
  if (src[from] !== '{') return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return src.slice(from, i + 1);
  }
  return null;
}

const EXEC_COMMAND_CALL = /\btools\s*\.\s*exec_command\s*\(\s*/;

/**
 * HEAVY-LOCK-UNNAMED-EXEC (Jim F1, S1): the nested calls whose argument is shell input, for the
 * heavy-job HINT only (naming for a gate keeps EXEC_COMMAND_CALL): `tools.exec_command(`,
 * `tools?.exec_command(`, `tools["exec_command"](`, and the same for `write_stdin` (text typed
 * into a running exec session, often a shell). Group 1 or 3 is the tool; group 1 = dotted form.
 */
const SHELL_INPUT_CALL = /\btools\s*(?:\?\.|\.)\s*(exec_command|write_stdin)\s*\(\s*|\btools\s*\[\s*(['"`])(exec_command|write_stdin)\2\s*\]\s*\(\s*/;

/**
 * HEAVY-LOCK-UNNAMED-EXEC (Jim S3): `src` with comment text and string/template CONTENTS blanked
 * (same length, the quotes kept), so a tool name inside a literal command or a comment is not a
 * call or a mention. A template's `${...}` is blanked with it; regex literals are not tracked.
 */
function codeMask(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const e = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : src[i + 1] === '/' ? e : e + 2;
      out += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
      const end = Math.min(j, src.length);
      out += c + ' '.repeat(end - i - 1) + (j < src.length ? c : '');
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * HEAVY-LOCK-UNNAMED-EXEC: the value of top-level property `key` of the object literal `span`
 * when it is ONE double-quoted (JSON) string and nothing else (`"a" + b` is not), whatever the
 * other values are (`{session_id: r.session_id, chars: "..."}`); null when the key is plainly
 * ABSENT (no such key, no `...spread`: a write_stdin poll); else undefined (not readable).
 */
function literalProp(span: string, key: string): string | null | undefined {
  const code = codeMask(span);
  const re = /[{,]\s*(?:([A-Za-z_$][\w$]*)|"([A-Za-z_$][\w$]*)")\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(span))) {
    if (code[m.index] !== span[m.index] || (m[1] ?? m[2]) !== key) continue;
    const pre = code.slice(0, m.index + 1);
    if ((pre.match(/\{/g) ?? []).length - (pre.match(/\}/g) ?? []).length !== 1) continue;
    const i = m.index + m[0].length;
    if (span[i] !== '"') return undefined;
    let j = i + 1;
    while (j < span.length && span[j] !== '"') { if (span[j] === '\\') j += 1; j += 1; }
    let k = j + 1;
    while (k < span.length && /\s/.test(span[k])) k += 1;
    if (span[k] !== ',' && span[k] !== '}') return undefined;
    try { const v: unknown = JSON.parse(span.slice(i, j + 1)); return typeof v === 'string' ? v : undefined; } catch { return undefined; }
  }
  // Absent only if nothing could hold it: no spread, no shorthand `{chars}`, no quoted key.
  if (code.includes('...') || new RegExp(`\\b${key}\\b`).test(code) || new RegExp(`["'\`]${key}["'\`]\\s*:`).test(span)) return undefined;
  return null;
}

/**
 * HEAVY-JOB-LOCK-FAILOPEN (c): Codex 0.157.1 writes the nested call's argument as a JS OBJECT
 * LITERAL with bare keys, `tools.exec_command({cmd:"npm ci",workdir:"C:\\w",yield_time_ms:30000})`,
 * not JSON. JSON.parse refused it, so EVERY Codex exec hook arrived DEGRADED: unclassifiable, the
 * heavy-job lock let it through ('degraded', tool null, on every call). Accepted now: bare
 * identifier KEYS are quoted; VALUES must still be JSON (a double-quoted string, a number, true,
 * false, null, an array or object of those). A computed value (`{ cmd: c }`), a template or a
 * single-quoted string still fails: not nameable honestly, as before.
 */
export function relaxedObjectLiteral(src: string): unknown {
  let out = '';
  let last = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j += 1; j += 1; }
      out += src.slice(i, j + 1);
      i = j;
      last = '"';
      continue;
    }
    if (c === "'" || c === '`') throw new Error('not a JSON-valued literal');
    if (/[A-Za-z_$]/.test(c) && (last === '{' || last === ',')) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k += 1;
      if (src[k] === ':') { out += `"${src.slice(i, j)}"`; i = j - 1; last = 'key'; continue; }
    }
    out += c;
    if (!/\s/.test(c)) last = c;
  }
  return JSON.parse(out);
}

/**
 * HEAVY-JOB-LOCK-FAILOPEN (c): the shell commands the CURRENT turn's pending call(s) will run, for
 * the heavy-job classifier only, when the hook itself must stay DEGRADED (two parallel calls, an
 * exec with several nested commands). Never used to NAME a tool for a gate. `complete` is false
 * when a command could not be read (computed, templated): the hint is then partial.
 * HEAVY-LOCK-UNNAMED-EXEC: `unnamed` counts the code-mode shell-input calls not read, for the
 * heavy-job lock's log row: an exec_command `cmd` or write_stdin `chars` that is not a literal,
 * any other mention of either name in code (an alias `t.exec_command(`, a destructuring), and a
 * computed tool `tools[n](`. Literal write_stdin `chars` (trailing newline trimmed; an empty poll
 * skipped) are hints like any command (Jim F1). Strings and comments never count (S3).
 */
export function pendingExecCommands(tail: string): { commands: string[]; complete: boolean; unnamed: number } {
  const lines = tail.split('\n');
  let turnSeen = false;
  const outputs = new Set<string>();
  const pending: Array<Record<string, unknown>> = [];
  for (let i = lines.length - 1; i >= 0 && !turnSeen; i--) {
    let j: { type?: unknown; payload?: Record<string, unknown> };
    try { j = JSON.parse(lines[i]); } catch { continue; }
    const p = j.payload;
    if (!p || typeof p !== 'object') continue;
    if ((j.type === 'turn_context' && typeof p.turn_id === 'string') || (j.type === 'event_msg' && p.type === 'task_started')) { turnSeen = true; continue; }
    if (j.type !== 'response_item' || typeof p.type !== 'string') continue;
    const callId = typeof p.call_id === 'string' ? p.call_id : '';
    if (OUTPUT_TYPES.has(p.type) && callId) outputs.add(callId);
    else if (CALL_TYPES.has(p.type) && callId && !outputs.has(callId)) pending.push(p);
  }
  const commands: string[] = [];
  let complete = true;
  let unnamed = 0;
  for (const p of pending) {
    if (p.name === 'exec' && typeof p.input === 'string') {
      const src = p.input;
      const code = codeMask(src);
      const re = new RegExp(SHELL_INPUT_CALL.source, 'g');
      let m: RegExpExecArray | null;
      let dotted = 0;
      while ((m = re.exec(src))) {
        if (code[m.index] !== 't') continue; // inside a string or a comment: not a call
        if (m[1]) dotted += 1;
        const stdin = (m[1] ?? m[3]) === 'write_stdin';
        const span = objectSpan(src, m.index + m[0].length);
        const v = span ? literalProp(span, stdin ? 'chars' : 'cmd') : undefined;
        if (v === null && stdin) continue; // a write_stdin with no chars: a poll, nothing typed
        if (typeof v !== 'string') { complete = false; unnamed += 1; continue; }
        const c = stdin ? v.replace(/[\r\n]+$/, '') : v;
        if (c) commands.push(c);
      }
      // An alias or destructuring names the tool without a readable call.
      const other = (code.match(/\b(?:exec_command|write_stdin)\b/g) ?? []).length - dotted;
      if (other > 0) { complete = false; unnamed += other; }
      // A computed tool name: `tools[n](`, `tools["exec" + "_command"](` (a literal name is not).
      const br = /\btools\s*\[/g;
      while ((m = br.exec(code))) {
        if (!/^tools\s*\[\s*(['"`])[\w$]+\1\s*\]/.test(src.slice(m.index))) { complete = false; unnamed += 1; }
      }
    } else if (typeof p.arguments === 'string') {
      let a: { cmd?: unknown; command?: unknown; chars?: unknown } | null = null;
      try { a = JSON.parse(p.arguments); } catch { a = null; }
      const c = p.name === 'write_stdin' ? (typeof a?.chars === 'string' ? a.chars.replace(/[\r\n]+$/, '') || undefined : undefined) : a?.cmd ?? a?.command;
      if (typeof c === 'string') commands.push(c);
      else if (Array.isArray(c) && c.every((x) => typeof x === 'string')) commands.push(c.join(' '));
    } else if (p.action && typeof p.action === 'object' && Array.isArray((p.action as { command?: unknown }).command)) {
      commands.push(((p.action as { command: unknown[] }).command).map(String).join(' '));
    }
  }
  return { commands, complete, unnamed };
}

/**
 * A1 (Jim): Codex's `exec` tool is a JS program that calls nested tools, and Codex's COMMAND
 * hooks report each nested `tools.exec_command({cmd})` as tool_name "Bash", tool_input
 * {command: cmd}. Gates and the breaker match on that, so the rebuilt payload must too.
 * Normalised only when the program makes exactly ONE nested call, it is exec_command, and its
 * argument is a plain JSON object with a string `cmd` (so the command is exactly what runs).
 * Anything else (0 or several nested calls, another tool, an alias of `tools`, a computed
 * command) cannot be named honestly: null, and the caller delivers DEGRADED (a gate fails closed).
 */
export function normaliseCodexExec(program: string): { toolName: 'Bash'; toolInput: { command: string } } | null {
  const m = EXEC_COMMAND_CALL.exec(program);
  if (!m) return null;
  const argAt = m.index + m[0].length;
  const span = objectSpan(program, argAt);
  if (!span) return null;
  let arg: unknown;
  try { arg = relaxedObjectLiteral(span); } catch { return null; }
  const cmd = (arg as { cmd?: unknown } | null)?.cmd;
  if (typeof cmd !== 'string') return null;
  // With the argument taken out, `tools` must appear exactly once (this call): a second nested
  // call, another tool, or an alias (`const t = tools`) is not nameable.
  const rest = program.slice(0, argAt) + program.slice(argAt + span.length);
  if ((rest.match(/\btools\b/g) ?? []).length !== 1) return null;
  return { toolName: 'Bash', toolInput: { command: cmd } };
}

/** The name/input a hook reports for a rollout call, Codex-command-hook compatible. */
function describeCall(p: Record<string, unknown>): { toolName?: string; toolInput: unknown; degraded: boolean } {
  if (typeof p.name !== 'string') return { toolInput: toolInputOf(p), degraded: true };
  if (p.name === 'exec' && typeof p.input === 'string') {
    const n = normaliseCodexExec(p.input);
    return n ? { ...n, degraded: false } : { toolInput: toolInputOf(p), degraded: true };
  }
  return { toolName: p.name, toolInput: toolInputOf(p), degraded: false };
}

/**
 * Rebuild a Codex tool hook's payload from the rollout tail.
 *  - turn_id: the newest turn_context / task_started turn (never task_complete: at a tool
 *    hook the turn is running, and a completion is the PREVIOUS turn's).
 *  - PreToolUse: the newest tool call that has no output after it (the pending one), counted
 *    only within the CURRENT turn: a call an earlier, aborted turn never answered is not pending
 *    (it would make every later PreToolUse ambiguous until it scrolled out; Jim N-P3a).
 *  - PostToolUse: the newest tool output, joined to its call by call_id.
 */
export function rebuildToolHook(tail: string, event: McpHookEvent): RebuiltToolHook {
  const lines = tail.split('\n');
  let turnId: string | undefined;
  const outputs = new Map<string, unknown>();
  let pending: Record<string, unknown> | null = null;
  let newestCall: Record<string, unknown> | null = null;
  /** Calls seen before (newer than) the newest turn marker: this turn's. */
  const turnCalls = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let j: { type?: unknown; payload?: Record<string, unknown> };
    try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload;
    if (!p || typeof p !== 'object') continue;
    if (turnId === undefined) {
      if (j.type === 'turn_context' && typeof p.turn_id === 'string') turnId = p.turn_id;
      else if (j.type === 'event_msg' && p.type === 'task_started' && typeof p.turn_id === 'string') turnId = p.turn_id;
    }
    if (j.type !== 'response_item' || typeof p.type !== 'string') continue;
    const callId = typeof p.call_id === 'string' ? p.call_id : '';
    if (OUTPUT_TYPES.has(p.type) && callId) {
      if (!outputs.has(callId)) outputs.set(callId, p.output);
    } else if (CALL_TYPES.has(p.type) && callId) {
      if (!newestCall) newestCall = p;
      const inTurn = turnId === undefined;
      if (inTurn) turnCalls.add(callId);
      if (!pending && inTurn && !outputs.has(callId)) pending = p;
    }
  }
  if (event === 'PreToolUse') {
    if (!pending) return { turnId, degraded: true };
    // Two or more calls still pending (parallel tool calls): which one this hook is for is not
    // knowable from the rollout, so no name is claimed (a gate then fails closed if active).
    let open = 0;
    for (const id of turnCalls) if (!outputs.has(id)) open += 1;
    if (open >= 2) return { turnId, degraded: true };
    const d = describeCall(pending);
    return d.degraded ? { turnId, degraded: true } : { turnId, toolName: d.toolName, toolInput: d.toolInput, callId: pending.call_id as string, degraded: false };
  }
  // PostToolUse runs as soon as the tool returns, and Codex writes the tool's OUTPUT item a
  // moment later (measured on the TUI: absent at the hook). Hooks run in order, so the newest
  // call is the one that just finished: use it, with its output when it is already there.
  const newest = newestCall;
  if (!newest) return { turnId, degraded: true };
  const newestId = newest.call_id as string;
  const response = outputs.get(newestId);
  const d = describeCall(newest);
  if (d.degraded) return { turnId, degraded: true };
  return {
    turnId,
    toolName: d.toolName,
    toolInput: d.toolInput,
    ...(response !== undefined ? { toolResponse: response } : {}),
    callId: newestId,
    degraded: false
  };
}

/** A per-home cache of threadId -> rollout path (a rollout's file name ends in its thread id). */
export class CodexThreadRollouts {
  private cache = new Map<string, string>();

  find(codexHome: string, threadId: string): string | null {
    if (!/^[0-9a-f-]{8,}$/i.test(threadId)) return null;
    const key = `${codexHome}|${threadId}`;
    const hit = this.cache.get(key);
    if (hit) { try { statSync(hit); return hit; } catch { this.cache.delete(key); } }
    const suffix = `-${threadId}.jsonl`;
    const walk = (dir: string, depth: number): string | null => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return null; }
      // Newest first: sessions/YYYY/MM/DD sort lexically.
      for (const n of names.sort().reverse()) {
        const p = join(dir, n);
        if (n.endsWith(suffix)) return p;
        if (depth < 3 && /^\d+$/.test(n)) { const f = walk(p, depth + 1); if (f) return f; }
      }
      return null;
    };
    const found = walk(join(codexHome, 'sessions'), 0);
    if (found) this.cache.set(key, found);
    return found;
  }

  tail(path: string): string {
    return readTail(path, MCP_HOOK_TAIL_BYTES);
  }
}

/** Seconds a Codex MCP hook may take. A healthy one takes 2-4 ms; this only bounds a server that
 *  is connected but hung. (A server that is DOWN fails open in ~2 s per hook regardless: that is
 *  Codex's MCP client, not this timeout; see the re-listen in hooks.ts.) */
export const MCP_HOOK_TIMEOUT_S = 5;

/** The per-agent Codex config lines for the MCP-routed hooks (TOML). */
export function codexMcpHookToml(url: string, token: string): { server: string; hook: (event: McpHookEvent) => string } {
  return {
    server: `\n[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${url}"\ntool_timeout_sec = ${MCP_HOOK_TIMEOUT_S}\n`,
    hook: (event) => `\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "mcp_tool"\nserver = "${MCP_SERVER_NAME}"\ntool = "${HIVE_HOOK_TOOL}"\ninput = { event = "${event}", k = "${token}" }\ntimeout = ${MCP_HOOK_TIMEOUT_S}\n`
  };
}
