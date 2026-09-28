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

/** A top-level key line of the seed (before its first table), bare or quoted. */
function topLevelKey(line: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(["']?)${esc}\\1\\s*=`).test(line);
}

/**
 * Set top-level scalar keys in OUR copy: any seed line for the same key before the first table
 * is removed (TOML forbids a duplicate key), and ours go first in the file. A `null` value only
 * removes. Values are numbers or already-TOML-encoded strings.
 */
export function setCodexTopLevelKeys(config: string, entries: Record<string, number | null>): string {
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => ANY_TABLE.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const keys = Object.keys(entries);
  const kept = lines.filter((l, i) => i >= topEnd || !keys.some((k) => topLevelKey(l, k)));
  const ours = keys
    .filter((k) => typeof entries[k] === 'number' && Number.isFinite(entries[k] as number))
    .map((k) => `${k} = ${Math.trunc(entries[k] as number)}`);
  if (!ours.length) return kept.join('\n');
  return `# --- munder-hive: per-agent token limits (auto-generated; do not edit) ---\n${ours.join('\n')}\n\n${kept.join('\n')}`;
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
