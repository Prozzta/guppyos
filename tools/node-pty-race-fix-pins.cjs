'use strict';
// Pins for the node-pty #922 backport (tools/patch-node-pty-race-fix.cjs,
// tools/record-node-pty-race-fix.cjs, scripts/release-markers.cjs).
//   PRISTINE: src/win/conpty.cc from the npm tarball locked in package-lock.json
//             (node-pty-1.1.0.tgz, sha512-20Jqtut...lUg==).
//   PATCHED : the same file after the backport; its #922 hunks are byte-identical
//             to upstream's (node-pty 1.2.0-beta.13 src/win/conpty.cc).
module.exports = {
  NODE_PTY_VERSION: '1.1.0',
  CONPTY_CC_PRISTINE_SHA256: '52c893b689ab3210c0961e2a6aa805a82350003767b21069b164926b5becd4e2',
  CONPTY_CC_PATCHED_SHA256: 'a000a53daa90506662e4747c6585a403b93431d1fe46f99895aa6d58faaa9082',
  MARKER_FILE: 'munder-conpty-race-fix.json',
};
