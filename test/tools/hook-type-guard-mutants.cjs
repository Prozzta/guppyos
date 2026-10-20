'use strict';

// RULE-FIX-HOOK-NO-MODEL: the hand-mutant census of the hook-type guard, committed so the audit can
// re-run it. Each mutant damages ONE source line at a unique anchor and must make
// test/hook-type-guard-198.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a
// missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/hook-type-guard-mutants.cjs
// Each file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST = 'test/hook-type-guard-198.test.cjs';
const GUARD = 'src/main/hookTypeGuard.ts';
const HIVE = 'src/main/hive.ts';
const INDEX = 'src/main/index.ts';
const DIGEST = 'src/main/floorDigest.ts';
const at = (title) => new RegExp(`not ok \\d+ - ${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);

const MUTANTS = [
  ['G1 prompt is allowed', GUARD, "new Set(['command', 'http', 'mcp_tool'])", "new Set(['command', 'http', 'mcp_tool', 'prompt'])", at('the allow-list is exactly')],
  ['G2 an untyped handler passes as command', GUARD, "return typeof h.type === 'string' && h.type ? h.type : '(none)';", "return typeof h.type === 'string' && h.type ? h.type : 'command';", at('stripHookMap drops')],
  ['G3 an emptied group is kept', GUARD, 'if (handlers.length) kept.push({ ...g, hooks: handlers });', 'kept.push({ ...g, hooks: handlers });', at('stripHookMap drops')],
  ['G4 a flat (AGY) handler is never stripped', GUARD, 'if (ALLOWED_HOOK_TYPES.has(type)) kept.push(g);\n        else stripped.push({ event, type });', 'kept.push(g);', at('stripHookMap drops')],
  ['G5 settings keep their unstripped hooks', GUARD, 'return { settings: { ...settings, hooks: r.hooks } as T, stripped: r.stripped };', 'return { settings, stripped: r.stripped };', at('stripSettingsHooks keeps')],
  ['G6 a model handler table stays in the seed', GUARD, 'if (!ALLOWED_HOOK_TYPES.has(t)) { stripped.push({ event: handler[1], type: t }); if (open) open.dropped++; continue; }', 'if (open) open.kept++;', at('Codex seed: a prompt/agent handler table')],
  ['G7 a group left with no handler stays', GUARD, 'if (open && open.dropped > 0 && open.kept === 0 && !open.inline) kept.splice', 'if (false) kept.splice', at('Codex seed: a prompt/agent handler table')],
  ['G8 a group with a kept handler is dropped too', GUARD, 'open.dropped > 0 && open.kept === 0 &&', 'open.dropped > 0 && open.kept >= 0 &&', at('Codex seed: a group keeps')],
  ['G9 an inline model group stays', GUARD, 'if (bad.length) { for (const t of bad) stripped.push({ event: group[1], type: t }); continue; }', '', at('Codex seed: a group with an inline')],
  ['G10 no fallback', GUARD, "const noHooks = blocks.filter((b) => !(b.name === 'hooks' || (b.name ?? '').startsWith('hooks.')));", 'const noHooks = blocks;', at('Codex seed: a shape the table splitter')],
  ['G11 CRLF is lost', GUARD, ".join('\\n').replace(/\\n/g, eol);", ".join('\\n');", at('Codex seed: a shape the table splitter')],
  ['G12 a seed that stays dirty is called clean', GUARD, 'clean: fallbackScan !== null && fallbackScan.length === 0, allHooksDropped: true', 'clean: true, allHooksDropped: true', at('Codex seed: hooks in a root inline')],
  ['G13 an unparsable seed is treated as dirty', GUARD, '  if (before === null) return { text, stripped: [], clean: true, allHooksDropped: false, unparsed: true };\n', '', at('Codex seed: a clean seed')],
  ['G14 the managed settings are not scanned', GUARD, "out.push({ path: managed, kind: 'settings', label: 'the managed Claude settings' });", '', at('foreign files: Claude user')],
  ['G15 the plugin walk enters dot dirs and node_modules', GUARD, "if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, depth + 1);", 'walk(p, depth + 1);', at('foreign files: Claude user')],
  ['G16 the plugin walk has no depth bound', GUARD, 'if (depth > PLUGIN_WALK_MAX_DEPTH || out.length >= PLUGIN_WALK_MAX_FILES) return;', 'if (out.length >= PLUGIN_WALK_MAX_FILES) return;', at('foreign files: the plugin walk')],
  ['G17 our own Grok file is scanned as foreign', GUARD, " && e.name !== GROK_OWN_FILE) out.push(", ') out.push(', at('foreign files: Codex seed, both AGY')],
  ['G18 our own AGY key is scanned as foreign', GUARD, '.filter(([k]) => k !== AGY_OWN_KEY)', '', at('scanForeignHookFile')],
  ['G19 untyped entries in foreign files warn', GUARD, 'return namedOnly(scanForeignRaw(f, fs));', 'return scanForeignRaw(f, fs);', at('scanForeignHookFile')],
  ['D1 no decision item', DIGEST, '  for (const m of input.modelHooks ?? []) items.push(modelHooksItem(m, now));\n', '', at('digest: one decision')],
  ['D2 the id ignores the finding set', DIGEST, 'update(`${m.file}\\n${m.findings}`)', 'update(m.file)', at('digest: one decision')],
  ['D3 a seed strip reads as a live burn', DIGEST, 'const effect = m.stripped', 'const effect = false', at('digest: one decision')],
  ['D4 the digest never asks the host', DIGEST, '      modelHooks: (() => { try { return this.host.modelHooks?.() ?? []; } catch { return []; } })(),\n', '', at('wiring: the digest asks')],
  ['I1 index does not hand over the warnings', INDEX, '  modelHooks: () => hive.modelHookWarnings(),\n', '', at('wiring: the digest asks')],
  ['H1 the Claude --settings is unguarded', HIVE, "this.guardHookSettings(meta.id, 'claude', settingsPath, withSkillOverrides(this.hookSettings(shim, meta.cwd, opts.mcpDefaults, opts.theme, hookUrl, meta.id) as object, trim))", 'withSkillOverrides(this.hookSettings(shim, meta.cwd, opts.mcpDefaults, opts.theme, hookUrl, meta.id) as object, trim)', at('Claude: a prompt/agent hook')],
  ['H2 a strip is not logged', HIVE, '    const r = stripSettingsHooks(settings);\n    if (r.stripped.length) this.appendLog(', '    const r = stripSettingsHooks(settings);\n    if (false) this.appendLog(', at('Claude: a prompt/agent hook')],
  ['H3 Claude spawns do not scan', HIVE, "      this.scanForeignHooks(meta.id, 'claude', meta.cwd);\n", '', at('Claude: a prompt/agent hook')],
  ['H4 the same warning is logged again', HIVE, '    if (prev && prev.findings === text) return;\n', '', at('foreign warnings: one row')],
  ['H5 a fixed file keeps its warning', HIVE, 'if (prev) { this.modelHookFiles.delete(file); ', 'if (prev) { ', at('foreign warnings: one row')],
  ['H6 the AGY group is unguarded', HIVE, "const group = this.guardHookMap(null, 'antigravity', `hooks.json[${AGY_OWN_KEY}]`, {", 'const group = ((x: Record<string, unknown>) => x)({', at('wiring: AGY, Gemini and Grok')],
  ['H7 the Gemini settings are unguarded', HIVE, "JSON.stringify(this.guardHookSettings(agentId, 'gemini', settingsPath, settings), null, 2)", 'JSON.stringify(settings, null, 2)', at('wiring: AGY, Gemini and Grok')],
  ['H8 the Grok file is unguarded', HIVE, "JSON.stringify(this.guardHookSettings(null, 'grok', GROK_OWN_FILE, { hooks }), null, 2)", 'JSON.stringify({ hooks }, null, 2)', at('wiring: AGY, Gemini and Grok')],
  ['H9 a strip log is shared by every map', HIVE, "    const r = stripHookMap(hooks);\n    if (r.stripped.length) this.appendLog(", "    const r = stripHookMap(hooks);\n    if (false) this.appendLog(", at('wiring: AGY, Gemini and Grok')],
  ['H10 AGY spawns do not scan', HIVE, "              this.scanForeignHooks(meta.id, 'antigravity', meta.cwd);\n", '', at('pins:')],
  ['H11 Codex spawns do not scan', HIVE, "              this.scanForeignHooks(meta.id, 'codex', meta.cwd);\n", '', at('pins:')],
  ['H12 Gemini spawns do not scan', HIVE, "              this.scanForeignHooks(meta.id, 'gemini', meta.cwd);\n", '', at('pins:')],
  ['H13 Grok spawns do not scan', HIVE, "              this.scanForeignHooks(meta.id, 'grok', meta.cwd);\n", '', at('pins:')],
  ['H14 the Codex seed is not stripped', HIVE, '          config = g.text;\n', '', at("Codex: the seed's model hooks")],
  ['H15 the Codex seed strip is not logged', HIVE, "this.appendLog({ kind: 'hook-type-guard', agentId: agentId ?? null, provider: 'codex', file: join(home, 'config.toml'), action: 'strip',", "void ({ kind: 'hook-type-guard', agentId: agentId ?? null, provider: 'codex', file: join(home, 'config.toml'), action: 'strip',", at("Codex: the seed's model hooks")],
  ['H16 an uncleanable seed is not refused there', HIVE, '        if (!g.clean) {', '        if (false) {', at("Codex: the seed's model hooks")],
  ['H17 the seed warning claims no strip', HIVE, "f.kind === 'codex-toml');", 'false);', at("Codex: the seed's model hooks")],
  ['H18 no final scan before the write', HIVE, '      if (finalHooks && finalHooks.length) {', '      if (false) {', at('wiring: a Codex config that still')],
  ['H19 project layers are not scanned', HIVE, '          this.scanCodexLayerHooks(agentId ?? null, report);\n', '', at('pins:')],
  ['H20 a worktree layer is scanned in place of its main checkout', HIVE, 'const dir = l.hooksFrom ?? l.dotCodex;', 'const dir = l.dotCodex;', at('Codex: a loading project layer')]
];

const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
if (run().status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(2);
}

let bad = 0;
for (const [name, rel, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${at < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, at) + to + source.slice(at + from.length);
  if (original.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  let r;
  try {
    fs.writeFileSync(abs, mutated);
    r = run();
  } finally {
    fs.writeFileSync(abs, original);
  }
  const named = dies.test(`${r.stdout}${r.stderr}`);
  const killed = r.status !== 0 && named;
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
