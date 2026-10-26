'use strict';
/**
 * Census for CLAIMS-90 T6 labeller --provider codex (god 495956, cfacba, 8d13d1; Jim 475eab, 49a485, f7d551). Each
 * mutant injects ONE named regression into labeller-jail-mcp.cjs, labeller-codex.cjs or labeller.cjs, runs the codex
 * labeller test, and must turn it RED. A missing or non-unique anchor is INERT and fails the run. The claude path is
 * judged by the existing labeller test, run unmutated at the end.
 *
 *   node test/tools/claims90-labeller-codex-mutants.cjs [name-prefix]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const MCP = 'test/claims-90/labeller-jail-mcp.cjs';
const CX = 'test/claims-90/labeller-codex.cjs';
const LAB = 'test/claims-90/labeller.cjs';
const M = [
  // Prevention: the path check refuses before any read (god cfacba, Jim f7d551 1 and 5).
  ['P1 a drive/stream/device colon is allowed', MCP, "  if (arg.includes(':')) return 'a drive, stream or device path';\n", ''],
  ['P2 env/home/short-name forms are allowed', MCP, "  if (/[%$~]/.test(arg)) return 'an env, home or short-name form';\n", ''],
  ['P3 rooted/UNC/device paths are allowed', MCP, "  if (/^[\\\\/]/.test(arg)) return 'a rooted, UNC or device path';\n", ''],
  ['P4 a parent segment is allowed', MCP, "    if (seg === '..') return 'a parent (..) segment';\n", ''],
  ['P5 a trailing dot or space is allowed', MCP, "    if (seg !== '.' && /[. ]$/.test(seg)) return 'a name ending in a dot or space';\n", ''],
  ['P6 a device name is allowed', MCP, "    if (DEVICE.test(seg)) return 'a device name';\n", ''],
  ['P7 a link on the way is followed', MCP, "    if (st.isSymbolicLink()) return { refused: 'a link or junction' };\n", ''],
  ['P8 the walker enters links', MCP, "      if (e.isSymbolicLink() || fs.lstatSync(p).isSymbolicLink()) { links.push(path.relative(root, p)); continue; }\n", ''],
  ['P9 a folder holding a link is searched', MCP, '    if (links.length) return { refused: `the folder holds a link or junction (${links[0]})` };\n', ''],
  ['P10 read_file skips the path check', MCP, "    const p = jailPath(jail, a.path);\n    if (p.refused) return { refused: p.refused };\n    if (!fs.statSync(p.real)", "    const p = { real: path.resolve(jail, a.path) };\n    if (!fs.statSync(p.real)"],
  // Search and list globs never widen the root; output bounded (Jim f7d551 2).
  ['G1 a glob parent segment is allowed', MCP, "  if (g.split(/[\\\\/]+/).includes('..')) return 'a glob with a parent (..) segment';\n", ''],
  ['G2 a glob problem is ignored', MCP, '    if (gp) return { refused: gp };\n', ''],
  ['G3 search hits are unbounded', MCP, 'if (out.length < SEARCH_MAX) out.push(', 'if (true) out.push('],
  ['G4 read lines are unbounded', MCP, '    const n = Math.min(READ_MAX_LINES, Math.max(1, Number(a.limit) || READ_MAX_LINES));', '    const n = Math.max(1, Number(a.limit) || 1e9);'],
  // git: read commands only, no file-reading option, no outside path.
  ['T1 any git subcommand runs', MCP, "    if (!GIT_SUBS.has(args[0])) return ", '    if (false) return '],
  ['T2 git file options are allowed', MCP, "      if (GIT_DENY.test(x)) return ", '      if (false) return '],
  ['T3 git absolute paths are allowed', MCP, "      if (/(^|=)([A-Za-z]:|[\\\\/])/.test(x)) return ", '      if (false) return '],
  // The session has no shell, no allow rules and only the jail tools (god cfacba / 8d13d1).
  ['S1 shell tool stays on', CX, "const FEATURES_OFF = ['shell_tool', ", 'const FEATURES_OFF = ['],
  ['S2 view_image stays on', CX, "'unified_exec', 'view_image', ", "'unified_exec', "],
  ['S3 no jail-only read profile', CX, "    '-c', 'default_permissions=\"labeller\"', ", '    '],
  ['S4 rules files load', CX, "'--ignore-user-config', '--ignore-rules', '--color'", "'--ignore-user-config', '--color'"],
  ['S5 the jail tools need approval', CX, "    ...MCP.TOOLS.flatMap((t) => ['-c', `mcp_servers.jail.tools.${t.name}.approval_mode=\"approve\"`]),\n", ''],
  ['S6 a foreign item is not INVALID', CX, '  if (a.otherItems.length) return ', '  if (false) return '],
  ['S7 another MCP server counts as the jail', CX, " || (it.type === 'mcp_tool_call' && it.server !== 'jail')", ''],
  // Every refused call means INVALID; the open log is the server's log.
  ['R1 a refused call is not INVALID', CX, '  if (s.refused) return ', '  if (false) return '],
  ['R2 the open log gets no codex rows', CX, "    fs.appendFileSync(openLog, res.reads.map(", "    void (openLog, res.reads.map("],
  ['R3 a refused row reads as jail', CX, "place: j.decision === 'allow' ? 'jail' : 'outside'", "place: 'jail'"],
  // Jim 475eab: env leak, leftovers, missing row.
  ['E1 codexEnv keeps hive keys', CX, '  for (const [k, v] of Object.entries(base)) if (!LEAK_KEY.test(k)) env[k] = v;', '  for (const [k, v] of Object.entries(base)) env[k] = v;'],
  ['E2 codexEnv keeps hive PATH dirs', CX, '.filter((d) => d && !HIVE_DIR.test(d))', '.filter((d) => d)'],
  ['E3 an env leak is not INVALID', CX, '  if (s.envLeaks.length) return ', '  if (false) return '],
  ['H1 CODEX_HOME is not deleted', CX, "    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });\n", ''],
  ['H2 the login copy stays until the end', CX, "          if (!started && j.type === 'thread.started') { started = true; takeAuth(); continue; }", "          if (!started && j.type === 'thread.started') { started = true; continue; }"],
  ['H3 a codex session file is not INVALID', CX, '  if (s.leftovers.length) return ', '  if (false) return '],
  ['H4 the leftover scan sees nothing', CX, "  for (const sub of ['sessions', 'archived_sessions']) {", "  for (const sub of []) {"],
  ['H5 a left CODEX_HOME is not INVALID', CX, "  if (!s.homeRemoved || !s.authAbsentAfter) return ", '  if (false) return '],
  ['K1 a missing row is not INVALID', CX, '  if (key.missing.length) return ', '  if (false) return '],
  // Credentials: redacted, INVALID, never written back (Jim 49a485).
  ['C1 output is not redacted', CX, "  for (const s of secrets) if (t.includes(s)) { found++; t = t.split(s).join('[REDACTED]'); }", '  for (const s of secrets) if (t.includes(s)) { found++; }'],
  ['C2 a refreshed login is written back', CX, "    res.realAuthChanged = !fs.readFileSync(authFile).equals(original);\n", "    res.realAuthChanged = !fs.readFileSync(authFile).equals(original);\n    if (res.authRefreshed) { fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-access-REFRESHED-0001' } })); res.authWrittenBack = true; }\n"],
  ['C3 a credential hit is not INVALID', CX, '  if (s.credentialHits) return ', '  if (false) return '],
  ['C4 a refreshed login is not INVALID', CX, '  if (s.authRefreshed) return ', '  if (false) return '],
  ['C5 a real-login change is not recorded', CX, '    res.realAuthChanged = !fs.readFileSync(authFile).equals(original);', '    res.realAuthChanged = false;'],
  // The rest of the audit.
  ['A1 a jail write is not INVALID', CX, "  if (s.jailChanged) return ", '  if (false) return '],
  ['A2 a project layer is not INVALID', CX, '  if (s.projectLayer.length) return ', '  if (false) return '],
  ['A3 a jail path codex cannot key is passed on', CX, '  if (/[.="]/.test(fwd(jail))) throw new Error(', '  if (false) throw new Error('],
  ['A4 a permission key segment is quoted again', CX, "'-c', 'permissions.labeller.filesystem.:minimal=\"read\"'", "'-c', 'permissions.labeller.filesystem.\":minimal\"=\"read\"'"],
  // main wiring.
  ['W1 main appends before judging', LAB, '      const reason = CX.codexReason(s, key, own);\n      if (reason) return finish', '      const reason = null;\n      if (reason) return finish'],
  ['W2 codex gets the claude default model', LAB, "    o.model = o.model || null;\n    return o;", "    o.model = o.model || 'claude-opus-5-5';\n    return o;"],
];

const unit = (file) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
const lf = (s) => s.replace(/\r\n/g, '\n');
const prefix = process.argv[2] || '';
let killed = 0; let inert = 0; let n = 0;
for (const [name, file, from, to] of M.filter(([nm]) => nm.startsWith(prefix))) {
  n++;
  const abs = path.join(ROOT, file);
  const orig = fs.readFileSync(abs, 'utf8');
  const t = lf(orig);
  const at = t.indexOf(from);
  if (at < 0 || t.indexOf(from, at + 1) >= 0) { inert++; console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`); continue; }
  let mutated = t.slice(0, at) + to + t.slice(at + from.length);
  if (orig.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    fs.writeFileSync(abs, mutated);
    const r = unit('test/claims-90-labeller-codex.test.cjs');
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${(String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?'})`);
  } finally {
    fs.writeFileSync(abs, orig);
  }
}
const claude = unit('test/claims-90-labeller.test.cjs');
console.log(`claude labeller test unmutated: exit ${claude.status} ${(String(claude.stdout).match(/^# pass \d+/m) || [''])[0]}`);
console.log(`\n${killed}/${n} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === n && claude.status === 0 ? 0 : 1);
