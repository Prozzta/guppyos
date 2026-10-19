'use strict';
/**
 * BUILD-LEFTOVERS-USERNAME-197: release check on a built app.asar (packed and unpacked files).
 *
 * The 1.1.95 and 1.1.96 installers shipped node-pty's native build leftovers: MSBuild project files
 * (build/*.vcxproj, node-addon-api/*.vcxproj), linker intermediates (build/Release/*.{iobj,ipdb,exp,lib})
 * and MSBuild logs (build/**\/obj/**\/*.tlog). The app never loads them (node-pty's loadNativeModule
 * takes build/Release/<name>.node; winpty.dll and winpty-agent.exe sit beside it), and 30 of them
 * hold the build machine's user folder (C:\Users\<user>\.electron-gyp...), 18 only in UTF-16.
 * electron-builder.yml now excludes them; this check fails a build that still has them.
 *
 *   node scripts/verify-packaged-identity.cjs dist/win-unpacked/resources/app.asar
 *
 * 1. Leftovers: under node_modules/node-pty/build only Release/<name>.{node,dll,exe} may ship, and
 *    no *.vcxproj may ship anywhere.
 * 2. Identity: no file holds the build machine's user name (os.userInfo, USERNAME, the USERPROFILE
 *    folder), nor any word in GUPPY_IDENTITY_WORDS (comma-separated; the cut passes private words here
 *    so they never sit in the repo). Matched case-blind, as latin1 and as UTF-16LE text.
 *    A word under MIN_WORD characters is left out (said in the result): it would match by chance.
 */
const os = require('os');
const path = require('path');

const MIN_WORD = 4;
const PTY_BUILD = 'node_modules/node-pty/build/';
const RUNTIME = /^node_modules\/node-pty\/build\/Release\/[^/]+\.(node|dll|exe)$/;
// MSBuild output that is never a runtime file, wherever a native module leaves it.
const MSBUILD = /(\.(vcxproj|filters|tlog|iobj|ipdb|ilk|pdb|recipe|lastbuildstate)$)|(\/(Release|Debug)\/obj\/)/;

/** The asar's file paths as forward-slash paths with no leading slash. */
const norm = (f) => f.replace(/\\/g, '/').replace(/^\//, '');

/** Problems with the list of FILES (folders left out; pure). */
function leftoversOf(files) {
  const problems = [];
  for (const f of files.map(norm)) {
    if (f.startsWith(PTY_BUILD) && !RUNTIME.test(f)) problems.push(`native build leftover ${f}`);
    else if (f.startsWith('node_modules/') && MSBUILD.test(f)) problems.push(`native build leftover ${f}`);
  }
  return problems;
}

/** The words the scan looks for: the build machine's user name and the extra words; short ones are dropped. */
function identityWords({ env = process.env, userInfo = () => os.userInfo() } = {}) {
  let user = '';
  try { user = userInfo().username || ''; } catch { /* no user record */ }
  const raw = [user, env.USERNAME, env.USERPROFILE && path.win32.basename(env.USERPROFILE), env.USER,
    ...String(env.GUPPY_IDENTITY_WORDS || '').split(',')];
  const all = [...new Set(raw.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean))];
  return { words: all.filter((w) => w.length >= MIN_WORD), short: all.filter((w) => w.length < MIN_WORD) };
}

/** The words found in one file's bytes (pure). */
function hitsIn(buf, words) {
  const latin = buf.toString('latin1').toLowerCase();
  const wide = buf.toString('utf16le').toLowerCase();
  const odd = buf.length > 1 ? buf.subarray(1).toString('utf16le').toLowerCase() : '';
  return words.filter((w) => latin.includes(w) || wide.includes(w) || odd.includes(w));
}

function verify(asarPath, opts = {}) {
  const asar = require('@electron/asar');
  const problems = [];
  let files;
  try { files = asar.listPackage(asarPath); }
  catch (e) { return { ok: false, problems: [`cannot read ${asarPath}: ${e.message}`], scanned: 0, words: 0, short: [] }; }
  const isDir = (f) => { try { return 'files' in asar.statFile(asarPath, f.replace(/^[\\/]/, '')); } catch { return false; } };
  files = files.filter((f) => !isDir(f));
  problems.push(...leftoversOf(files));
  const { words, short } = identityWords(opts);
  if (!words.length) problems.push('no identity word to scan for (no user name found)');
  let scanned = 0;
  try {
    for (const f of files) {
      let buf;
      // extractFile takes the listing's own separators (a forward-slash path misses on Windows).
      try { buf = asar.extractFile(asarPath, f.replace(/^[\\/]/, '')); } catch { continue; } // a folder
      if (!buf || !buf.length) continue;
      scanned++;
      // The word itself is never printed: a release log is public.
      for (const w of hitsIn(buf, words)) problems.push(`identity word #${words.indexOf(w) + 1} in ${norm(f)}`);
    }
  } finally { try { asar.uncache(asarPath); } catch { /* release the handle */ } }
  if (!scanned) problems.push('no file could be read from the asar');
  return { ok: problems.length === 0, problems, scanned, words: words.length, short };
}

module.exports = { verify, leftoversOf, identityWords, hitsIn, MIN_WORD };

if (require.main === module) {
  const p = process.argv[2];
  if (!p) { console.error('usage: verify-packaged-identity.cjs <app.asar>'); process.exit(2); }
  const r = verify(p);
  if (r.short.length) console.log(`(${r.short.length} word(s) under ${MIN_WORD} characters left out)`);
  if (r.ok) { console.log(`IDENTITY CLEAN: ${r.scanned} files, ${r.words} word(s), no build leftovers`); process.exit(0); }
  for (const x of r.problems.slice(0, 50)) console.error(`  - ${x}`);
  if (r.problems.length > 50) console.error(`  ... and ${r.problems.length - 50} more`);
  console.error(`IDENTITY FOUND (${r.problems.length})`);
  process.exit(1);
}
