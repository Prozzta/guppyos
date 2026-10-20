'use strict';
// TEST-TEMP-HYGIENE: the temp folder for a cache that is shared ON PURPOSE by every run and kept
// between runs (the Electron SwiftShader view, the rig's node.exe, the compiled file-job exe). Under
// run-tests every test file has a temp folder of its own that must be empty when it ends
// (temp-jail-preload.cjs), so such a cache goes to the real temp folder the preload recorded. Nothing
// else may use this: a test's own temp goes in os.tmpdir() and is removed by the test.
const os = require('node:os');

/** The real temp folder under run-tests; os.tmpdir() elsewhere. */
function sharedTemp(env = process.env) {
  return env.GUPPY_SHARED_TEMP || os.tmpdir();
}

module.exports = { sharedTemp };
