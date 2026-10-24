'use strict';
/**
 * CODEX-MCP-ISOLATION: a codex agent's generated config.toml was seeded from the user's
 * ~/.codex/config.toml verbatim outside DEV, so the node_repl MCP server it inherits ran with
 * CODEX_HOME, NODE_REPL_TRUSTED_CODE_PATHS and NODE_REPL_TRUSTED_SERVICES pointing into the real
 * ~/.codex (and the bundled marketplace source too). These tests spawn a codex agent through
 * ensureAgent on a redirected HOME whose seed has that shape, then walk every string in the
 * generated config and every value in the spawn env: none may resolve into the real ~/.codex.
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const cfg = loadTs('src/main/codexAgentConfig.ts');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-iso-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

/** The shape of the Human's seed (paths only, under the redirected home), in each TOML string form. */
function seedFor(home) {
  const real = path.join(home, '.codex');
  const rt = path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'runtimes', 'cua_node', 'r1', 'bin');
  const esc = (s) => s.replace(/\\/g, '\\\\');
  const fwd = (s) => s.replace(/\\/g, '/');
  return [
    'model = "gpt-6-astra"',
    `notify = ['${path.join(rt, 'notify.exe')}', "turn"]`,
    '',
    '[marketplaces.openai-bundled]',
    `source = '${path.join(real, '.tmp', 'bundled-marketplaces', 'openai-bundled')}'`,
    '',
    '[mcp_servers.node_repl]',
    `command = '${path.join(rt, 'node_repl.exe')}'`,
    `args = [`,
    `  "${esc(path.join(real, 'plugins', 'cache', 'repl.mjs'))}",`,
    ']',
    '',
    '[mcp_servers.node_repl.env]',
    `NODE_REPL_NODE_PATH = '${path.join(rt, 'node.exe')}'`,
    `NODE_REPL_TRUSTED_CODE_PATHS = "${esc(real)};${esc(path.join(rt, 'node_modules'))}"`,
    `CODEX_HOME = '${real}'`,
    `NODE_REPL_TRUSTED_SERVICES = "${fwd(path.join(real, 'plugins', 'cache', 'openai-bundled', 'browser', '1', 'scripts', 'browser-service.mjs'))}"`,
    `CODEX_STATE = '${real.toUpperCase()}\\state'`,
    // JSON held in a literal string: the separators are doubled (Jim MINOR2 ii).
    `NODE_REPL_JSON = '{"home":"${esc(path.join(real, 'p'))}"}'`,
    '',
    '[mcp_servers.other]',
    `env = { CODEX_HOME = "${esc(real)}", KEEP = '${path.join(home, '.codex-backup')}' }`,
    '',
  ].join('\n');
}

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const text = seed ?? seedFor(home);
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), text);
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => hive.dispose());
  return { home, hive, seed: text };
}

// Doubled separators collapse, so a path escaped inside JSON in a string is seen too.
const norm = (s) => s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
/** Every spelling of the real profile root that a path value could resolve to. */
function realRoots(home) {
  return [norm(path.join(home, '.codex')), '~/.codex'];
}
/** True when `value` names a path at or under the real ~/.codex (any slash style or case). */
function hitsReal(value, roots) {
  const v = norm(String(value));
  return roots.some((r) => {
    let i = v.indexOf(r);
    while (i >= 0) {
      const next = v.charAt(i + r.length);
      if (next === '' || next === '/' || next === ';' || next === ',' || next === ' ') return true;
      i = v.indexOf(r, i + 1);
    }
    return false;
  });
}
/** Every string leaf of a parsed TOML document, with its dotted key. */
function strings(node, at = '') {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((x, i) => strings(x, `${at}[${i}]`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => strings(v, at ? `${at}.${k}` : k));
  return [];
}

async function spawnCodex(s, id = 'cx-iso') {
  const r = await s.hive.ensureAgent({ id, name: 'Codex', provider: 'codex', cwd: s.home }, { codexNoDaemon: true });
  const text = fs.readFileSync(path.join(r.env.CODEX_HOME, 'config.toml'), 'utf8');
  return { r, text, doc: toml.parse(text) };
}

test('THE walk: no string in the generated config.toml and no spawn env value resolves into the real ~/.codex', async (t) => {
  const s = sandbox(t);
  const { r, doc } = await spawnCodex(s);
  const roots = realRoots(s.home);
  // Control: the walker sees the seed's leaks, so a clean result below is not a blind walker.
  const seeded = strings(toml.parse(s.seed)).filter(([, v]) => hitsReal(v, roots)).map(([k]) => k);
  assert.ok(seeded.length >= 8,`control: the seed must carry the real-home paths (${seeded.join(', ')})`);
  const leaks = strings(doc).filter(([, v]) => hitsReal(v, roots)).map(([k]) => k);
  assert.deepEqual(leaks, [], `generated config.toml paths into the real ~/.codex: ${leaks.join(', ')}`);
  const envLeaks = Object.entries(r.env).filter(([, v]) => hitsReal(v, roots)).map(([k]) => k);
  assert.deepEqual(envLeaks, [], `spawn env values into the real ~/.codex: ${envLeaks.join(', ')}`);
});

test('the nested helper homes are the AGENT home: every CODEX_HOME key, and paths under ~/.codex map to the same place under it', async (t) => {
  const s = sandbox(t);
  const { r, doc } = await spawnCodex(s);
  const agent = r.env.CODEX_HOME;
  assert.equal(norm(path.dirname(agent)), norm(path.join(s.home, 'harness', 'hive', 'agents', 'cx-iso')), 'the agent home is under the agent dir');
  const env = doc.mcp_servers.node_repl.env;
  assert.equal(env.CODEX_HOME, agent);
  assert.equal(doc.mcp_servers.other.env.CODEX_HOME, agent, 'an inline-table CODEX_HOME too');
  assert.equal(env.NODE_REPL_TRUSTED_CODE_PATHS.split(';')[0], agent, 'the trusted root is the agent home');
  assert.equal(env.NODE_REPL_TRUSTED_SERVICES, `${agent.replace(/\\/g, '/')}/plugins/cache/openai-bundled/browser/1/scripts/browser-service.mjs`, 'same slash style, same subpath');
  assert.equal(env.CODEX_STATE, path.join(agent, 'state'), 'a differently cased spelling is the same Windows path');
  assert.equal(JSON.parse(env.NODE_REPL_JSON).home, path.join(agent, 'p'), 'JSON in a literal: doubled separators, still valid JSON');
  assert.equal(doc.marketplaces['openai-bundled'].source, path.join(agent, '.tmp', 'bundled-marketplaces', 'openai-bundled'));
  assert.equal(doc.mcp_servers.node_repl.args[0], path.join(agent, 'plugins', 'cache', 'repl.mjs'), 'a multi-line array element too');
});

test('the shared Codex runtime outside ~/.codex is kept verbatim (node_repl still starts), and a lookalike sibling is not touched', async (t) => {
  const s = sandbox(t);
  const { doc } = await spawnCodex(s);
  const seed = toml.parse(s.seed);
  assert.equal(doc.mcp_servers.node_repl.command, seed.mcp_servers.node_repl.command);
  assert.equal(doc.mcp_servers.node_repl.env.NODE_REPL_NODE_PATH, seed.mcp_servers.node_repl.env.NODE_REPL_NODE_PATH);
  assert.equal(doc.mcp_servers.node_repl.env.NODE_REPL_TRUSTED_CODE_PATHS.split(';')[1], seed.mcp_servers.node_repl.env.NODE_REPL_TRUSTED_CODE_PATHS.split(';')[1]);
  assert.deepEqual(doc.notify, seed.notify);
  assert.equal(doc.mcp_servers.other.env.KEEP, path.join(s.home, '.codex-backup'), '~/.codex-backup is not ~/.codex');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), s.seed, 'the user\'s file is never written');
});

test('pure: isolateCodexHomePaths rewrites values only, leaves table headers and comments-free lines alone, and counts', () => {
  const real = 'C:\\Users\\u\\.codex';
  const agent = 'C:\\H\\agents\\a\\.codex';
  const src = [
    `[projects.'${real}\\proj']`,
    'trust_level = "trusted"',
    `CODEX_HOME = "D:\\\\elsewhere"`,
    `x = '${real}'`,
    `y = "C:/users/U/.codex/a"`,
    `z = '~/.codex/b'`,
  ].join('\n');
  const out = cfg.isolateCodexHomePaths(src, { userCodexHome: real, agentCodexHome: agent, win32: true });
  const lines = out.text.split('\n');
  assert.equal(lines[0], src.split('\n')[0], 'a header is a key, not a value');
  assert.equal(lines[2], `CODEX_HOME = '${agent}'`, 'every CODEX_HOME key is the agent home, whatever it held');
  assert.equal(lines[3], `x = '${agent}'`);
  assert.equal(lines[4], `y = "C:/H/agents/a/.codex/a"`);
  assert.equal(lines[5], `z = 'C:/H/agents/a/.codex/b'`);
  assert.equal(out.rewritten, 4);
  const posix = cfg.isolateCodexHomePaths(`x = "/home/U/.codex/a"`, { userCodexHome: '/home/u/.codex', agentCodexHome: '/h/a/.codex', win32: false });
  assert.equal(posix.text, `x = "/home/U/.codex/a"`, 'case is significant off Windows');
  // A basic string with an escape other than \\ and \" is left as written: re-encoding it would change it.
  const esc = `e = "C:\\\\Users\\\\u\\\\.codex\\\\x\\u0041"`;
  assert.equal(cfg.isolateCodexHomePaths(esc, { userCodexHome: real, agentCodexHome: agent, win32: true }).text, esc);
});

// Jim's audit of c2cc5176 (2 MINOR + 3 NIT): each finding is pinned below on the pure transform.
const R = 'C:\\Users\\u\\.codex';
const A = 'C:\\H\\agents\\a\\.codex';
const iso = (text, win32 = true) => cfg.isolateCodexHomePaths(text, { userCodexHome: R, agentCodexHome: A, win32 });

test('MINOR1: a multi-line string body is prose and is copied as written, CODEX_HOME = and quoted ~/.codex paths included', () => {
  for (const q of ['"""', "'''"]) {
    const body = `d = ${q}\nsee '${R}\\AGENTS.md' and "~/.codex/x"\nCODEX_HOME = "kept"\n[not.a.header]\n${q}\n`;
    const out = iso(`${body}after = '${R}\\a'\n`);
    assert.equal(out.text, `${body}after = '${A}\\a'\n`, `${q}: the body is untouched and the value after it is still rewritten`);
    assert.equal(out.rewritten, 1);
  }
  // A body may end in one or two quotes before the closer.
  const tail = `d = """x ""${'"""'}\nv = '${R}'\n`;
  assert.equal(iso(tail).text, `d = """x ""${'"""'}\nv = '${A}'\n`);
});

test('MINOR2 (i): a line inside an open array that looks like a header is a value; a header is found only at the top level', () => {
  const src = `a = [\n  ['${R}\\x'],\n  ['${R}\\y']\n]\n[t]\nb = '${R}'\n`;
  assert.equal(iso(src).text, `a = [\n  ['${A}\\x'],\n  ['${A}\\y']\n]\n[t]\nb = '${A}'\n`);
});

test('MINOR2 (ii): the root with doubled separators (JSON in a literal string) maps with doubled separators', () => {
  const src = `s = '{"b":"${R.replace(/\\/g, '\\\\')}\\\\p\\\\b.mjs"}'\n`;
  const out = iso(src);
  assert.equal(out.text, `s = '{"b":"${A.replace(/\\/g, '\\\\')}\\\\p\\\\b.mjs"}'\n`);
  assert.equal(JSON.parse(toml.parse(out.text).s).b, `${A}\\p\\b.mjs`, 'still valid JSON naming the agent home');
  const fwd = iso(`s = '{"b":"C://Users//u//.codex//p"}'\n`);
  assert.equal(fwd.text, `s = '{"b":"C://H//agents//a//.codex//p"}'\n`, 'doubled forward slashes keep their style');
});

test('NIT1: line endings are kept; a seed with nothing to rewrite comes back byte-identical', () => {
  const crlf = `a = 1\r\n# c '${R}'\r\n[t]\r\nb = '${R}'\r\n`;
  assert.equal(iso(crlf).text, `a = 1\r\n# c '${R}'\r\n[t]\r\nb = '${A}'\r\n`);
  const clean = 'model = "x"\r\n\r\n[tui]  # keep\r\nalt = "never"\r\narr = [ 1, 2 ,3 ]\r\nt = { a = 1, b = "two" }\r\n';
  const out = iso(clean);
  assert.equal(out.text, clean);
  assert.equal(out.rewritten, 0);
});

test('NIT2 + boundaries: ~/.codex after a "/" is a URL path, not the profile; a path character before or after the root is not the root', () => {
  const src = [`u = 'https://h/~/.codex/x'`, `v = '~/.codex/x'`, `w = 'a;~/.codex'`,
    `p = 'X${R}'`, `q = '${R}2'`, `r = '${R}-backup'`, `s = 'C:\\Users\\uu\\.codex'`, `x = '\\\\?\\${R}\\m'`, ''].join('\n');
  const lines = iso(src).text.split('\n');
  assert.equal(lines[0], `u = 'https://h/~/.codex/x'`);
  assert.equal(lines[1], `v = 'C:/H/agents/a/.codex/x'`);
  assert.equal(lines[2], `w = 'a;C:/H/agents/a/.codex'`);
  assert.deepEqual(lines.slice(3, 7), src.split('\n').slice(3, 7), 'X<root>, <root>2, <root>-backup and a lookalike user are not the root');
  assert.equal(lines[7], `x = '\\\\?\\${A}\\m'`, 'the extended-length prefix still names the root');
});

test('NIT3: CODEX_HOME is a parsed key (bare, quoted, dotted, inline); the same text inside a string or a header is not', () => {
  const src = [`"CODEX_HOME" = 'D:\\o'`, `env.CODEX_HOME = 'D:\\o'`, `t = { 'CODEX_HOME' = "D:\\\\o", k = 1 }`,
    `desc = "a, CODEX_HOME = 'q'"`, `[projects.'${R}\\a]b'] # CODEX_HOME = 'q'`, `trust_level = 'trusted'`, ''].join('\n');
  const lines = iso(src).text.split('\n');
  assert.equal(lines[0], `"CODEX_HOME" = '${A}'`);
  assert.equal(lines[1], `env.CODEX_HOME = '${A}'`);
  assert.equal(lines[2], `t = { 'CODEX_HOME' = '${A}', k = 1 }`);
  assert.deepEqual(lines.slice(3), src.split('\n').slice(3), 'string contents, a header holding "]" and its comment are untouched');
});
