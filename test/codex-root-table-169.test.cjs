'use strict';
/**
 * WAKEA-169 F1 (the same class as MS-169 F1): ONE shared root-table setter
 * (setCodexRootTableKeys) serves both setCodexTuiKeys ([tui]) and setCodexFeatureFlags
 * ([features]). Whatever shape the seed gives the table - an inline `name = { ... }`, top-level
 * dotted `name.x = ...` keys, a `[name]` table, or nothing - OUR generated config.toml stays ONE
 * valid definition of that table, with ours set and every other key of the user's kept.
 *
 * The `toml` package here predates dotted keys (TOML 0.4), so a dotted result is checked by
 * desugaring its top-level `name.k = v` lines into a `[name]` table first: a duplicate key, or a
 * dotted key beside a `[name]` header (a redefinition), then fails toml.parse the same way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/codexAgentConfig.ts');

/** Parse a config; top-level dotted `name.k = v` lines are moved into an appended [name] table. */
function parse(text, name) {
  const lines = text.split(/\r?\n/);
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const dotted = new RegExp(`^\\s*${name}\\.(.+)$`);
  const moved = [];
  const kept = lines.filter((l, i) => {
    const m = i < topEnd ? dotted.exec(l) : null;
    if (m) moved.push(m[1]);
    return !m;
  });
  const desugared = moved.length ? `${kept.join('\n')}\n\n[${name}]\n${moved.join('\n')}\n` : text;
  return JSON.parse(JSON.stringify(toml.parse(desugared)));
}

const CALLERS = [
  {
    name: 'tui',
    set: (cfg) => C.setCodexTuiKeys(cfg, { terminal_resize_reflow_max_rows: 50, alternate_screen: 'always' }),
    ours: { terminal_resize_reflow_max_rows: 50, alternate_screen: 'always' },
    user: { theme: 'dark' },
    seedOurKey: 'alternate_screen = "never"'
  },
  {
    name: 'features',
    set: (cfg) => C.setCodexFeatureFlags(cfg, { retain_client_developer_messages: false }),
    ours: { retain_client_developer_messages: false },
    user: { foo: true },
    seedOurKey: 'retain_client_developer_messages = true'
  }
];

function seeds(c) {
  const userPair = Object.entries(c.user).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)[0];
  return {
    inline: `model = "m"\n${c.name} = { ${userPair}, ${c.seedOurKey} } # mine\napproval_policy = "never"\n\n[other]\nx = 1\n`,
    'inline, multi-line': `${c.name} = {\n  ${userPair}, # a comment\n  ${c.seedOurKey}\n}\nmodel = "m"\n`,
    dotted: `model = "m"\n${c.name}.${userPair}\n${c.name}.${c.seedOurKey}\n\n[other]\nx = 1\n`,
    table: `model = "m"\n\n[${c.name}]\n${userPair}\n${c.seedOurKey}\n\n[other]\nx = 1\n`,
    absent: `model = "m"\n\n[other]\nx = 1\n`,
    empty: ''
  };
}

for (const c of CALLERS) {
  for (const [shape, seed] of Object.entries(seeds(c))) {
    test(`${c.name}: a ${shape} seed -> one valid [${c.name}] with ours set and the user's keys kept`, () => {
      const out = c.set(seed);
      const cfg = parse(out, c.name);
      for (const [k, v] of Object.entries(c.ours)) assert.equal(cfg[c.name][k], v, k);
      if (shape !== 'absent' && shape !== 'empty') {
        for (const [k, v] of Object.entries(c.user)) assert.equal(cfg[c.name][k], v, `the user's ${k} is kept`);
      }
      if (seed.includes('model = "m"')) assert.equal(cfg.model, 'm');
      if (seed.includes('[other]')) assert.equal(cfg.other.x, 1);
      if (seed.includes('approval_policy')) assert.equal(cfg.approval_policy, 'never', 'a key after the inline table stays top-level');
      // Exactly one definition of the table: a header, or dotted keys, never both.
      const headers = (out.match(new RegExp(`^\\s*\\[${c.name}\\]`, 'gm')) || []).length;
      const dottedLines = (out.match(new RegExp(`^\\s*${c.name}\\.`, 'gm')) || []).length;
      assert.ok((headers === 1 && dottedLines === 0) || (headers === 0 && dottedLines > 0), `one definition (headers ${headers}, dotted ${dottedLines})`);
      assert.equal(shape === 'dotted' ? headers : dottedLines, 0);
      assert.doesNotMatch(out, new RegExp(`^\\s*${c.name}\\s*=`, 'm'), 'no inline table left');
      // Idempotent.
      assert.deepEqual(parse(c.set(out), c.name), cfg);
    });
  }
}

test('the test parser rejects what F1 produced (a dotted key beside a [name] header, an inline table plus a header)', () => {
  assert.throws(() => parse('features.foo = true\n\n[features]\nretain_client_developer_messages = false\n', 'features'));
  assert.throws(() => parse('features = { foo = true }\n\n[features]\nretain_client_developer_messages = false\n', 'features'));
});

test('both callers go through the shared setter (same output for the same table)', () => {
  const seed = 'features = { foo = true }\n';
  assert.equal(C.setCodexFeatureFlags(seed, { retain_client_developer_messages: false }),
    C.setCodexRootTableKeys(seed, 'features', { retain_client_developer_messages: false }));
  const tseed = 'tui.theme = "dark"\n';
  assert.equal(C.setCodexTuiKeys(tseed, C.CODEX_TUI_KEYS),
    C.setCodexRootTableKeys(tseed, 'tui', C.CODEX_TUI_KEYS, '# munder-hive: bounded transcript replay on resize (auto-generated; do not edit)'));
});

test('both at once, as installCodexHooks applies them: inline tui + dotted features in one seed', () => {
  const seed = 'model = "m"\ntui = { theme = "dark" }\nfeatures.foo = true\n\n[other]\nx = 1\n';
  const out = C.setCodexFeatureFlags(C.setCodexTuiKeys(seed, C.CODEX_TUI_KEYS), { retain_client_developer_messages: false });
  const cfg = parse(out, 'features');
  assert.equal(cfg.tui.theme, 'dark');
  assert.equal(cfg.tui.terminal_resize_reflow_max_rows, 50);
  assert.equal(cfg.features.foo, true);
  assert.equal(cfg.features.retain_client_developer_messages, false);
  assert.equal(cfg.other.x, 1);
});
