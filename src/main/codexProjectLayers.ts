/**
 * CODEX-TRUST-LAYER (1.1.76; design `CODEX-TRUST-LAYER.md` rev 2, Jim's review R1-R3, the Human's
 * ruling: B, refuse plus a one-click opt-in per folder in a harness allowlist; A where the user's
 * own codex trust list trusts the layer).
 *
 * Our trust seed (codexTrustSeed.ts) trusts every Codex agent's exact cwd, and a trusted folder
 * loads its project `.codex` layers. A layer can carry code that runs with no review: its MCP
 * servers start as soon as the agent starts, and its hooks run on the agent's first turn (Jim's
 * test 12, R1), because every hive spawn passes --dangerously-bypass-hook-trust; in auto mode
 * both run unsandboxed. This module is the PURE detector: which `.codex` layers codex 0.157.1
 * would load for a cwd, why each is trusted (our seed only, or the user's own list), and what
 * each carries. The spawn (hive.ts installCodexHooks) turns that into a decision.
 *
 * What codex 0.157.1 does (codex-rs at rust-v0.157.1):
 *  - discovery config = system config.toml + the user config (the agent's generated one) +
 *    managed config (config/src/loader/local.rs:111-139). On Windows the system file is
 *    %ProgramData%\OpenAI\Codex\config.toml (loader/mod.rs:798-818) and CODEX_HOME's
 *    managed_config.toml is ignored (layer_io.rs:64-99); elsewhere /etc/codex/config.toml and
 *    /etc/codex/managed_config.toml (layer_io.rs:22).
 *  - project root: the nearest ancestor holding a `project_root_markers` entry (default `.git`;
 *    a `.git` directory without HEAD is skipped, a `.git` file counts; `[]` means the cwd)
 *    (loader/mod.rs:1490-1526).
 *  - layers: every dir from that root down to the cwd whose `.codex` is a directory and is not
 *    CODEX_HOME (loader/mod.rs:1638-1676).
 *  - trust per dir: the dir key, then the project-root key, then the repo-root key
 *    (loader/mod.rs:1041-1084); only `trusted` loads a layer. A trusted layer whose config.toml
 *    does not parse makes codex exit (:1693-1704).
 *  - linked worktrees: hooks (config.toml `hooks` AND hooks.json) come from the MAIN checkout's
 *    `<rel>/.codex` (:1106-1116, :1774-1796; hooks/src/engine/discovery.rs:129-148), everything
 *    else (mcp_servers, rules) from the worktree's own `.codex` (config/src/state.rs:233-243).
 *  - what runs or grants: `hooks`, `hooks.json`, `mcp_servers`, `rules/*.rules` (exec policy).
 *    `notify` and the model-provider keys are denied in project layers (loader/mod.rs:87-100).
 *
 * Fail closed everywhere: what cannot be read or resolved counts as code that runs (EXECUTE),
 * and a codex other than the modelled 0.157.1 with a `.codex` present is `unknown`, which counts
 * as EXECUTE too. A wrong "the user trusts it" is the dangerous error, so user trust is only
 * ever claimed from an entry that really matches.
 */
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { asciiLower, sameCodexProjectKey } from './codexTrustSeed';

/** The codex version this model of the loader was checked against. */
export const CODEX_LAYER_MODEL_VERSION = '0.157.1';

// ── a small TOML reader (enough to read what codex reads; throws on what codex would reject) ──

export class TomlError extends Error {}
type TomlTable = { [k: string]: unknown };
const isTable = (v: unknown): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse TOML text into plain objects. Strings (all four forms), arrays, inline tables, tables,
 * arrays of tables and dotted keys are real; other scalars (numbers, booleans, dates) are kept
 * as their raw text, so a malformed number is NOT caught here (codex would then reject the file;
 * the only cost is a missed "does not parse" note, never a missed hook). Redefining a key or a
 * table is an error, as in TOML.
 */
export function parseToml(text: string): TomlTable {
  const s = text.replace(/\r\n/g, '\n');
  let i = 0;
  let line = 1;
  const root: TomlTable = {};
  const defined = new WeakSet<object>();   // tables defined by a [header] or a key path
  const inlineOrValue = new WeakSet<object>(); // inline tables / static arrays: closed to extension
  let current: TomlTable = root;
  const fail = (m: string): never => { throw new TomlError(`line ${line}: ${m}`); };
  const peek = (): string => s[i] ?? '';
  const ws = (): void => { while (peek() === ' ' || peek() === '\t') i++; };
  const wsNl = (): void => {
    for (;;) {
      ws();
      if (peek() === '#') { while (i < s.length && s[i] !== '\n') i++; }
      if (peek() === '\n') { i++; line++; continue; }
      return;
    }
  };
  const endOfLine = (): void => {
    ws();
    if (peek() === '#') while (i < s.length && s[i] !== '\n') i++;
    if (i < s.length && s[i] !== '\n') fail(`unexpected ${JSON.stringify(s.slice(i, i + 12))}`);
  };
  const basicEscape = (): string => {
    const c = s[i++];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\u001b' };
    if (c in simple) return simple[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const h = s.slice(i, i + n);
      if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(h)) fail('bad unicode escape');
      i += n;
      const cp = parseInt(h, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('bad unicode scalar');
      return String.fromCodePoint(cp);
    }
    return fail(`bad escape \\${c ?? ''}`);
  };
  const str = (): string => {
    if (s.startsWith('"""', i)) {
      i += 3; if (peek() === '\n') { i++; line++; }
      let out = '';
      for (;;) {
        if (i >= s.length) fail('unterminated """ string');
        if (s.startsWith('"""', i)) {
          let q = 3; while (s[i + q] === '"' && q < 5) q++;
          out += '"'.repeat(q - 3); i += q; return out;
        }
        const c = s[i++];
        if (c === '\n') { line++; out += c; continue; }
        if (c === '\\') {
          if (/^[ \t]*\n/.test(s.slice(i))) { while (/[ \t\n]/.test(peek())) { if (peek() === '\n') line++; i++; } continue; }
          out += basicEscape(); continue;
        }
        out += c;
      }
    }
    if (s.startsWith("'''", i)) {
      i += 3; if (peek() === '\n') { i++; line++; }
      const end = s.indexOf("'''", i);
      if (end < 0) fail("unterminated ''' string");
      let e = end; while (s[e + 3] === "'" && e - end < 2) e++;
      const out = s.slice(i, e);
      line += (out.match(/\n/g) || []).length;
      i = e + 3; return out;
    }
    if (peek() === '"') {
      i++; let out = '';
      for (;;) {
        const c = s[i++];
        if (c === undefined || c === '\n') fail('unterminated string');
        if (c === '"') return out;
        if (c === '\\') { out += basicEscape(); continue; }
        out += c;
      }
    }
    if (peek() === "'") {
      i++; const end = s.indexOf("'", i);
      const nl = s.indexOf('\n', i);
      if (end < 0 || (nl >= 0 && nl < end)) fail('unterminated literal string');
      const out = s.slice(i, end); i = end + 1; return out;
    }
    return fail('expected a string');
  };
  const keyPart = (): string => {
    ws();
    if (peek() === '"' || peek() === "'") {
      if (s.startsWith('"""', i) || s.startsWith("'''", i)) fail('a key cannot be multi-line');
      return str();
    }
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
    if (!m) fail('expected a key');
    i += m![0].length; return m![0];
  };
  const keyPath = (): string[] => {
    const parts = [keyPart()];
    for (;;) { ws(); if (peek() !== '.') return parts; i++; parts.push(keyPart()); }
  };
  const value = (): unknown => {
    ws();
    const c = peek();
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++; const arr: unknown[] = [];
      for (;;) {
        wsNl();
        if (peek() === ']') { i++; break; }
        arr.push(value());
        wsNl();
        if (peek() === ',') { i++; continue; }
        if (peek() === ']') { i++; break; }
        fail('expected , or ] in an array');
      }
      inlineOrValue.add(arr);
      return arr;
    }
    if (c === '{') {
      i++; const t: TomlTable = {};
      ws();
      if (peek() === '}') { i++; inlineOrValue.add(t); return t; }
      for (;;) {
        const kp = keyPath(); ws();
        if (peek() !== '=') fail('expected = in an inline table');
        i++;
        assign(t, kp, value(), true);
        ws();
        if (peek() === ',') { i++; continue; }
        if (peek() === '}') { i++; break; }
        fail('expected , or } in an inline table');
      }
      inlineOrValue.add(t);
      return t;
    }
    const m = /^[A-Za-z0-9_:.+\-]+(?:[ T][0-9:.+\-Z]+)?/.exec(s.slice(i));
    if (!m) return fail('expected a value');
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0];
  };
  const assign = (table: TomlTable, kp: string[], v: unknown, inInline = false): void => {
    let t = table;
    for (const part of kp.slice(0, -1)) {
      const next = t[part];
      if (next === undefined) { const n: TomlTable = {}; t[part] = n; defined.add(n); t = n; continue; }
      if (!isTable(next) || (inlineOrValue.has(next) && !inInline)) fail(`key ${part} is already a value`);
      t = next as TomlTable;
    }
    const last = kp[kp.length - 1];
    if (last in t) fail(`key ${kp.join('.')} is defined twice`);
    t[last] = v;
  };
  const tableAt = (kp: string[], arrayOfTables: boolean): TomlTable => {
    let t = root;
    kp.forEach((part, idx) => {
      const isLast = idx === kp.length - 1;
      let next = t[part];
      if (isLast && arrayOfTables) {
        if (next === undefined) { next = []; t[part] = next; }
        if (!Array.isArray(next) || inlineOrValue.has(next)) fail(`${kp.join('.')} is not an array of tables`);
        const n: TomlTable = {}; (next as unknown[]).push(n); t = n; return;
      }
      if (next === undefined) { const n: TomlTable = {}; t[part] = n; t = n; if (isLast) defined.add(n); return; }
      if (Array.isArray(next) && !inlineOrValue.has(next) && !isLast) { t = next[next.length - 1] as TomlTable; return; }
      if (!isTable(next) || inlineOrValue.has(next)) fail(`${kp.join('.')} redefines a value`);
      if (isLast) { if (defined.has(next as TomlTable)) fail(`table ${kp.join('.')} is defined twice`); defined.add(next as TomlTable); }
      t = next as TomlTable;
    });
    return t;
  };
  for (;;) {
    wsNl();
    if (i >= s.length) break;
    if (peek() === '[') {
      const aot = s.startsWith('[[', i);
      i += aot ? 2 : 1;
      const kp = keyPath(); ws();
      if (!s.startsWith(aot ? ']]' : ']', i)) fail('expected ] to close a table header');
      i += aot ? 2 : 1;
      current = tableAt(kp, aot);
      endOfLine();
      continue;
    }
    const kp = keyPath(); ws();
    if (peek() !== '=') fail('expected = after a key');
    i++;
    assign(current, kp, value());
    endOfLine();
  }
  return root;
}

// ── the loader model ─────────────────────────────────────────────────────────────────────────

export interface LayerFs {
  statSync: (p: string) => { isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
  readFileSync: (p: string, e: 'utf8') => string;
  readdirSync: (p: string) => string[];
}
const realFs: LayerFs = {
  statSync: (p) => nodeFs.statSync(p),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  readdirSync: (p) => nodeFs.readdirSync(p)
};

export type LayerTrust = 'seed' | 'user';

export interface CodexLayerFinding {
  /** The `.codex` folder of this layer. */
  dotCodex: string;
  /** Why it loads: only because of our seed, or because the user's own list (or system/managed
   *  config) trusts it. */
  trust: LayerTrust;
  /** The user's own `untrusted` entry that our seed overrides (T6), if any. */
  userUntrustedKey?: string;
  /** Code that runs or command policy that applies, as `file: what`. */
  execute: string[];
  /** Confinement keys (moot in auto mode; logged). */
  confine: string[];
  /** Files that do not parse. */
  parse: string[];
  /** Linked worktree: where this layer's hooks come from (the main checkout's `.codex`). */
  hooksFrom?: string;
}

export interface CodexLayerReport {
  layers: CodexLayerFinding[];
  /** Why the model could not be applied (an unmodelled codex version, unreadable discovery
   *  config, an unresolvable worktree): the layers found then all count as EXECUTE. */
  unknown: string[];
  /** Managed config was present (it can change markers and trust). */
  managedConfig: boolean;
  /** The folder a person means by "this project": the cwd, or for a linked worktree the same
   *  path in its main checkout (so an opt-in covers every worktree of that project). */
  projectFolder: string;
}

export interface CodexLayerInput {
  cwd: string;
  /** The agent's generated config.toml WITHOUT our cwd trust entry (the user's own list, or
   *  none in DEV) and WITH it. The difference is what "only our seed trusts it" means. */
  configBeforeSeed: string;
  configAfterSeed: string;
  /** The agent's CODEX_HOME (a `.codex` equal to it is not a project layer). */
  codexHome: string;
  /** The codex CLI version this agent gets (null when unknown). */
  codexVersion: string | null;
  platform?: NodeJS.Platform;
  fs?: LayerFs;
  /** Windows %ProgramData% (default: the env, then C:\ProgramData). */
  programData?: string;
  /** The user's own codex home (default ~/.codex). An agent whose cwd is the user's home sees
   *  it as a project layer; its content is the user's own global config (the one our agent
   *  config is seeded from), so it counts as user-trusted (A: start with a warning), not ours. */
  userCodexHome?: string;
}

const CONFINE_KEYS = ['sandbox_mode', 'approval_policy', 'sandbox_workspace_write', 'permissions', 'default_permissions', 'shell_environment_policy'];
const stripVerbatim = (p: string): string => p.replace(/^\\\\\?\\(?!UNC\\)/, '');

type TrustLevel = 'trusted' | 'untrusted' | 'other';
interface TrustMap { entries: Array<{ key: string; level: TrustLevel }> }

function projectsOf(cfg: TomlTable): TrustMap {
  const entries: TrustMap['entries'] = [];
  const projects = cfg.projects;
  if (isTable(projects)) {
    for (const [key, v] of Object.entries(projects)) {
      if (!isTable(v)) continue;
      const t = v.trust_level;
      entries.push({ key, level: t === 'trusted' ? 'trusted' : t === 'untrusted' ? 'untrusted' : 'other' });
    }
  }
  return { entries };
}

/** Merge b over a, as codex's merge_toml_values (tables merge, everything else replaces). */
function mergeToml(a: TomlTable, b: TomlTable): TomlTable {
  const out: TomlTable = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isTable(v) && isTable(out[k]) ? mergeToml(out[k] as TomlTable, v) : v;
  return out;
}

/**
 * The layers codex 0.157.1 would load for this cwd, with why and what. Never throws: whatever
 * cannot be read or resolved is reported (as EXECUTE or in `unknown`).
 */
export function codexProjectLayers(input: CodexLayerInput): CodexLayerReport {
  const platform = input.platform ?? process.platform;
  const fs = input.fs ?? realFs;
  const P = platform === 'win32' ? win32 : posix;
  const unknown: string[] = [];
  const stat = (p: string): { dir: boolean; file: boolean; symlink: boolean } | null => {
    try { const st = fs.statSync(p); return { dir: st.isDirectory(), file: st.isFile(), symlink: !!st.isSymbolicLink?.() }; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw e;
    }
  };
  const safeStat = (p: string, what: string): ReturnType<typeof stat> | 'error' => {
    try { return stat(p); } catch (e) { unknown.push(`${what} ${p} could not be read (${(e as Error).message})`); return 'error'; }
  };
  const readToml = (p: string): { cfg: TomlTable | null; error: string | null; missing: boolean } => {
    let text: string;
    try { text = fs.readFileSync(p, 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { cfg: null, error: null, missing: true };
      return { cfg: null, error: `could not be read (${(e as Error).message})`, missing: false };
    }
    try { return { cfg: parseToml(text), error: null, missing: false }; }
    catch (e) { return { cfg: null, error: (e as Error).message, missing: false }; }
  };

  const cwd = P.resolve(stripVerbatim(input.cwd));
  // 1. The discovery config: system + the agent's generated config + managed (unix only).
  const systemFile = platform === 'win32'
    ? P.join(input.programData ?? process.env.ProgramData ?? 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml')
    : '/etc/codex/config.toml';
  const managedFile = platform === 'win32' ? null : '/etc/codex/managed_config.toml';
  const sys = readToml(systemFile);
  if (sys.error) unknown.push(`the system codex config ${systemFile} ${sys.error}`);
  const managed = managedFile ? readToml(managedFile) : { cfg: null, error: null, missing: true };
  if (managed.error) unknown.push(`the managed codex config ${managedFile} ${managed.error}`);
  const parseAgent = (text: string, which: string): TomlTable => {
    try { return parseToml(text); } catch (e) { unknown.push(`the agent's generated config (${which}) does not parse: ${(e as Error).message}`); return {}; }
  };
  const discovery = (agentText: string, which: string): TomlTable => {
    let d = mergeToml(sys.cfg ?? {}, parseAgent(agentText, which));
    if (managed.cfg) d = mergeToml(d, managed.cfg);
    return d;
  };
  const before = discovery(input.configBeforeSeed, 'before the seed');
  const after = discovery(input.configAfterSeed, 'after the seed');

  // 2-3. Markers and the project root.
  let markers: string[] | null = ['.git'];
  const rawMarkers = after.project_root_markers;
  if (rawMarkers !== undefined) {
    if (Array.isArray(rawMarkers) && rawMarkers.every((m) => typeof m === 'string')) markers = rawMarkers as string[];
    else { unknown.push('project_root_markers is not a list of strings'); markers = null; }
  }
  const ancestors: string[] = [];
  for (let d = cwd; ; d = P.dirname(d)) { ancestors.push(d); if (P.dirname(d) === d) break; }
  let projectRoot = cwd;
  if (markers === null) projectRoot = ancestors[ancestors.length - 1];   // unknown: walk everything
  else if (markers.length) {
    outer: for (const a of ancestors) {
      for (const m of markers) {
        const st = safeStat(P.join(a, m), 'the root marker');
        if (st === 'error') { projectRoot = ancestors[ancestors.length - 1]; break outer; }
        if (!st) continue;
        if (m === '.git' && st.dir) {
          const head = safeStat(P.join(a, m, 'HEAD'), 'the git HEAD');
          if (head === 'error') { projectRoot = ancestors[ancestors.length - 1]; break outer; }
          if (!head) continue;
        }
        projectRoot = a; break outer;
      }
    }
  }

  // The git checkout root and the repo root (the main checkout of a linked worktree).
  let checkoutRoot: string | null = null;
  for (const a of ancestors) {
    const st = safeStat(P.join(a, '.git'), 'the .git entry');
    if (st === 'error' || !st) continue;
    if (st.dir) { const h = safeStat(P.join(a, '.git', 'HEAD'), 'the git HEAD'); if (h === 'error' || !h) continue; }
    checkoutRoot = a; break;
  }
  let repoRoot: string | null = checkoutRoot;
  let worktreeUnresolved = false;
  if (checkoutRoot) {
    const dotGit = P.join(checkoutRoot, '.git');
    const st = stat(dotGit);
    if (st && st.file) {
      // A linked worktree: `.git` holds `gitdir: <main>/.git/worktrees/<name>`, whose
      // `commondir` points at the main `.git`. Unresolvable -> fail closed.
      repoRoot = null;
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!m) throw new Error('no gitdir line');
        const gitDir = P.resolve(checkoutRoot, m[1]);
        const common = P.resolve(gitDir, fs.readFileSync(P.join(gitDir, 'commondir'), 'utf8').trim());
        if (P.basename(P.dirname(gitDir)) !== 'worktrees' || P.basename(common) !== '.git') throw new Error('not a worktrees/<name> gitdir');
        repoRoot = P.dirname(common);
      } catch (e) {
        worktreeUnresolved = true;
        unknown.push(`the linked worktree at ${checkoutRoot} could not be resolved to its main checkout (${(e as Error).message}); its hooks come from there`);
      }
    }
  }
  const linked = !!(checkoutRoot && repoRoot && !sameCodexProjectKey(checkoutRoot, repoRoot, platform));

  // 5. Trust per dir, as decision_for_dir.
  const decide = (map: TrustMap, dir: string): { level: TrustLevel | null; key: string | null } => {
    const keys = [dir, projectRoot, ...(repoRoot ? [repoRoot] : [])];
    for (const k of keys) {
      const hit = map.entries.find((e) => sameCodexProjectKey(e.key, k, platform));
      if (hit) return { level: hit.level, key: hit.key };
    }
    return { level: null, key: null };
  };
  const mapBefore = projectsOf(before);
  const mapAfter = projectsOf(after);

  // 4. Layers: root..cwd.
  const idx = ancestors.findIndex((a) => sameCodexProjectKey(a, projectRoot, platform));
  const dirs = ancestors.slice(0, idx < 0 ? ancestors.length : idx + 1).reverse();
  const home = P.resolve(stripVerbatim(input.codexHome));
  const versionOk = input.codexVersion === CODEX_LAYER_MODEL_VERSION;
  const layers: CodexLayerFinding[] = [];
  for (const dir of dirs) {
    const dotCodex = P.join(dir, '.codex');
    const st = safeStat(dotCodex, 'the .codex folder');
    if (st === null || (st !== 'error' && !st.dir)) continue;
    if (sameCodexProjectKey(dotCodex, home, platform)) continue;
    const a = decide(mapAfter, dir);
    const loadsAfter = a.level === 'trusted';
    const b = decide(mapBefore, dir);
    const loadsBefore = b.level === 'trusted';
    if (!loadsAfter && st !== 'error') continue;   // disabled: codex loads nothing from it
    const usersOwn = sameCodexProjectKey(dotCodex, P.resolve(stripVerbatim(input.userCodexHome ?? P.join(homedir(), '.codex'))), platform);
    const f: CodexLayerFinding = { dotCodex, trust: loadsBefore || usersOwn ? 'user' : 'seed', execute: [], confine: [], parse: [] };
    if (!loadsBefore && !usersOwn && b.level === 'untrusted' && b.key) f.userUntrustedKey = b.key;
    if (st === 'error') { f.execute.push(`${dotCodex}: could not be read (counted as code that runs)`); layers.push(f); continue; }
    if (!versionOk) f.execute.push(`codex ${input.codexVersion ?? '(unknown version)'} is not the modelled ${CODEX_LAYER_MODEL_VERSION}: this folder counts as code that runs`);
    // Own config.toml: mcp_servers, confinement keys, parse.
    const own = readToml(P.join(dotCodex, 'config.toml'));
    if (own.error) f.parse.push(`${P.join(dotCodex, 'config.toml')}: ${own.error} (codex would exit at start)`);
    const cfg = own.cfg ?? {};
    if ('mcp_servers' in cfg) f.execute.push(`${P.join(dotCodex, 'config.toml')}: mcp_servers (${isTable(cfg.mcp_servers) ? Object.keys(cfg.mcp_servers).join(', ') || 'empty' : 'set'}) start with the agent`);
    for (const k of CONFINE_KEYS) if (k in cfg) f.confine.push(`${P.join(dotCodex, 'config.toml')}: ${k}`);
    // Rules come from the worktree's own .codex.
    const rulesDir = P.join(dotCodex, 'rules');
    const rst = safeStat(rulesDir, 'the rules folder');
    if (rst === 'error') f.execute.push(`${rulesDir}: could not be read (counted as command policy)`);
    else if (rst && rst.dir) {
      try {
        for (const n of fs.readdirSync(rulesDir)) if (n.endsWith('.rules')) f.execute.push(`${P.join(rulesDir, n)}: command policy (allow/prompt/forbid rules)`);
      } catch (e) { f.execute.push(`${rulesDir}: could not be listed (${(e as Error).message}; counted as command policy)`); }
    }
    // Hooks: from the main checkout for a linked worktree, else from this .codex.
    let hooksDir = dotCodex;
    if (worktreeUnresolved) f.execute.push(`${dotCodex}: its hooks come from an unresolvable main checkout (counted as code that runs)`);
    else if (linked && checkoutRoot && repoRoot) {
      const rel = P.relative(checkoutRoot, dir);
      if (!rel.startsWith('..') && !P.isAbsolute(rel)) { hooksDir = P.join(repoRoot, rel, '.codex'); f.hooksFrom = hooksDir; }
    }
    const hooksToml = hooksDir === dotCodex ? own : readToml(P.join(hooksDir, 'config.toml'));
    if (hooksDir !== dotCodex && hooksToml.error) f.parse.push(`${P.join(hooksDir, 'config.toml')}: ${hooksToml.error} (the main checkout's hooks file)`);
    if (hooksToml.cfg && 'hooks' in hooksToml.cfg) f.execute.push(`${P.join(hooksDir, 'config.toml')}: hooks (${isTable(hooksToml.cfg.hooks) ? Object.keys(hooksToml.cfg.hooks).join(', ') || 'empty' : 'set'}) run on the agent's first turn`);
    const hj = P.join(hooksDir, 'hooks.json');
    let hjText: string | null = null;
    try { hjText = fs.readFileSync(hj, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') f.execute.push(`${hj}: could not be read (counted as code that runs)`); }
    if (hjText !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(hjText); } catch (e) { f.parse.push(`${hj}: not valid JSON (${(e as Error).message}); codex would ignore this file`); }
      if (parsed !== undefined) {
        const hooks = isTable(parsed) ? (parsed as TomlTable).hooks : undefined;
        const empty = isTable(parsed) && Object.keys(parsed).length === 0;
        const noHooks = isTable(hooks) && Object.values(hooks).every((v) => Array.isArray(v) && v.length === 0);
        if (!empty && !noHooks) f.execute.push(`${hj}: hooks${isTable(hooks) ? ` (${Object.keys(hooks).join(', ')})` : ''} run on the agent's first turn`);
      }
    }
    if (f.execute.length || f.parse.length || f.confine.length || f.userUntrustedKey) layers.push(f);
  }
  let projectFolder = cwd;
  if (linked && checkoutRoot && repoRoot) {
    const rel = P.relative(checkoutRoot, cwd);
    if (!rel.startsWith('..') && !P.isAbsolute(rel)) projectFolder = rel ? P.join(repoRoot, rel) : repoRoot;
  }
  return { layers, unknown, managedConfig: !!managed.cfg, projectFolder };
}

// ── the decision (the Human's ruling) ────────────────────────────────────────────────────────

export type CodexLayerAction = 'start' | 'start-warn' | 'refuse';

export interface CodexLayerDecision {
  action: CodexLayerAction;
  /** The layers that decided it. */
  layers: CodexLayerFinding[];
  /** One plain paragraph for the agent row / the log. */
  reason: string;
  /** The allowlist key the one-click opt-in records (the agent's cwd, codex-key form). */
  optInKey: string;
}

/** The allowlist key: the resolved cwd, ASCII-lowercased on Windows (as codex keys a project). */
export function codexLayerOptInKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? win32 : posix;
  const r = P.resolve(stripVerbatim(cwd));
  return platform === 'win32' ? asciiLower(r) : r;
}

export function isCodexLayerOptedIn(cwd: string, optIns: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): boolean {
  const key = codexLayerOptInKey(cwd, platform);
  return (optIns ?? []).some((k) => typeof k === 'string' && sameCodexProjectKey(codexLayerOptInKey(k, platform), key, platform));
}

/**
 * B (refuse) for code, command policy, a parse failure or an unknown model in a layer that loads
 * ONLY because of our seed (or against the user's own `untrusted`), unless the folder is opted
 * in; A (start with a visible warning) where the user's own trust list trusts the layer, or the
 * folder is opted in. Confinement keys alone: start, with a warning.
 */
export function decideCodexLayers(report: CodexLayerReport, optIns: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): CodexLayerDecision {
  const optInKey = codexLayerOptInKey(report.projectFolder, platform);
  const optedIn = isCodexLayerOptedIn(report.projectFolder, optIns, platform);
  const risky = (f: CodexLayerFinding): boolean => f.execute.length > 0 || f.parse.length > 0;
  const unknownRisk = report.unknown.length > 0;
  const seedRisky = report.layers.filter((f) => f.trust === 'seed' && (risky(f) || f.userUntrustedKey));
  const userRisky = report.layers.filter((f) => f.trust === 'user' && risky(f));
  const describe = (fs: CodexLayerFinding[]): string => fs.map((f) => [
    `${f.dotCodex}${f.hooksFrom ? ` (hooks from the main checkout ${f.hooksFrom})` : ''}:`,
    ...f.execute, ...f.parse, ...(f.userUntrustedKey ? [`you marked ${f.userUntrustedKey} "untrusted" in your codex config`] : [])
  ].join(' ')).join(' | ');
  if ((seedRisky.length || unknownRisk) && !optedIn) {
    const unk = unknownRisk ? ` Could not check: ${report.unknown.join('; ')}.` : '';
    return {
      action: 'refuse',
      layers: seedRisky,
      optInKey,
      reason: `Not started: this agent's folder carries codex project config that would run unreviewed (MCP servers start with the agent, hooks on its first turn; in auto mode unsandboxed), and you have not trusted it yourself. ${describe(seedRisky)}${unk} Allow this folder to start it: the hooks and MCP servers in this folder will then run unreviewed.`
    };
  }
  const warnLayers = [...(optedIn ? seedRisky : []), ...userRisky];
  if (warnLayers.length || (optedIn && unknownRisk)) {
    return {
      action: 'start-warn',
      layers: warnLayers,
      optInKey,
      reason: `${optedIn ? 'Started (folder allowed)' : 'Started (your codex trust list trusts this folder)'}: its hooks and MCP servers run unreviewed in hive agents. ${describe(warnLayers)}`
    };
  }
  const confine = report.layers.filter((f) => f.confine.length);
  if (confine.length) {
    return { action: 'start-warn', layers: confine, optInKey, reason: `Started: this folder's codex config sets confinement keys (the agent's own --sandbox/--ask-for-approval still win). ${confine.map((f) => f.confine.join(', ')).join(' | ')}` };
  }
  return { action: 'start', layers: [], optInKey, reason: '' };
}

/** What the window shows for a refused or warned Codex spawn (hive.ts -> index.ts -> renderer). */
export interface CodexLayerNotice {
  agentId: string | null;
  action: 'refuse' | 'start-warn';
  reason: string;
  optInKey: string;
  folder: string;
  at: number;
}
