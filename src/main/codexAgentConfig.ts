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
