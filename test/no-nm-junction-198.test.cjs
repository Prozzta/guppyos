'use strict';
/**
 * WORK-JUNCTION-DEBT step 3 (god 06:27Z): no new junction debt. A worktree whose node_modules is a
 * junction makes its target undeletable and `git worktree remove --force` empties that target (the
 * 10-17 MunderDev loss); 252 such links had piled up under C:/Dunder/_work. No release, prune or
 * setup script may create a junction, symlink or other reparse point: every npm script, every
 * file under scripts/ and tools/, the CI workflows and the release docs are scanned for
 * link-making calls and commands. Product code (src/) is out of scope: its two links are runtime
 * aliases (a home alias, an auth file), never node_modules.
 *
 * Named mutant (the scanner's teeth, below): each link-making form is caught in a planted file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Each form that makes a link: Node's fs, cmd's mklink, PowerShell's New-Item, POSIX ln -s. */
const LINK_MAKERS = [
  /\b(?:fs(?:\.promises)?\.|fsp\.|\b)symlink(?:Sync)?\s*\(/,
  /\bmklink\b/i,
  /New-Item\b[^\n]*-ItemType\s+['"]?(?:Junction|SymbolicLink|HardLink)\b/i,
  /\bln\s+-[a-z]*s[a-z]*\b/,
  // Sysinternals junction: its first argument is a path (a slash, a quote, a variable or node_modules), not prose.
  /\bjunction(?:64)?(?:\.exe)?\s+(?:-\w+\s+)*(?:["'$%]|node_modules|\S*[\\/])[^\n]*node_modules/i
];

/** Every line of `text` that makes a link, as `file:line: text`. */
function linkMakers(file, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => { if (LINK_MAKERS.some((re) => re.test(line))) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`); });
  return out;
}

function filesUnder(dir, keep) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
      else if (keep(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('no npm script, script, tool, workflow or release doc creates a junction, symlink or reparse point', () => {
  const hits = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) hits.push(...linkMakers(`package.json scripts.${name}`, String(cmd)));
  const code = /\.(c?m?js|ts|ps1|cmd|bat|sh|ya?ml)$/i;
  const scanned = [
    ...filesUnder(path.join(ROOT, 'scripts'), (n) => code.test(n)),
    ...filesUnder(path.join(ROOT, 'tools'), (n) => code.test(n) || /\.md$/i.test(n)),
    ...filesUnder(path.join(ROOT, '.github'), (n) => code.test(n)),
    ...filesUnder(path.join(ROOT, 'docs'), (n) => /^release.*\.md$/i.test(n))
  ];
  assert.ok(scanned.length >= 10, `the scan sees the trees (${scanned.length} files)`);
  for (const f of scanned) hits.push(...linkMakers(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], `link-making lines (no new junction debt; give the tree its own npm ci):\n${hits.join('\n')}`);
});

test('the scanner catches every link-making form (teeth)', () => {
  const planted = [
    "fs.symlinkSync(src, path.join(wt, 'node_modules'), 'junction');",
    "await fs.promises.symlink(a, b, 'dir');",
    "symlinkSync(a, b);",
    'cmd /c mklink /J node_modules C:\\Dunder\\MunderDev\\node_modules',
    "New-Item -ItemType Junction -Path node_modules -Target ..\\x\\node_modules",
    'New-Item -Path nm -ItemType SymbolicLink -Value y',
    'ln -sf ../shared/node_modules node_modules',
    'junction.exe node_modules C:\\x\\node_modules',
    'junction64 -q "C:\\w\\t\\node_modules" C:\\x\\node_modules'
  ];
  for (const line of planted) assert.equal(linkMakers('planted', line).length, 1, line);
  // Reading links stays allowed (the reaper and the prune walk them).
  for (const line of ['fs.readlinkSync(p)', 'st.isSymbolicLink()', 'fs.lstatSync(c)', "// never through a junction", 'realpathSync(link)',
    // Prose that names a junction (docs/release-checklist.md since RELEASE-WORKTREE-PRUNE).
    "`node_modules` junction into a cut tree's), and never removes through a `node_modules` junction."])
    assert.equal(linkMakers('reader', line).length, 0, line);
});
