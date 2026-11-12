'use strict';
// STARTUP-FREEZE-104 A19: the derive worker thread's entry for tests: src/main/claims/deriveWorker.ts through
// load-ts (the app runs the built out/main/claimsDeriveWorker.js).
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
loadTs(path.resolve(__dirname, '..', '..', 'src/main/claims/deriveWorker.ts'));
