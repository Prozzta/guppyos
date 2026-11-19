'use strict';
// ELECTRON-RM-READONLY-EPERM-108: the delete for a test's temp tree that can hold read-only files.
//
// Under Electron 45 (also as Node, and in the packaged exe) fs.rmSync(dir, { recursive: true })
// fails with EPERM on a tree that holds a read-only file; plain Node deletes it. `git init` and
// every commit write read-only files under .git/objects, so a test that makes a repository and
// removes its folder with rmSync is green under Node and red under Electron.
//
// rmTree(dir) removes the tree with the app's own remover (src/main/fsSafeRemove.ts, the fs-handle
// addon): it deletes a read-only file on its handle, and removes a link in the tree as a link. It
// fails closed: with no usable addon it throws EREMOVER_UNAVAILABLE. It never falls back to a
// recursive fs remove, and it never changes a mode or an attribute by path (a chmod through a
// junction would reach the target).
//
//   rmTree(dir)                                   a missing dir is fine (as rmSync's force: true)
//   rmTree(dir, { maxRetries: 5, retryDelay: 100 })   as rmSync's options: tried again while a
//                                                 handle is still open (EBUSY, EPERM, ENOTEMPTY, EACCES)
//
// `dir` that is itself a link is removed as a link (its target stays). A plain file is refused.
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');

const REMOVER_TS = path.join(__dirname, '..', '..', 'src', 'main', 'fsSafeRemove.ts');
const AGAIN = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rmTree(dir, { maxRetries = 0, retryDelay = 100, remover = () => loadTs(REMOVER_TS), pause = pauseSync } = {}) {
  for (let attempt = 0; ; attempt++) {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return;
    const S = remover();
    try {
      if (st.isSymbolicLink()) S.removeReparsePointSync(dir);
      else if (!st.isDirectory()) throw Object.assign(new Error(`rmTree: not a folder: ${dir}`), { code: 'EREFUSED', path: dir });
      else S.safeRemoveTreeSync(dir);
      return;
    } catch (e) {
      if (e && e.code === 'ENOENT' && !fs.lstatSync(dir, { throwIfNoEntry: false })) return; // gone meanwhile
      if (attempt >= maxRetries || !e || !AGAIN.has(e.code)) throw e;
    }
    pause(retryDelay);
  }
}

module.exports = { rmTree, REMOVER_TS, AGAIN };
