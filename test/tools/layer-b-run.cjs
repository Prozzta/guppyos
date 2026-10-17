'use strict';

/** Thin compatibility entry point.  Safety-pinned implementation lives in layer-b-core.cjs and
 * extracted helpers under layer-b/; consumers continue to require or execute this path. */
const core = require('./layer-b-core.cjs');

if (require.main === module) core.runCli();

module.exports = core;
