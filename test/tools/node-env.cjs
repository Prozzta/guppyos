'use strict';
// TEST-EXECPATH-ENV-108: nodeEnv lives in tools/node-env.cjs (shared by tools/ and scripts/, which
// must not depend on test/). This re-export keeps the test-side require paths working.
module.exports = require('../../tools/node-env.cjs');
