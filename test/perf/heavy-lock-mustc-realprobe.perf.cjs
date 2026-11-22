'use strict';
require('../tools/own-job.cjs');
// @heavy-lock live: it spawns real node --test processes through the real preload and broker. HEAVY-LOCK-LIVE-FILE-192: one run of this file takes the heavy slot.

/**
 * HEAVY-LOCK-OPAQUE-196-MUSTC-REALPROBE-108: E2E MUST C against the product's REAL process listing
 * (one PowerShell CIM query in a 10 s box), in the SERIAL perf lane
 * (test/tools/run-tests.cjs runs every test/perf/*.perf.cjs with --test-concurrency=1, after the
 * parallel suite, on an unfiltered run). Under parallel-suite load that listing can miss its box; a
 * failed listing is unknown and the sweep changes nothing (fail closed, by design), so the parallel
 * cell in test/heavy-lock/heavy-lock-opaque-196.test.cjs uses a recorder listing instead and this file
 * keeps the real CIM path exercised. The body is shared: test/heavy-lock/opaque-196-e2e.cjs.
 */
const test = require('node:test');
const E2E = require('../heavy-lock/opaque-196-e2e.cjs');

test('E2E MUST C (real listing, serial lane): a killed lease holder and a waiting wrapper free the slot for the next agent', { timeout: 120_000 }, (t) => E2E.mustC(t, { probe: 'real' }));
