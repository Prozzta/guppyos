/**
 * TEST-RUNNER-FILE-TIMEOUT: a second `node --test` reporter (run-tests.cjs adds it beside the
 * normal TAP/spec one). It writes one JSON line per FILE that hit the runner's per-file wall-clock
 * timeout, so the runner can name it after the run. node --test counts such a file as
 * "cancelled", not "failed": without this, a hung file reads `# fail 0`.
 *
 * A file-level timeout is a `test:fail` at nesting 0 whose name IS the file path and whose
 * failureType is testTimeoutFailure (a per-test timeout inside a file carries the test's name).
 */
module.exports = async function* fileTimeoutReporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    const error = (d.details && d.details.error) || {};
    if (d.nesting === 0 && d.file && d.name === d.file && error.failureType === 'testTimeoutFailure') {
      yield `${JSON.stringify({ file: d.file, message: String(error.message || error) })}\n`;
    }
  }
};
