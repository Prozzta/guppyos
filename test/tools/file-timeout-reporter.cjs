/**
 * TEST-RUNNER-FILE-TIMEOUT: a second `node --test` reporter (run-tests.cjs adds it beside the
 * normal TAP/spec one). It writes one JSON line per FILE that hit the runner's per-file wall-clock
 * timeout, so the runner can name it after the run. node --test counts such a file as
 * "cancelled", not "failed": without this, a hung file reads `# fail 0`.
 *
 * A file-level timeout is a `test:fail` at nesting 0 whose name IS the file path and whose
 * failureType is testTimeoutFailure (a per-test timeout inside a file carries the test's name).
 *
 * CLAIMS-PERF-LANE: it also records the run's summary counts (the root's nesting-0 diagnostics
 * 'tests N', 'pass N', ...) as {count, n} lines, which run-tests.cjs adds into its totals line.
 */
const SUMMARY = /^(tests|pass|fail|cancelled|skipped|todo) (\d+)$/;
module.exports = async function* fileTimeoutReporter(source) {
  for await (const ev of source) {
    if (ev.type === 'test:diagnostic') {
      const d = ev.data || {};
      const m = d.nesting === 0 && !d.file ? SUMMARY.exec(String(d.message)) : null;
      if (m) yield `${JSON.stringify({ count: m[1], n: Number(m[2]) })}\n`;
      continue;
    }
    if (ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    const error = (d.details && d.details.error) || {};
    if (d.nesting === 0 && d.file && d.name === d.file && error.failureType === 'testTimeoutFailure') {
      yield `${JSON.stringify({ file: d.file, message: String(error.message || error) })}\n`;
    }
  }
};
