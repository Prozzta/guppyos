/**
 * CODEX-BLOAT-165: what OUR per-agent Codex config.toml changes relative to the seed copied
 * from the user's ~/.codex/config.toml. Pure text transforms; the global file is only ever READ
 * (installCodexHooks), never written.
 *
 * Line-based on purpose, like withCodexDeveloperInstructions: a full TOML round-trip would
 * reformat the user's file and drop their comments.
 */

/** A `[plugins.<name>]` table header (not an array-of-tables, not a sub-table). */
const PLUGIN_TABLE = /^\s*\[\s*plugins\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_@.-]+)\s*\]\s*(#.*)?$/;
const ANY_TABLE = /^\s*\[/;
const ENABLED = /^(\s*)(["']?)enabled\2(\s*=\s*)(true|false)(\s*(#.*)?)$/;

/**
 * Fix 5: every plugin the seed enables is turned OFF for a hive agent. Each enabled plugin adds
 * its tools, skills and instructions to every request (11 in the Human's config: browser,
 * computer-use, documents, pdf, spreadsheets, ...), none of which a hive coding agent uses. A
 * plugin table with no `enabled` key gets `enabled = false` too. Returns the text and a count.
 */
export function disableCodexPlugins(config: string): { text: string; disabled: number } {
  const lines = config.split(/\r?\n/);
  const out: string[] = [];
  let inPlugin = false;
  let sawEnabled = false;
  let disabled = 0;
  const closeTable = (): void => {
    if (inPlugin && !sawEnabled) {
      // Insert after the table's last non-blank line, so a blank separator stays a separator.
      let at = out.length;
      while (at > 0 && out[at - 1].trim() === '') at--;
      out.splice(at, 0, 'enabled = false # munder-hive: plugins are off for hive agents');
      disabled++;
    }
    inPlugin = false;
    sawEnabled = false;
  };
  for (const line of lines) {
    if (ANY_TABLE.test(line)) {
      closeTable();
      inPlugin = PLUGIN_TABLE.test(line);
      out.push(line);
      continue;
    }
    const m = inPlugin ? ENABLED.exec(line) : null;
    if (m) {
      sawEnabled = true;
      if (m[4] === 'true') {
        out.push(`${m[1]}${m[2]}enabled${m[2]}${m[3]}false # munder-hive: plugins are off for hive agents`);
        disabled++;
        continue;
      }
    }
    out.push(line);
  }
  closeTable();
  return { text: out.join('\n'), disabled };
}

/** Fix 6: compact at ~120K tokens instead of the model default (~220-243K of a 258K window,
 *  measured). Only sane once threads rotate (fix 1): on a thread with an 87K retained floor it
 *  would compact every 20-30K tokens. */
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT = 120_000;
/**
 * A trial override must leave room above the measured ~18K post-compaction floor and below the
 * ~258K model window.  Values outside this range would either compact nearly every request or
 * silently turn compaction off, so fail closed to the fleet default instead.
 */
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT_MIN = 40_000;
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT_MAX = 200_000;

export function isCodexAutoCompactTokenLimitOverride(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= CODEX_AUTO_COMPACT_TOKEN_LIMIT_MIN
    && value <= CODEX_AUTO_COMPACT_TOKEN_LIMIT_MAX;
}

/**
 * A registry-controlled override for one Codex agent. Unset (and malformed) values retain the
 * fleet default; the value is deliberately not tied to any particular agent ID.
 */
export function codexAutoCompactTokenLimitForAgent(override?: unknown): number {
  return isCodexAutoCompactTokenLimitOverride(override) ? override : CODEX_AUTO_COMPACT_TOKEN_LIMIT;
}

/** A top-level key line of the seed (before its first table), bare or quoted. */
function topLevelKey(line: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(["']?)${esc}\\1\\s*=`).test(line);
}

/**
 * Set top-level scalar keys in OUR copy: any seed line for the same key before the first table
 * is removed (TOML forbids a duplicate key), and ours go first in the file. A `null` value only
 * removes. Values are numbers or booleans (WAKE-SCREEN-GUARD R2-2: `check_for_update_on_startup`).
 */
export function setCodexTopLevelKeys(config: string, entries: Record<string, number | boolean | null>): string {
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => ANY_TABLE.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const keys = Object.keys(entries);
  const kept = lines.filter((l, i) => i >= topEnd || !keys.some((k) => topLevelKey(l, k)));
  const ours = keys
    .filter((k) => (typeof entries[k] === 'number' && Number.isFinite(entries[k] as number)) || typeof entries[k] === 'boolean')
    .map((k) => `${k} = ${typeof entries[k] === 'boolean' ? String(entries[k]) : Math.trunc(entries[k] as number)}`);
  if (!ours.length) return kept.join('\n');
  return `# --- munder-hive: per-agent token limits and startup settings (auto-generated; do not edit) ---\n${ours.join('\n')}\n\n${kept.join('\n')}`;
}

/**
 * MODEL-PINBACK G1: when the app launches this agent with `--model <picked>`, the flag beats any
 * `model =` in config.toml, so a seed `model` line copied from the user's ~/.codex/config.toml is
 * inert and misleading (it named gpt-6-astra while every request ran gpt-5.6-terra). OUR copy
 * then states the model the agent really runs: the seed's top-level `model` line is replaced by
 * `model = "<picked>"`. With nothing picked (`null`/empty) the text is returned unchanged, so the
 * seed's model applies, as Codex itself would do. A profile's own `model` (inside a table) is
 * left alone: the flag beats it too, but it is only read when that profile is selected.
 */
export function setCodexModel(config: string, picked: string | null | undefined): string {
  const model = picked?.trim();
  if (!model) return config;
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => ANY_TABLE.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const kept = lines.filter((l, i) => i >= topEnd || !topLevelKey(l, 'model'));
  return `# --- munder-hive: the model this agent is launched with (--model; auto-generated; do not edit) ---\nmodel = ${JSON.stringify(model).replace(/\u007f/g, '\\u007F')}\n\n${kept.join('\n')}`;
}

/**
 * AGENT-MODEL-NOT-KEPT M2: the reasoning effort this agent is launched with goes into OUR copy
 * next to the model, replacing a seed's top-level `model_reasoning_effort`. Codex saves a
 * person's `/model` choice as `model` + `model_reasoning_effort` in this same file, and the file
 * is regenerated at every spawn, so without this the seed's effort came back after each restart
 * (Dwight: luna-medium picked, terra-high back). Only a plain effort word is written (see
 * normEffort); none = the text unchanged, so the seed's effort applies, as Codex itself would do.
 */
export function setCodexReasoningEffort(config: string, effort: string | null | undefined): string {
  const e = (effort ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(e)) return config;
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => ANY_TABLE.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const kept = lines.filter((l, i) => i >= topEnd || !topLevelKey(l, 'model_reasoning_effort'));
  return `# --- munder-hive: the reasoning effort this agent is launched with (auto-generated; do not edit) ---\nmodel_reasoning_effort = "${e}"\n\n${kept.join('\n')}`;
}

/** A top-level string key's value in a config.toml text (before the first table), or undefined.
 *  Basic and literal one-line strings only; anything else reads as absent. */
export function codexTopLevelString(config: string, key: string): string | undefined {
  const lines = config.split(/\r?\n/);
  for (const line of lines) {
    if (ANY_TABLE.test(line)) return undefined;
    if (!topLevelKey(line, key)) continue;
    const m = /=\s*(?:"([^"\\]*)"|'([^']*)')\s*(#.*)?$/.exec(line);
    return m ? (m[1] ?? m[2]) : undefined;
  }
  return undefined;
}

/**
 * MEMSPIKE-168: the [tui] keys OUR copy always carries, whatever the seed says. Measured through
 * the ConPTY the app uses (node-pty, Windows inbox conhost), Codex 0.157.1, one resize, a resumed
 * 200-turn thread:
 *   - inline mode (`alternate_screen = "never"`, `--no-alt-screen`, or
 *     `fullscreen_transcript = false`) re-emits the WHOLE transcript on every resize:
 *     1.14-1.18 MB per resize (1.37 MB at start), ~5x each history line;
 *   - alternate screen + fullscreen transcript (the 0.157 defaults): 2.8-3.1 KB per resize;
 *   - `terminal_resize_reflow_max_rows = 50` caps an inline replay at ~35 KB, and changes
 *     nothing in the alternate screen, so it is the bound if inline mode is ever entered anyway.
 * A seed that turns inline mode on (the user's choice for their own terminal) would otherwise
 * make every layout change in our embedded xterm push another full copy of the conversation.
 */
export const CODEX_TUI_KEYS_FULLSCREEN: Readonly<Record<string, string | number | boolean>> = {
  alternate_screen: 'always',
  fullscreen_transcript: true,
  terminal_resize_reflow_max_rows: 50
};

/**
 * The alternative: keep whatever mode the seed chose (so an inline-mode user keeps Codex's
 * history in our xterm scrollback) and only cap an inline replay at ~35 KB per resize.
 */
export const CODEX_TUI_KEYS_REFLOW_ONLY: Readonly<Record<string, string | number | boolean>> = {
  terminal_resize_reflow_max_rows: 50
};

/**
 * THE SELECTION (the Human's choice, RENDERER-MEMSPIKE): one of the two sets above. Reflow-only
 * until the Human answers: FULLSCREEN moves Codex's history out of our xterm scrollback, against
 * the standing never-shrink-scrollback rule, until the History view exists.
 */
export const CODEX_TUI_KEYS: Readonly<Record<string, string | number | boolean>> = CODEX_TUI_KEYS_REFLOW_ONLY;

function tomlValue(v: string | number | boolean): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(Math.trunc(v));
  return v ? 'true' : 'false';
}

/** A key line `key = ...` (bare or quoted) inside a table. */
function keyLine(line: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(["']?)${esc}\\1\\s*=`).test(line);
}

/**
 * Split the text after an inline table's `{` into its raw `key = value` pairs, up to the
 * matching `}`. Quotes, nested {} and [] and (multi-line, TOML 1.1) comments are respected.
 * Returns null when the table never closes.
 */
function inlineTablePairs(text: string): { pairs: string[]; rest: string } | null {
  const pairs: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === '{' || c === '[') depth++;
    if (c === ']') depth--;
    if (c === '}') {
      if (depth === 0) {
        if (cur.trim()) pairs.push(cur.trim());
        return { pairs, rest: text.slice(i + 1) };
      }
      depth--;
    }
    if (c === ',' && depth === 0) {
      if (cur.trim()) pairs.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  return null;
}

/** `name` as a regex source, for a bare root-table name like `tui` or `features`. */
function nameSource(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MS-169 F1 / WAKEA-169 F1: a seed may write a root table as a top-level inline table
 * (`tui = { ... }`, `features = { ... }`), which forbids any later `[name]` header or
 * `name.x` key. Rewrite it as an equivalent `[name]` table at the end (its pairs verbatim), so
 * ours can be set in the usual way. Anything else (or an unclosed table) is returned unchanged.
 */
function inlineRootTableToTable(config: string, name: string): string {
  const inline = new RegExp(`^\\s*(["']?)${nameSource(name)}\\1\\s*=\\s*\\{`);
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => ANY_TABLE.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const at = lines.slice(0, topEnd).findIndex((l) => inline.test(l));
  if (at < 0) return config;
  const open = lines[at].indexOf('{');
  const tail = [lines[at].slice(open + 1), ...lines.slice(at + 1, topEnd)].join('\n');
  const parsed = inlineTablePairs(tail);
  if (!parsed) return config;
  // The lines the inline table spanned; whatever follows its `}` on the last one is a comment.
  const spanned = tail.slice(0, tail.length - parsed.rest.length).split('\n').length;
  const kept = [...lines.slice(0, at), ...lines.slice(at + spanned)];
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const pairs = parsed.pairs.map((p) => p.replace(/\s*\n\s*/g, ' '));
  return `${kept.join('\n')}${kept.length ? '\n\n' : ''}[${name}]\n${pairs.join('\n')}\n`;
}

/**
 * THE shared root-table setter (WAKEA-169 F1): set scalar keys of the root table `[name]` in OUR
 * copy, whatever shape the seed gives that table. TOML allows exactly one definition of a table,
 * so ours must join the seed's:
 *   - a top-level inline `name = { ... }` is first rewritten as one `[name]` table;
 *   - a `[name]` table: ours go right under its header;
 *   - top-level dotted `name.x = ...` keys (which forbid a later `[name]` header): ours are
 *     written as dotted keys beside them;
 *   - no such table: a new `[name]` table at the end.
 * The seed's values for the same keys are removed (in `[name]`, and as top-level dotted
 * `name.<key>` lines), since TOML forbids a duplicate key; every other key of the user's is kept.
 * `note` is an optional comment line written above ours.
 */
export function setCodexRootTableKeys(
  config: string,
  name: string,
  entries: Readonly<Record<string, string | number | boolean>>,
  note?: string
): string {
  // The document root has no TOML table header. Keep its established duplicate-safe writer
  // behind this shared entry point so per-agent scalar policy follows the same config path.
  if (name === '') return setCodexTopLevelKeys(config, entries as Record<string, number | boolean | null>);
  const keys = Object.keys(entries);
  const header = new RegExp(`^\\s*\\[\\s*(["']?)${nameSource(name)}\\1\\s*\\]\\s*(#.*)?$`);
  const dotted = new RegExp(`^\\s*(["']?)${nameSource(name)}\\1\\s*\\.`);
  const lines = inlineRootTableToTable(config, name).split(/\r?\n/);
  const firstTable = lines.findIndex((l) => ANY_TABLE.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const hasDotted = lines.slice(0, topEnd).some((l) => dotted.test(l));
  const out: string[] = [];
  let inTable = false;
  let at = -1;
  let topOutEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === topEnd) topOutEnd = out.length;
    if (ANY_TABLE.test(line)) {
      inTable = header.test(line);
      out.push(line);
      if (inTable && at < 0) at = out.length;
      continue;
    }
    if (i < topEnd && keys.some((k) => keyLine(line, `${name}.${k}`))) continue;
    if (inTable && keys.some((k) => keyLine(line, k))) continue;
    out.push(line);
  }
  if (topOutEnd < 0) topOutEnd = out.length;
  const head = note ? [note] : [];
  if (at >= 0) {
    out.splice(at, 0, ...head, ...keys.map((k) => `${k} = ${tomlValue(entries[k])}`));
    return out.join('\n');
  }
  if (hasDotted) {
    out.splice(topOutEnd, 0, ...head, ...keys.map((k) => `${name}.${k} = ${tomlValue(entries[k])}`), '');
    return out.join('\n');
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return `${out.join('\n')}${out.length ? '\n\n' : ''}[${name}]\n${[...head, ...keys.map((k) => `${k} = ${tomlValue(entries[k])}`)].join('\n')}\n`;
}

/** MEMSPIKE-168: the selected `[tui]` keys in OUR copy (see CODEX_TUI_KEYS). */
export function setCodexTuiKeys(config: string, entries: Readonly<Record<string, string | number | boolean>>): string {
  return setCodexRootTableKeys(config, 'tui', entries,
    '# munder-hive: bounded transcript replay on resize (auto-generated; do not edit)');
}

/** Pin scalar booleans in the root [features] table without reformating the
 * user's seed. Feature flags are per-agent policy, unlike profile overrides. */
export function setCodexFeatureFlags(config: string, entries: Record<string, boolean>): string {
  return setCodexRootTableKeys(config, 'features', entries);
}

/** TOML string for a path: literal unless the path holds a single quote. */
function tomlPathString(v: string): string {
  return v.includes("'") ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `'${v}'`;
}

/**
 * CODEX-MCP-ISOLATION: the seed's values that name the user's real ~/.codex are moved to the
 * agent's own home, in every build (before this only MUNDER_DEV sanitised them). The Human's
 * seed carries a node_repl MCP server whose env sets CODEX_HOME, NODE_REPL_TRUSTED_CODE_PATHS and
 * NODE_REPL_TRUSTED_SERVICES to paths in ~/.codex, and the bundled marketplace source is under
 * ~/.codex/.tmp, so every agent's helper read and trusted the user's profile.
 *  - every value whose key is CODEX_HOME (bare, quoted or dotted; at the root, in a table or in
 *    an inline table) becomes the agent home, whatever it held: an absent key would let the
 *    helper fall back to the user's ~/.codex;
 *  - any other path at or under the real ~/.codex (or `~/.codex`) keeps its subpath under the
 *    agent home, in the slash style it was written in, doubled separators included (JSON held
 *    in a string). Codex fills its own home's plugin cache and bundled marketplace, so the
 *    mapped paths are where this agent's copies live.
 * Paths OUTSIDE ~/.codex (the installed Codex runtime under AppData, ~/.cache) are the shared
 * read-only runtime and are kept. Only single-line string VALUES are rewritten: table headers
 * and keys, comments, multi-line strings (prose such as developer_instructions) and basic
 * strings with escapes other than \\ and \" are copied as written, and so is every byte between
 * tokens, so line endings are kept and a seed with nothing to rewrite comes back identical.
 * A small scanner rather than a TOML library, for the same reason as the line transforms above:
 * a round-trip would reformat the user's file. It never throws; text it cannot read is copied.
 */
export function isolateCodexHomePaths(
  config: string,
  opts: { userCodexHome: string; agentCodexHome: string; win32?: boolean },
): { text: string; rewritten: number } {
  const win32 = opts.win32 ?? process.platform === 'win32';
  // Same length as the input, so an index into the folded form is an index into the original.
  const fold = (s: string): string => win32
    ? Array.from(s, (c) => { const l = c === '\\' ? '/' : c.toLowerCase(); return l.length === c.length ? l : c; }).join('')
    : s;
  const absRoot = fold(opts.userCodexHome).replace(/[\\/]+$/, '');
  const agentFwd = opts.agentCodexHome.replace(/\\/g, '/');
  // [folded root, separators doubled, may follow a path character]. A doubled root is the
  // same path inside an escaped string (JSON in a literal); `~` only starts a path at a value
  // or list boundary, never after a `/` (https://h/~/.codex is a URL path, not the profile).
  const roots: Array<[string, boolean, boolean]> = [[absRoot, false, true], ['~/.codex', false, false]];
  if (win32) roots.push([absRoot.replace(/\//g, '//'), true, true], ['~//.codex', true, false]);
  let rewritten = 0;
  const mapPath = (v: string): string => {
    const f = fold(v);
    let out = '';
    let from = 0;
    for (let i = 0; i < v.length; i++) {
      const prev = i === 0 ? '' : f.charAt(i - 1);
      const root = roots.find(([r, , afterPath]) => f.startsWith(r, i)
        && /^(|[\\/;,\s])$/.test(f.charAt(i + r.length))
        && !(prev && (afterPath ? /[A-Za-z0-9._-]/ : /[A-Za-z0-9._\-\\/:~]/).test(prev)));
      if (!root) continue;
      const hit = v.slice(i, i + root[0].length);
      const fwd = hit.includes('/') && !hit.includes('\\');
      let home = fwd ? agentFwd : opts.agentCodexHome;
      if (root[1]) home = fwd ? home.replace(/\//g, '//') : home.replace(/\\/g, '\\\\');
      out += v.slice(from, i) + home;
      from = i + root[0].length;
      i = from - 1;
      rewritten++;
    }
    return out + v.slice(from);
  };

  const s = config;
  let i = 0;
  let out = '';
  const copyTo = (j: number): void => { out += s.slice(i, j); i = j; };
  const skipBlank = (newlines: boolean): void => {
    let j = i;
    for (;;) {
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || (newlines && (s[j] === '\n' || s[j] === '\r')))) j++;
      if (newlines && s[j] === '#') { while (j < s.length && s[j] !== '\n') j++; continue; }
      break;
    }
    copyTo(j);
  };
  /** End index of the string token at i, or -1 when s[i] opens none. Multi-line too. */
  const stringEnd = (at: number): number => {
    const q = s[at];
    if (q !== '"' && q !== "'") return -1;
    const multi = s.startsWith(q.repeat(3), at);
    let j = at + (multi ? 3 : 1);
    while (j < s.length) {
      if (q === '"' && s[j] === '\\') { j += 2; continue; }
      if (!multi && (s[j] === '\n' || s[j] === '\r')) return j;   // unterminated: stop at the line end
      if (multi ? s.startsWith(q.repeat(3), j) : s[j] === q) {
        // A body ending in one or two quotes closes early here; the quotes left over read as an
        // empty string, which is copied, so the output is the same.
        return j + (multi ? 3 : 1);
      }
      j++;
    }
    return s.length;
  };
  /** The decoded text of a single-line key token, for matching CODEX_HOME. */
  const keyText = (tok: string): string => tok.startsWith("'") ? tok.slice(1, -1)
    : tok.startsWith('"') ? tok.slice(1, -1).replace(/\\(["\\])/g, '$1') : tok;
  /** A dotted key; returns the decoded last part. Copied as written. */
  const key = (): string => {
    let last = '';
    for (;;) {
      skipBlank(false);
      const e = stringEnd(i);
      if (e > 0) { last = keyText(s.slice(i, e)); copyTo(e); }
      else {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j++;
        if (j === i) return last;
        last = s.slice(i, j); copyTo(j);
      }
      skipBlank(false);
      if (s[i] !== '.') return last;
      copyTo(i + 1);
    }
  };
  const stringValue = (e: number, isHome: boolean): void => {
    const tok = s.slice(i, e);
    const q = tok[0];
    if (tok.length < 2 || tok[tok.length - 1] !== q || tok.startsWith(q.repeat(3))) { copyTo(e); return; }
    let next = tok;
    if (isHome) {
      next = tomlPathString(opts.agentCodexHome);
      if (next !== tok) rewritten++;
    } else if (q === "'") {
      const v = mapPath(tok.slice(1, -1));
      if (v !== tok.slice(1, -1)) next = tomlPathString(v);
    } else {
      const raw = tok.slice(1, -1);
      if (!raw.replace(/\\["\\]/g, '').includes('\\')) {
        const plain = raw.replace(/\\(["\\])/g, '$1');
        const v = mapPath(plain);
        if (v !== plain) next = `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      }
    }
    out += next;
    i = e;
  };
  const value = (isHome: boolean): void => {
    skipBlank(false);
    const e = stringEnd(i);
    if (e > 0) { stringValue(e, isHome); return; }
    if (s[i] === '[') {
      copyTo(i + 1);
      for (;;) {
        skipBlank(true);
        if (i >= s.length) return;
        if (s[i] === ']') { copyTo(i + 1); return; }
        if (s[i] === ',') { copyTo(i + 1); continue; }
        const at = i;
        value(false);
        if (i === at) copyTo(i + 1);
      }
    }
    if (s[i] === '{') {
      copyTo(i + 1);
      for (;;) {
        skipBlank(false);
        if (i >= s.length || s[i] === '\n' || s[i] === '\r') return;
        if (s[i] === '}') { copyTo(i + 1); return; }
        if (s[i] === ',') { copyTo(i + 1); continue; }
        const at = i;
        const k = key();
        skipBlank(false);
        if (s[i] === '=') { copyTo(i + 1); value(k === 'CODEX_HOME'); }
        if (i === at) copyTo(i + 1);
      }
    }
    let j = i;
    while (j < s.length && !/[,\]}#\s]/.test(s[j])) j++;
    copyTo(j);
  };
  while (i < s.length) {
    skipBlank(true);
    if (i >= s.length) break;
    // A table header is reached only here, at the top level (never inside an open array or a
    // string). `[` starts no key, so the whole header line, quoted parts holding `]` included,
    // goes to the copy below as written.
    const at = i;
    const k = key();
    skipBlank(false);
    if (s[i] === '=') { copyTo(i + 1); value(k === 'CODEX_HOME'); }
    if (i === at) copyTo(i + 1);
    // The rest of the line (a comment, or text this scanner cannot read) is copied as written.
    let j = i;
    while (j < s.length && s[j] !== '\n') {
      if (s[j] === '#') { while (j < s.length && s[j] !== '\n') j++; break; }
      const e = stringEnd(j);
      j = e > 0 ? e : j + 1;
    }
    copyTo(j);
  }
  return { text: out, rewritten };
}
