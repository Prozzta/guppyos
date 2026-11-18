'use strict';
require('./tools/own-job.cjs');

/**
 * SECRETS-ATOMIC-SAVE-108: the integrations secret store (src/main/integrations.ts) saved with one
 * plain writeFileSync over the live file, and read a file that did not parse as "no secrets". A save
 * cut short tore the file, and the next save wrote a blob holding only its own secret.
 *
 * Everything here goes through the store's own functions (setSecret, getSecret, hasSecret,
 * deleteSecret) with electron stubbed, so the same file runs on the code before the fix:
 *   - a torn live file is answered from the last good copy, and the next save keeps every secret
 *   - the live file is never opened for writing: the text goes to a temp file, is flushed, and is
 *     renamed over it
 *   - a save whose temp file does not read back as written, or whose rename fails, reports the
 *     failure, leaves the live file byte for byte as it was and leaves no temp file
 *   - emptying the store removes the good copy too, so nothing can bring a deleted secret back
 *
 * MUTANTS (src/main/secretFile.ts unless named; each kills the test named beside it):
 *   S1 integrations.ts writeSecretBlob: a plain writeFileSync again      -> never opened for writing
 *   S2 readSecretFile: a corrupt live file reads as {} (no good copy)    -> torn file
 *   S3 publish: no fsync                                                 -> never opened for writing
 *   S4 publish: no read-back                                             -> read-back
 *   S5 writeSecretFile: no .good copy published                          -> torn file
 *   S6 removeSecretFile: the .good copy is left                          -> emptying the store
 *   S7 publish: the temp file is left behind on failure                  -> rename fails
 *   S8 parseBlob: an array (S8a) or a non-string value (S8b) is accepted -> not a secrets blob
 *   S9 readSecretFile: a missing live file is answered from .good        -> emptying the store
 *   S10 writeSecretFile: no .corrupt copy of an unreadable live file     -> not a secrets blob
 *   S11 publish: the temp file opened 'w' with no mode                   -> never opened for writing
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-secrets-atomic-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: { getPath: () => userData },
    ipcMain: { handle() {} },
    // Not encryption: the store only needs the two calls to be each other's inverse.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
      decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('enc:')) throw new Error('not ours'); return s.slice(4); }
    }
  }
};
const loadTs = require('./load-ts.cjs');
const I = loadTs('src/main/integrations.ts');
const file = path.join(userData, 'integration-secrets.json');
const good = `${file}.good`;

test.after(() => { loadTs.closeConfigWatchers?.(); fs.rmSync(userData, { recursive: true, force: true }); });

const leftovers = () => fs.readdirSync(userData).filter((n) => n.startsWith('integration-secrets.json') && !['integration-secrets.json', 'integration-secrets.json.good', 'integration-secrets.json.corrupt'].includes(n));
const reset = () => { for (const n of fs.readdirSync(userData)) if (n.startsWith('integration-secrets.json')) fs.rmSync(path.join(userData, n), { force: true }); };
const quiet = (t) => { const lines = []; t.mock.method(console, 'error', (...a) => { lines.push(a.join(' ')); }); return lines; };

test('a torn live file: the secrets are answered from the last good copy, and the next save keeps all of them', (t) => {
  reset();
  const lines = quiet(t);
  assert.deepEqual(I.setSecret('slack', 'xoxb-one'), { ok: true });
  assert.deepEqual(I.setSecret('groq', 'gsk-two'), { ok: true });
  const whole = fs.readFileSync(file, 'utf8');
  // What a save cut short leaves: the first part of the text.
  fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
  assert.equal(I.getSecret('slack'), 'xoxb-one', 'THE STORED SECRET IS STILL READABLE');
  assert.equal(I.hasSecret('groq'), true);
  assert.ok(lines.length > 0 && lines.every((l) => /integration-secrets\.json is unreadable .*using the last good copy integration-secrets\.json\.good/.test(l)), `one line per read says the copy was used: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /xoxb|gsk|enc:/.test(l) || l.includes(Buffer.from('enc:xoxb-one').toString('base64'))), 'no secret text in the line');
  // The next save starts from what was read, so it repairs the file and loses nothing.
  assert.deepEqual(I.setSecret('third', 'tok-three'), { ok: true });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['groq', 'slack', 'third'], 'EVERY SECRET IS STILL IN THE FILE AFTER THE NEXT SAVE');
  assert.equal(fs.readFileSync(good, 'utf8'), fs.readFileSync(file, 'utf8'), 'the good copy is the file just saved');
  assert.equal(I.getSecret('groq'), 'gsk-two');
  assert.deepEqual(leftovers(), []);
});

test('not a secrets blob (an array, a non-string value, no copy): it reads as empty, says so, and the bytes are kept at the next save', (t) => {
  for (const bad of ['[1,2]', '[]', '["enc"]', '{"slack":5}', '{"slack":']) {
    reset();
    const lines = quiet(t);
    assert.deepEqual(I.setSecret('slack', 'xoxb-one'), { ok: true });
    fs.writeFileSync(file, bad);
    assert.equal(I.getSecret('slack'), 'xoxb-one', `${bad}: answered from the good copy`);
    fs.rmSync(good);
    lines.length = 0;
    assert.equal(I.hasSecret('slack'), false, `${bad}: with no copy there is nothing to answer from`);
    assert.deepEqual(lines, ['[integrations] integration-secrets.json is unreadable (not a secrets blob) and there is no usable integration-secrets.json.good: the stored secrets cannot be read']);
    assert.deepEqual(I.setSecret('groq', 'gsk-two'), { ok: true });
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), bad, 'the unreadable file is kept beside the new one');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['groq']);
    t.mock.restoreAll();
  }
});

test('a save never opens the live file for writing: temp file (0600), flushed, then renamed over it', (t) => {
  reset();
  assert.deepEqual(I.setSecret('slack', 'xoxb-one'), { ok: true });
  const events = [];
  const fds = new Map();
  const realOpen = fs.openSync, realWrite = fs.writeFileSync, realFsync = fs.fsyncSync;
  t.mock.method(fs, 'openSync', (p, flags, mode) => { const fd = realOpen(p, flags, mode); fds.set(fd, String(p)); events.push(['open', path.basename(String(p)).replace(/tmp-[0-9a-f]+$/, 'tmp'), String(flags), mode]); return fd; });
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => { events.push(['write', typeof p === 'number' ? path.basename(fds.get(p) ?? '?').replace(/tmp-[0-9a-f]+$/, 'tmp') : path.basename(String(p))]); return realWrite(p, ...rest); });
  t.mock.method(fs, 'fsyncSync', (fd) => { events.push(['fsync', path.basename(fds.get(fd) ?? '?').replace(/tmp-[0-9a-f]+$/, 'tmp')]); return realFsync(fd); });
  assert.deepEqual(I.setSecret('groq', 'gsk-two'), { ok: true });
  t.mock.restoreAll();
  const live = 'integration-secrets.json';
  assert.deepEqual(events.filter((e) => e[1] === live), [], `THE LIVE FILE IS NEVER A WRITE TARGET: ${JSON.stringify(events)}`);
  const onTmp = events.filter((e) => e[1] === `${live}.tmp`);
  assert.deepEqual(onTmp, [['open', `${live}.tmp`, 'wx', 0o600], ['write', `${live}.tmp`], ['fsync', `${live}.tmp`]], 'the temp file is created new and private, written, then flushed');
  assert.deepEqual(events.filter((e) => e[1] === `${live}.good.tmp`).map((e) => e[0]), ['open', 'write', 'fsync'], 'the good copy is published the same way');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['groq', 'slack']);
  assert.deepEqual(leftovers(), []);
});

test('read-back: a temp file that does not hold what was written is not published; the live file is untouched', (t) => {
  reset();
  assert.deepEqual(I.setSecret('slack', 'xoxb-one'), { ok: true });
  const before = fs.readFileSync(file);
  const realWrite = fs.writeFileSync;
  // A disk that takes half the text and reports success.
  t.mock.method(fs, 'writeFileSync', (p, data, ...rest) => realWrite(p, String(data).slice(0, Math.floor(String(data).length / 2)), ...rest));
  const r = I.setSecret('groq', 'gsk-two');
  t.mock.restoreAll();
  assert.equal(r.ok, false, 'THE SAVE REPORTS THE FAILURE');
  assert.match(r.error, /read-back of integration-secrets\.json\.tmp-[0-9a-f]+ is not what was written/);
  assert.deepEqual(fs.readFileSync(file), before, 'THE LIVE FILE IS BYTE FOR BYTE AS IT WAS');
  assert.equal(I.getSecret('slack'), 'xoxb-one');
  assert.deepEqual(leftovers(), [], 'no temp file is left');
});

test('rename fails: the save reports it, the live file is as it was, no temp file is left', (t) => {
  reset();
  assert.deepEqual(I.setSecret('slack', 'xoxb-one'), { ok: true });
  const before = fs.readFileSync(file);
  const A = loadTs('src/main/atomicJson.ts');
  A.__setRenameAddonForTest(null);
  t.after(() => A.__setRenameAddonForTest(undefined));
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' }); });
  const r = I.setSecret('groq', 'gsk-two');
  t.mock.restoreAll();
  assert.equal(r.ok, false, 'THE SAVE REPORTS THE FAILURE');
  assert.match(r.error, /ENOSPC/);
  assert.deepEqual(fs.readFileSync(file), before, 'THE LIVE FILE IS BYTE FOR BYTE AS IT WAS');
  assert.deepEqual(leftovers(), [], 'no temp file is left');
});

test('emptying the store removes the good copy too: a deleted secret cannot come back', () => {
  reset();
  assert.deepEqual(I.setSecret('slack', 'xoxb-one'), { ok: true });
  assert.deepEqual(I.setSecret('groq', 'gsk-two'), { ok: true });
  I.deleteSecret('slack');
  assert.equal(I.hasSecret('slack'), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(good, 'utf8'))), ['groq'], 'the good copy follows a delete');
  I.deleteSecret('groq');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(good), false, 'THE GOOD COPY IS GONE WITH THE FILE');
  // A copy left by anything else does not answer for a store that was emptied.
  fs.writeFileSync(good, JSON.stringify({ slack: Buffer.from('enc:old').toString('base64') }));
  assert.equal(I.hasSecret('slack'), false, 'a missing live file is an empty store');
  assert.equal(I.getSecret('slack'), undefined);
});
