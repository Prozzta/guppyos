'use strict';

// NODEPTY-PACKAGED-PROOF: prove node-pty's root-handle patch on a PACKAGED app.
// This is `node tools/patch-node-pty-root-handle.cjs --packaged <dir>`; it reads, and writes nothing.
//
// Why. The source tree's checks (--check, the postinstall record) say what was installed. What a
// user runs is what electron-builder copied: app.asar and, beside it, app.asar.unpacked with the
// native modules. A cut reasoned from the first to the second. This reads the second.
//
// What must hold, in <resources>/app.asar.unpacked/node_modules/node-pty:
//   1 it is node-pty <pinned version>
//   2 lib/windowsPtyAgent.js is the pinned handoff form (it keeps `rootHandle`)
//   3 lib/utils.js is the pinned built-only loader (no prebuilt fallback on Windows)
//   4 build/Release/conpty.node is the binary the install recorded, built from the pinned source
//   5 that binary imports DuplicateHandle (the handoff) and the SRW locks (#922)
//   6 src/win/conpty.cc, when it ships, is the pinned source
//   7 no prebuilt Windows binary ships, and the only conpty.node under resources is the built one
// and in <resources>/app.asar:
//   8 node-pty is listed, every file of it is unpacked (so the files read above are the ones the
//     app loads), and no other conpty.node is packed anywhere in the archive.
// and, again in the unpacked node-pty (PTY-EARLY-KILL-EPIPE-108):
//   9 lib/worker/conoutSocketWorker.js is the pinned form with the socket error listeners
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('./node-pty-race-fix-pins.cjs');

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const short = (h) => (h ? h.slice(0, 12) : 'missing');

/** The asar's file index: { files: { name: { files } | { size, offset } | { size, unpacked: true } } }. */
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error('shorter than an asar header');
    const length = head.readUInt32LE(12);
    if (head.readUInt32LE(0) !== 4 || length === 0 || length > fs.fstatSync(fd).size - 16) throw new Error('not an asar archive');
    const json = Buffer.alloc(length);
    if (fs.readSync(fd, json, 0, length, 16) !== length) throw new Error('truncated asar header');
    const header = JSON.parse(json.toString('utf8'));
    if (!header || typeof header.files !== 'object' || header.files === null) throw new Error('asar header has no file index');
    return header;
  } finally { fs.closeSync(fd); }
}

/** Every file of an asar index as [posix path, entry]. Links are files here: they are not followed. */
function asarFiles(header) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry && typeof entry.files === 'object' && entry.files !== null) walk(entry, p);
      else out.push([p, entry || {}]);
    }
  };
  walk(header, '');
  return out;
}

/** Every file under dir, as posix paths relative to it. Links are named, not followed. */
function filesUnder(dir) {
  const out = [];
  const walk = (d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), p);
      else out.push(p);
    }
  };
  walk(dir, '');
  return out;
}

const NP = 'node_modules/node-pty';
const BUILT = 'build/Release/conpty.node';
const WIN_PREBUILT = /(^|\/)node-pty\/prebuilds\/win32-[^/]+\//;

/** The checks on a packaged tree: { resources, checks: [{ name, ok, why }] }. Never throws. */
function inspect(dir) {
  const checks = [];
  const add = (name, ok, why = '') => { checks.push({ name, ok: !!ok, why: ok ? '' : why }); };
  const resources = [dir, path.join(dir, 'resources')].find((d) => fs.existsSync(path.join(d, 'app.asar')) || fs.existsSync(path.join(d, 'app.asar.unpacked')));
  if (!resources) {
    add('a packaged app', false, `${dir} holds no app.asar or app.asar.unpacked, and neither does its resources folder`);
    return { resources: null, checks };
  }
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const np = path.join(unpacked, ...NP.split('/'));
  const at = (rel) => path.join(np, ...rel.split('/'));

  let version = null;
  try { version = JSON.parse(fs.readFileSync(at('package.json'), 'utf8')).version; } catch { /* reported below */ }
  add(`node-pty ${pins.NODE_PTY_VERSION} is unpacked beside app.asar`, version === pins.NODE_PTY_VERSION,
    version === null ? `no readable ${NP}/package.json under app.asar.unpacked` : `it is node-pty ${version}`);

  const agentSha = sha(at('lib/windowsPtyAgent.js'));
  add('lib/windowsPtyAgent.js keeps the root handle', agentSha === pins.AGENT_JS_HANDOFF_SHA256,
    agentSha === pins.AGENT_JS_PRISTINE_SHA256 ? 'it is the UNPATCHED 1.1.0 file: rootHandle is dropped' : `sha256 ${short(agentSha)} is not the pinned handoff form`);

  const utilsSha = sha(at('lib/utils.js'));
  add('lib/utils.js loads built binaries only', utilsSha === pins.UTILS_JS_BUILT_ONLY_SHA256,
    utilsSha === pins.UTILS_JS_PRISTINE_SHA256 ? 'it is the UNPATCHED 1.1.0 loader: it falls back to prebuilds/ silently' : `sha256 ${short(utilsSha)} is not the pinned built-only loader`);

  const binary = at(BUILT);
  const binarySha = sha(binary);
  let record = null;
  try { record = JSON.parse(fs.readFileSync(at(pins.MARKER_FILE), 'utf8')); } catch { /* reported below */ }
  const recorded = record && record.files && typeof record.files === 'object' && record.files[BUILT] ? record.files[BUILT].sha256 : null;
  const recordWhy = binarySha === null ? `${BUILT} is missing`
    : !record ? `${pins.MARKER_FILE} is missing or unreadable: nothing says what this binary was built from`
      : record.version !== pins.NODE_PTY_VERSION ? `the record is for node-pty ${record.version}`
        : record.sourceSha256 !== pins.CONPTY_CC_BUILT_SHA256 ? `the record names source ${short(record.sourceSha256)}, not the pinned patched conpty.cc`
          : recorded !== binarySha ? `the binary is ${short(binarySha)}, the record says ${short(recorded)}`
            : '';
  add(`${BUILT} is the recorded build of the patched source`, recordWhy === '', recordWhy);

  const imports = binarySha === null ? [] : pins.peImports(binary);
  const lacks = [...pins.HANDOFF_IMPORTS, ...pins.MUTEX_IMPORTS].filter((n) => !imports.includes(n));
  add('conpty.node duplicates the root handle (imports DuplicateHandle, and the #922 locks)', binarySha !== null && lacks.length === 0,
    binarySha === null ? `${BUILT} is missing` : imports.length === 0 ? 'it is not a readable Windows binary' : `it does not import ${lacks.join(', ')}: it was not built from the patched source`);

  const ccSha = sha(at('src/win/conpty.cc'));
  add('src/win/conpty.cc, when it ships, is the patched source', ccSha === null || ccSha === pins.CONPTY_CC_BUILT_SHA256,
    `sha256 ${short(ccSha)} is not the pinned source`);

  const onDisk = filesUnder(unpacked);
  const strays = onDisk.filter((p) => WIN_PREBUILT.test(`/${p}`) || (p.endsWith('/conpty.node') && p !== `${NP}/${BUILT}`));
  add('no prebuilt Windows binary of node-pty ships', strays.length === 0,
    `${strays.length} file(s), first: ${strays.slice(0, 3).join(', ')}`);

  let entries = null;
  let asarWhy = '';
  try { entries = asarFiles(readAsarHeader(path.join(resources, 'app.asar'))); } catch (e) { asarWhy = `app.asar could not be read: ${e.message}`; }
  if (entries) {
    const mine = entries.filter(([p]) => p.startsWith(`${NP}/`));
    const packed = mine.filter(([, e]) => e.unpacked !== true).map(([p]) => p);
    const need = ['package.json', 'lib/windowsPtyAgent.js', 'lib/utils.js', 'lib/worker/conoutSocketWorker.js', BUILT].filter((rel) => !mine.some(([p]) => p === `${NP}/${rel}`));
    const others = entries.filter(([p]) => (p === 'conpty.node' || p.endsWith('/conpty.node')) && p !== `${NP}/${BUILT}`).map(([p]) => p);
    const prebuilt = entries.filter(([p]) => WIN_PREBUILT.test(`/${p}`)).map(([p]) => p);
    asarWhy = need.length ? `app.asar does not list ${NP}/${need[0]}: the app would not load the files checked above`
      : packed.length ? `${packed.length} node-pty file(s) are packed INSIDE app.asar, first: ${packed[0]}`
        : others.length ? `app.asar lists another conpty.node: ${others[0]}`
          : prebuilt.length ? `app.asar lists a prebuilt Windows binary: ${prebuilt[0]}`
            : '';
  }
  add('app.asar loads node-pty from the unpacked files only', asarWhy === '', asarWhy);

  const workerSha = sha(at('lib/worker/conoutSocketWorker.js'));
  add('lib/worker/conoutSocketWorker.js handles socket errors', workerSha === pins.WORKER_JS_QUIET_SHA256,
    workerSha === pins.WORKER_JS_PRISTINE_SHA256 ? 'it is the UNPATCHED 1.1.0 worker: a destroyed data socket throws EPIPE in the main process' : `sha256 ${short(workerSha)} is not the pinned worker`);
  return { resources, checks };
}

/** Print the checks; true when all hold. */
function report(dir, log = console.log) {
  const { resources, checks } = inspect(dir);
  if (resources) log(`[check-packaged-node-pty] ${resources}`);
  for (const c of checks) log(`${c.ok ? 'OK   ' : 'FAIL '}${c.name}${c.ok ? '' : `: ${c.why}`}`);
  const ok = checks.every((c) => c.ok);
  log(ok ? `PACKAGED NODE-PTY OK (${checks.length} checks)` : 'PACKAGED NODE-PTY FAILED');
  return ok;
}

module.exports = { inspect, report, readAsarHeader, asarFiles };
