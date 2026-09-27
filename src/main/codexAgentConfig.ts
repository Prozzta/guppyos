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
