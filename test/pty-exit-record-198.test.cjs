'use strict';
require('./tools/own-job.cjs');
/**
 * ANDY-PTY-EXIT-2049: an UNREQUESTED PTY exit leaves a record naming what the session was doing
 * (god GO 05:39Z: the detached mirror only on a non-explicit end, an async fire-and-forget record,
 * decoded exit codes, screen + raw tail, last hook/tool, heavy-lock state, children, the Codex logs
 * DB read-only with skip-on-error, <hive>/exits capped at 64 KB with the newest 20 kept, a log row;
 * freshness by the transcript's last row ts, never its mtime; Codex's last call + has-output).
 *
 * Hand-built sessions (no node-pty spawn, `pid` set but no kill path runs), fake mirrors, a fake
 * sqlite. Every file lands in a temp hive; HOME/USERPROFILE point at a temp home and are asserted.
 *
 * Named mutants (test/tools/pty-exit-record-mutants.cjs), each must fail this file:
 *   X1  an explicit end hands evidence          X2  a taken mirror is still disposed by pty.ts
 *   X3  an untaken mirror is not disposed       X4  freshness from the mtime, not the last row
 *   X5  a call's output is never matched        X6  a stranger with a recycled parent pid counts
 *   X7  the size cap is not applied             X8  no pruning to the newest 20
 *   X9  a hung screen read leaves the mirror    X10 the codex log error escapes
 *   X11 the window rule ignores the exit time   X12 signed NTSTATUS not decoded
 *   X13 main records a requested end            X14 main records an installer relaunch
 *   X15 the last hook event is never stamped    X16 free text clipped but not redacted
 *   X17 noise Codex log rows are kept           X18 the head row of a cut raw tail is kept
 *   X19 screen rows redacted one by one only    X20 the top row's leading key run is kept
 *   X21 a short row's boundary joins as a wrap  X22 a short row's boundary is never checked (PEM)
 *   X23 a cut tail keeps an orphaned PEM body   X24 screen rows opening mid-PEM are kept
 *   X25 a wide-char row never wraps
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exit-198-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
assert.equal(os.homedir(), HOME, 'probe home isolation: the temp home is in force');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });

const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const { PtyManager } = loadTs('src/main/pty.ts');
const X = loadTs('src/main/ptyExitRecord.ts');

const T0 = Date.parse('2026-10-21T04:00:00Z');
let hiveN = 0;
const newHive = () => { const d = path.join(TMP, `hive${++hiveN}`); fs.mkdirSync(d); return d; };

function fakeMirror(reading = { lines: ['$ codex', 'thinking…', '', ''], cursor: { x: 0, y: 0 }, cols: 80, rows: 4, altScreen: true, bracketedPaste: false }) {
  const m = { disposed: 0, read: async () => reading, dispose: () => { m.disposed++; } };
  return m;
}
function session(over = {}) {
  return {
    id: 'p', cwd: 'C:/w', command: 'codex', owner: null, tail: '\x1b[31mpanic\x1b[0m\r\nbye', hasOutput: true, humanInputGeneration: 0,
    lastOutputAt: T0, spawnedAt: T0, incarnation: 7, proc: { pid: 4242, kill: () => {} }, ...over
  };
}

// --- pty.ts: what an end hands over ------------------------------------------------------------

test('X1/X2: an unrequested end hands evidence; the observer takes the mirror and pty.ts leaves it to the taker', () => {
  const m = new PtyManager(); const mirror = fakeMirror(); const s = session({ mirror });
  let ev; m.setEndObserver((e) => { ev = e; e.evidence.taken = e.evidence.takeMirror(); });
  m.reportEnd('p', s, 0, 0);
  assert.equal(ev.explicit, false);
  assert.deepEqual({ pid: ev.evidence.pid, signal: ev.evidence.signal, spawnedAt: ev.evidence.spawnedAt, command: ev.evidence.command, cwd: ev.evidence.cwd, tail: ev.evidence.tail },
    { pid: 4242, signal: 0, spawnedAt: T0, command: 'codex', cwd: 'C:/w', tail: s.tail });
  assert.equal(ev.evidence.taken, mirror);
  assert.equal(mirror.disposed, 0, 'the taker disposes it after its last read');
  assert.equal(s.mirror, undefined, 'the session no longer holds it');
  assert.equal(ev.evidence.takeMirror(), undefined, 'a second take gets nothing');
});

test('X3: an untaken mirror is disposed at the end as before; a take after the end gets nothing', () => {
  const m = new PtyManager(); const mirror = fakeMirror(); const s = session({ mirror });
  let ev; m.setEndObserver((e) => { ev = e; });
  m.reportEnd('p', s, 1);
  assert.equal(mirror.disposed, 1);
  assert.equal(ev.evidence.signal, null);
  assert.equal(ev.evidence.takeMirror(), undefined);
});

test('X1: a requested end (kill, explicit teardown) hands no evidence and disposes the mirror', () => {
  const m = new PtyManager(); const mirror = fakeMirror(); const s = session({ mirror, proc: { pid: undefined, kill: () => {} } });
  const ends = []; m.setEndObserver((e) => ends.push(e));
  m.sessions.set('p', s);
  assert.equal(m.kill('p').ok, true);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].explicit, true);
  assert.equal('evidence' in ends[0], false);
  assert.equal(mirror.disposed, 1);
});

test('an observer that throws after taking the mirror never breaks the end (pty.ts does not dispose a taken mirror)', () => {
  const m = new PtyManager(); const mirror = fakeMirror(); const s = session({ mirror });
  m.setEndObserver((e) => { e.evidence.takeMirror(); throw new Error('observer'); });
  m.reportEnd('p', s, 0);
  assert.equal(mirror.disposed, 0);
});

test('node-pty\'s exit hands its signal to the end report (source pin)', () => {
  const src = codeOnly(readSource('src/main/pty.ts'));
  const onExit = src.slice(src.indexOf('proc.onExit('), src.indexOf('proc.onExit(') + 900);
  assert.match(onExit, /proc\.onExit\(\(\{ exitCode, signal \}\) =>/);
  assert.ok(onExit.includes('this.reportEnd(opts.id, session, exitCode, signal)'));
});

// --- pure parts ------------------------------------------------------------------------------

test('X12: exit codes decode, signed or unsigned NTSTATUS alike', () => {
  assert.match(X.decodeExitCode(0), /exited by itself/);
  assert.match(X.decodeExitCode(1), /TerminateProcess/);
  assert.match(X.decodeExitCode(-1073741819), /access violation/);   // 0xC0000005 signed
  assert.match(X.decodeExitCode(0xC0000005), /access violation/);
  assert.match(X.decodeExitCode(-1073740791), /fail-fast/);          // 0xC0000409
  assert.match(X.decodeExitCode(-1073741510), /Ctrl\+C/);            // 0xC000013A
  assert.match(X.decodeExitCode(0xC0001234), /NTSTATUS 0xC0001234 \(a crash\)/);
  assert.equal(X.decodeExitCode(7), 'exit 7');
  assert.match(X.decodeExitCode(null), /no exit code/);
  assert.equal(X.decodeExitCode(0, 9), 'signal 9');
});

test('stripAnsi leaves the text of CSI, OSC and controls', () => {
  assert.equal(X.stripAnsi('\x1b]0;title\x07\x1b[1;32mok\x1b[0m\r\nnext\x1b[?25l\x08!'), 'ok\nnext!');
});

const codexRows = [
  '{"timestamp":"2026-10-21T04:57:4',   // a partial first line (the read starts mid-file)
  JSON.stringify({ timestamp: '2026-10-21T04:57:47.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"Get-Process node"}', call_id: 'c1' } }),
  JSON.stringify({ timestamp: '2026-10-21T04:58:12.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Id Path' } }),
  JSON.stringify({ timestamp: '2026-10-21T04:58:14.642Z', type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', arguments: JSON.stringify({ timeout_ms: 30000, pad: 'x'.repeat(400) }), call_id: 'c2' } })
].join('\n');

test('X5: a Codex rollout tail names the last call, its args (clipped) and that no output came (Dwight 04:58:14)', () => {
  const t = X.transcriptTail(codexRows, 'codex', 20);
  assert.equal(t.rows.length, 3, 'the partial first line is skipped');
  assert.equal(t.lastRowAt, '2026-10-21T04:58:14.642Z');
  assert.equal(t.lastCall.name, 'wait_agent');
  assert.equal(t.lastCall.hasOutput, false);
  assert.ok(t.lastCall.args.startsWith('{"timeout_ms":30000') && t.lastCall.args.length <= X.EXIT_FIELD_CHARS + 1);
  const answered = X.transcriptTail(codexRows.split('\n').slice(0, 3).join('\n'), 'codex', 20);
  assert.equal(answered.lastCall.name, 'shell');
  assert.equal(answered.lastCall.hasOutput, true, 'its call_id output was seen');
  assert.equal(X.transcriptTail(codexRows, 'codex', 1).rows.length, 1);
});

test('X5: a Claude transcript tail matches tool_use to tool_result', () => {
  const rows = [
    { timestamp: '2026-10-21T04:00:00Z', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }] } },
    { timestamp: '2026-10-21T04:00:01Z', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'a' }] } },
    { timestamp: '2026-10-21T04:00:02Z', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Read', input: { file_path: 'x' } }], stop_reason: 'tool_use' } }
  ].map((r) => JSON.stringify(r)).join('\n');
  const t = X.transcriptTail(rows, 'claude', 10);
  assert.deepEqual([t.lastCall.name, t.lastCall.hasOutput], ['Read', false]);
  assert.equal(t.rows[2].kind, 'tool_use stop=tool_use');
  const t2 = X.transcriptTail(rows.split('\n').slice(0, 2).join('\n'), 'claude', 10);
  assert.deepEqual([t2.lastCall.name, t2.lastCall.hasOutput], ['Bash', true]);
});

test('X4: a transcript held open with a stale mtime: the record carries the mtime AND the newer last-row time', () => {
  const f = path.join(TMP, 'rollout-2026-10-19T20-40-52.jsonl');
  fs.writeFileSync(f, codexRows + '\n');
  const stale = new Date('2026-10-19T18:43:00Z');
  fs.utimesSync(f, stale, stale);
  const t = X.readTranscriptTail(f, 'codex', 20);
  assert.equal(t.file, f);
  assert.equal(Math.round(t.mtimeMs), stale.getTime());
  assert.equal(t.lastRowAt, '2026-10-21T04:58:14.642Z', 'freshness from the rows');
  assert.equal(t.bytes, fs.statSync(f).size);
  const missing = X.readTranscriptTail(path.join(TMP, 'none.jsonl'), 'codex', 20);
  assert.ok(missing.error && missing.rows.length === 0 && missing.lastRowAt === null, 'a missing file is named, never thrown');
});

/** A fake logs_2.sqlite: rows {p, ts, ts_nanos, level, target, body}. */
function fakeDb(rows, over = {}) {
  const db = {
    closed: 0, queries: [],
    prepare(sql) {
      db.queries.push(sql);
      if (over.prepareThrows) throw new Error('database is locked');
      if (/GROUP BY process_uuid/.test(sql)) {
        return { all: (minTs) => {
          const by = new Map();
          for (const r of rows.filter((x) => x.ts >= minTs)) { const g = by.get(r.p) ?? { p: r.p, lo: r.ts, hi: r.ts }; g.lo = Math.min(g.lo, r.ts); g.hi = Math.max(g.hi, r.ts); by.set(r.p, g); }
          return [...by.values()];
        } };
      }
      return { all: (p, n) => rows.filter((r) => r.p === p).sort((a, b) => b.ts - a.ts || b.ts_nanos - a.ts_nanos).slice(0, n).map((r) => ({ ts: r.ts, level: r.level, target: r.target, body: r.body })) };
    },
    close() { db.closed++; }
  };
  return db;
}
const S = (ms) => Math.floor(ms / 1000);
const EXIT = Date.parse('2026-10-21T04:58:40Z');
const logRows = [
  { p: 'pid:4242:aaa', ts: S(EXIT) - 30, ts_nanos: 0, level: 'INFO', target: 'codex_core', body: 'turn' },
  { p: 'pid:4242:aaa', ts: S(EXIT) - 20, ts_nanos: 5, level: 'INFO', target: 'codex_core', body: 'last' },
  { p: 'pid:9999:bbb', ts: S(EXIT) - 10, ts_nanos: 0, level: 'INFO', target: 'other', body: 'another codex' },
  { p: 'pid:7777:ccc', ts: S(EXIT) + 600, ts_nanos: 0, level: 'INFO', target: 'later', body: 'a later process' }
];

test('Codex log tail: by pid when a row carries it, else the process last logging within this life', () => {
  const db = fakeDb(logRows);
  const byPid = X.readCodexLogTail('C:/ch', [4242], EXIT - 3_600_000, EXIT, 30, () => db);
  assert.equal(byPid.file, path.join('C:/ch', 'logs_2.sqlite'));
  assert.deepEqual([byPid.match, byPid.process, byPid.rows.map((r) => r.body)], ['pid', 'pid:4242:aaa', ['turn', 'last']]);
  assert.equal(db.closed, 1);
  const byWindow = X.readCodexLogTail('C:/ch', [1], EXIT - 3_600_000, EXIT, 30, () => fakeDb(logRows));
  assert.deepEqual([byWindow.match, byWindow.process], ['window', 'pid:9999:bbb'], 'X11: a process logging after the exit is not this one');
  const none = X.readCodexLogTail('C:/ch', [1], EXIT, EXIT, 30, () => fakeDb(logRows.slice(3)));
  assert.deepEqual([none.match, none.process, none.rows], ['none', null, []]);
});

test('X10: a locked or missing logs DB is skipped and named; the handle is closed', () => {
  const opened = X.readCodexLogTail('C:/ch', [4242], EXIT, EXIT, 30, () => { throw new Error('unable to open database file'); });
  assert.deepEqual([opened.match, opened.rows, opened.error], ['none', [], 'unable to open database file']);
  const db = fakeDb(logRows, { prepareThrows: true });
  const locked = X.readCodexLogTail('C:/ch', [4242], EXIT, EXIT, 30, () => db);
  assert.equal(locked.error, 'database is locked');
  assert.equal(db.closed, 1);
});

test('X6: children at exit follow the own-procs rule: a recycled parent pid never adopts a stranger', () => {
  const rows = [
    { pid: 10, parentPid: 4242, commandLine: 'node --test x', createdMs: T0 + 1000 },
    { pid: 11, parentPid: 10, commandLine: 'conhost', createdMs: T0 + 1500 },
    { pid: 12, parentPid: 4242, commandLine: 'stranger (born before the CLI)', createdMs: T0 - 50_000 },
    { pid: 13, parentPid: 12, commandLine: 'stranger child', createdMs: T0 + 2000 },
    { pid: 14, parentPid: 4242, commandLine: 'no creation time' },
    { pid: 15, parentPid: 77, commandLine: 'unrelated', createdMs: T0 + 3000 }
  ];
  const kids = X.childrenAtExit(rows, 4242, T0);
  assert.deepEqual(kids.map((k) => k.pid).sort(), [10, 11]);
});

test('X16: a secret-shaped child commandLine, screen row and raw tail come out [redacted] (Jim S1: <hive>/exits is floor-readable)', () => {
  const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv';
  const kids = X.childrenAtExit([{ pid: 10, parentPid: 4242, commandLine: `curl -H "Authorization: Bearer ${KEY}" https://x`, createdMs: T0 + 1000 }], 4242, T0);
  assert.equal(kids.length, 1);
  assert.ok(!kids[0].commandLine.includes(KEY) && kids[0].commandLine.includes('[redacted]'), kids[0].commandLine);
  const rec = X.buildExitRecord(facts({ command: `codex --api-key=${KEY}`, rawTail: `export ANTHROPIC_API_KEY=${KEY}\r\n` }),
    { screen: { lines: [`token: ${KEY}`], altScreen: false }, children: kids, transcript: null, codexLog: null });
  const text = JSON.stringify(rec);
  assert.ok(!text.includes(KEY), 'no field of the record carries the key');
  assert.match(rec.command, /\[redacted\]/);
  assert.match(rec.rawTail, /\[redacted\]/);
  assert.match(rec.screen.rows[0], /\[redacted\]/);
});

test('X17: noise Codex log rows (token_count, item_completed, token_usage) are skipped; the newest n others stay (Jim N1)', () => {
  const rows = [{ p: 'pid:4242:aaa', ts: S(EXIT) - 60, ts_nanos: 0, level: 'INFO', target: 'codex_core', body: 'exec: npm test' }];
  for (let i = 0; i < 40; i++) rows.push({ p: 'pid:4242:aaa', ts: S(EXIT) - 50 + i, ts_nanos: 0, level: 'INFO', target: i % 2 ? 'codex_otel' : 'codex_core', body: i % 2 ? 'token_usage_record in=1' : 'event: token_count' });
  const t = X.readCodexLogTail('C:/ch', [4242], EXIT - 3_600_000, EXIT, 30, () => fakeDb(rows));
  assert.deepEqual(t.rows.map((r) => r.body), ['exec: npm test'], 'the lead-up survives a burst of 40 noise rows');
  assert.equal(t.noiseSkipped, 40);
});

// Jim's probe key: 115 chars, sk-ant shaped. A "fragment" is any 12 consecutive chars of it.
const KEY115 = 'sk-ant-api03-' + Array.from({ length: 102 }, (_, i) => 'Ab3Cd7Ef_9Gh-2Jk'[i % 16]).join('');
const fragmentIn = (text) => { for (let i = 0; i + 12 <= KEY115.length; i++) if (text.includes(KEY115.slice(i, i + 12))) return KEY115.slice(i, i + 12); return null; };

test('X18: a raw tail pty.ts cut drops its partial head row, so a key cut at the head leaves no fragment (Jim N2)', () => {
  assert.equal(KEY115.length, 115);
  const tailChars = Number(/export const PTY_TAIL_CHARS = (\d+);/.exec(readSource('src/main/pty.ts'))[1]);
  assert.equal(X.PTY_RAW_TAIL_CHARS, tailChars, 'the record knows pty.ts\'s cut length');
  const body = '\r\nok: suite 12/12\r\n';
  const cut = KEY115.slice(30) + body + 'x'.repeat(tailChars - KEY115.slice(30).length - body.length);
  assert.equal(cut.length, tailChars);
  const rec = X.buildExitRecord(facts({ rawTail: cut }), { screen: null, children: [], transcript: null, codexLog: null });
  assert.equal(fragmentIn(rec.rawTail), null, `no fragment of the key: ${rec.rawTail.slice(0, 80)}`);
  assert.ok(rec.rawTail.startsWith('ok: suite 12/12\n'), 'the rows after the head row stay');
  assert.equal(X.redactRawTail('q'.repeat(tailChars)), '', 'a cut tail with no line break is one partial row: dropped');
  assert.equal(X.redactRawTail('first row\r\nbye\r\n'), 'first row\nbye\n', 'an uncut tail keeps its first row');
});

test('X19: a key wrapped over screen rows leaves no fragment; the rows it spans are blanked, the others stay (Jim N3)', () => {
  // Jim's probe: 60 columns, the key wraps at col 60.
  const two = ['$ npm test', `export KEY=${KEY115.slice(0, 49)}`, KEY115.slice(49, 109), KEY115.slice(109), 'done'];
  assert.deepEqual([two[1].length, two[2].length], [60, 60]);
  const r2 = X.redactRows(two, 60);
  assert.equal(fragmentIn(r2.join('\n')), null, r2.join(' | '));
  assert.deepEqual([r2[0], r2[4]], ['$ npm test', 'done'], 'rows the key does not span stay');
  const three = ['$ env', KEY115.slice(0, 40), KEY115.slice(40, 80), KEY115.slice(80), 'next'];
  const r3 = X.redactRows(three, 40);
  assert.equal(fragmentIn(r3.join('\n')), null, `a narrow pane: three rows (${r3.join(' | ')})`);
  assert.deepEqual([r3[0], r3[4]], ['$ env', 'next']);
  assert.equal(fragmentIn(X.redactRows(three).join('\n')), null, 'with no cols every boundary is checked');
  // A wide-char row wraps while shorter than cols in JS chars (7 CJK chars are 14 cells).
  const wide = ['$ env', `日本語テキスト KEY=${KEY115.slice(0, 41)}`, KEY115.slice(41, 101), KEY115.slice(101), 'next'];
  const rw = X.redactRows(wide, 60);
  assert.equal(fragmentIn(rw.join('\n')), null, `a wide-char row (${rw.join(' | ')})`);
  assert.deepEqual([rw[0], rw[4]], ['$ env', 'next']);
  const rec = X.buildExitRecord(facts(), { screen: { lines: two, altScreen: false, cols: 60 }, children: [], transcript: null, codexLog: null });
  assert.equal(fragmentIn(rec.screen.rows.join('\n')), null, 'the record\'s screen rows');
});

test('X20: the top screen row may continue a key from above the viewport: its leading key-shaped run is redacted', () => {
  const r = X.redactRows([`${KEY115.slice(60)} exported`, 'done']);
  assert.equal(fragmentIn(r.join('\n')), null, r[0]);
  assert.equal(r[0], '[redacted] exported');
  assert.deepEqual(X.redactRows(['Downloading packages', 'done']), ['Downloading packages', 'done'], 'a word with no digit is not key-shaped');
});

// Jim's PEM probe: a header, 5 body rows of 64 base64 chars, a footer. A "fragment" is any body row's
// 12 consecutive chars.
const PEM_BODY = Array.from({ length: 5 }, (_, r) => Array.from({ length: 64 }, (_, i) => 'Qx7Lm2Pz9Rk4Tw+/'[(i * 7 + r * 3) % 16]).join(''));
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', ...PEM_BODY, '-----END RSA PRIVATE KEY-----'];
const pemFragmentIn = (text) => { for (const row of PEM_BODY) for (let i = 0; i + 12 <= row.length; i++) if (text.includes(row.slice(i, i + 12))) return row.slice(i, i + 12); return null; };

test('X22: a PEM key on screen leaves no body row, though each row is shorter than cols (Jim interim)', () => {
  const rows = X.redactRows(['$ cat id_rsa', ...PEM, '$ next'], 120);
  assert.equal(pemFragmentIn(rows.join('\n')), null, rows.join(' | '));
  assert.deepEqual([rows[0], rows[rows.length - 1]], ['$ cat id_rsa', '$ next'], 'the rows around the block stay');
});

test('X23: a raw tail cut inside a PEM header drops the orphaned body up to its footer', () => {
  const tailChars = X.PTY_RAW_TAIL_CHARS;
  // Jim's cut 40 chars in (inside the first body row) and one inside the header itself.
  for (const at of [40, 20]) {
    const head = `${PEM.join('\r\n').slice(at)}\r\n$ next\r\n`;
    const raw = head + 'y'.repeat(tailChars - head.length);
    assert.equal(raw.length, tailChars);
    const out = X.redactRawTail(raw);
    assert.equal(pemFragmentIn(out), null, `cut ${at} in: ${out.slice(0, 160)}`);
    assert.ok(out.includes('$ next'), 'the rows after the footer stay');
  }
  assert.equal(pemFragmentIn(X.redactRawTail(`${PEM.join('\r\n')}\r\nbye\r\n`)), null, 'an uncut PEM in the tail: the battery');
  assert.equal(X.orphanPemRows(PEM_BODY.slice(2)), 3, 'a cut with no footer in view: the leading base64 rows');
});

test('X24: a screen that opens mid-PEM (BEGIN above the viewport) blanks every row up to the footer', () => {
  const rows = X.redactRows([...PEM.slice(3), '$ next'], 120);
  assert.equal(pemFragmentIn(rows.join('\n')), null, rows.join(' | '));
  assert.equal(rows[rows.length - 1], '$ next');
});

const facts = (over = {}) => ({
  agentId: 'dwight-mu32ztys', ptyId: 'p', incarnation: 7, provider: 'codex', exitCode: 0, signal: null, at: EXIT, pid: 4242, spawnedAt: EXIT - 3_600_000,
  command: 'codex --yolo', cwd: 'C:/w', rawTail: '\x1b[2Kbye\r\n', lastHookAt: EXIT - 26_000, lastHookEvent: 'PostToolUse',
  runningTool: { name: 'wait_agent', since: EXIT - 26_000 }, heavyLock: [{ agentId: 'dwight-mu32ztys', kind: 'suite' }], ...over
});

test('the record: exit decoded, uptime, hooks, trimmed screen, stripped tail; small records cut nothing', () => {
  const rec = X.buildExitRecord(facts(), { screen: { lines: ['a', 'b', '  ', ''], altScreen: false }, children: [], transcript: null, codexLog: null });
  assert.equal(rec.kind, 'pty-exit-record');
  assert.equal(rec.at, '2026-10-21T04:58:40.000Z');
  assert.deepEqual(rec.exit, { code: 0, signal: null, decoded: X.decodeExitCode(0), pid: 4242, uptimeMs: 3_600_000 });
  assert.deepEqual(rec.hooks, { lastHookAt: '2026-10-21T04:58:14.000Z', lastHookAgoMs: 26_000, lastHookEvent: 'PostToolUse', runningTool: { name: 'wait_agent', forMs: 26_000 } });
  assert.deepEqual(rec.screen.rows, ['a', 'b']);
  assert.equal(rec.rawTail, 'bye\n');
  assert.deepEqual(rec.truncated, []);
  const noMirror = X.buildExitRecord(facts(), { screen: null, children: null, transcript: null, codexLog: null });
  assert.equal(noMirror.screen.error, 'no mirror');
});

test('X7: a huge record is cut under 64 KB, each cut named', () => {
  const big = 'y'.repeat(239);
  const parts = {
    screen: { lines: Array.from({ length: 40 }, () => big), altScreen: true },
    children: Array.from({ length: 400 }, (_, i) => ({ pid: i, parentPid: 1, createdMs: 1, commandLine: big })),
    transcript: { file: 'f', mtimeMs: 1, bytes: 1, lastRowAt: null, lastCall: null, rows: Array.from({ length: 20 }, () => ({ at: null, type: 't', kind: 'k', text: big })) },
    codexLog: { file: 'f', process: 'p', match: 'pid', rows: Array.from({ length: 30 }, () => ({ ts: 1, level: 'I', target: 't', body: big })) }
  };
  const rec = X.buildExitRecord(facts({ rawTail: '\n' + 'z'.repeat(4095) }), parts);
  assert.ok(Buffer.byteLength(JSON.stringify(rec)) <= X.EXIT_RECORD_MAX_BYTES, 'under the cap');
  assert.deepEqual(rec.truncated, ['rawTail', 'children']);
  assert.equal(rec.children.length, 10);
  const tiny = X.buildExitRecord(facts({ rawTail: '\n' + 'z'.repeat(4095) }), parts, 2048);
  assert.deepEqual(tiny.truncated, ['rawTail', 'children', 'codexLog', 'transcript', 'screen', 'all']);
});

test('X8: records go to <hive>/exits/<agent>/ and only the newest 20 stay; a path-like agent id is refused', () => {
  const hive = newHive();
  let last;
  for (let i = 0; i < 23; i++) last = X.writeExitRecord(hive, { agentId: 'a1', at: new Date(EXIT + i * 1000).toISOString(), incarnation: i });
  const dir = path.join(hive, 'exits', 'a1');
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, X.EXIT_RECORDS_KEPT);
  assert.equal(names[0], '2026-10-21T04-58-43-000Z-3.json', 'the three oldest went');
  assert.equal(path.dirname(last), dir);
  assert.equal(JSON.parse(fs.readFileSync(last, 'utf8')).incarnation, 22);
  assert.throws(() => X.writeExitRecord(hive, { agentId: '../x', at: 'a', incarnation: 1 }), /bad agent id/);
});

// --- recordExit: async, never throws, always disposes ------------------------------------------

function deps(hive, over = {}) {
  const mirror = fakeMirror();
  const logs = [];
  return {
    mirror, logs,
    d: {
      hiveRoot: hive, readScreen: () => mirror.read(), disposeScreen: () => mirror.dispose(),
      listProcesses: async () => [{ pid: 10, parentPid: 4242, commandLine: 'node --test', createdMs: EXIT - 1000 }],
      transcript: () => null, codexHome: 'C:/ch', openSqlite: () => fakeDb(logRows), log: (r) => logs.push(r), ...over
    }
  };
}

test('recordExit writes one record and one log row naming the in-flight call and the children', async () => {
  const hive = newHive();
  const f = path.join(TMP, 'rollout-live.jsonl'); fs.writeFileSync(f, codexRows);
  const { d, mirror, logs } = deps(hive, { transcript: () => ({ provider: 'codex', file: f }) });
  const file = await X.recordExit(facts(), d);
  assert.equal(mirror.disposed, 1);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(rec.screen.rows, ['$ codex', 'thinking…']);
  assert.deepEqual(rec.children.map((c) => c.pid), [10]);
  assert.equal(rec.transcript.file, f);
  assert.equal(rec.transcript.lastCall.name, 'wait_agent');
  assert.equal(rec.codexLog.match, 'pid');
  assert.deepEqual(logs, [{ kind: 'pty-exit-record', agentId: 'dwight-mu32ztys', incarnation: 7, provider: 'codex', exitCode: 0, decoded: X.decodeExitCode(0), signal: null,
    lastHookEvent: 'PostToolUse', runningTool: 'wait_agent', lastCall: 'wait_agent (no output)', children: 1, record: file }]);
});

test('X9: a hung or throwing screen read still disposes the mirror and still writes the record', async () => {
  const hive = newHive();
  const hung = deps(hive, { readScreen: () => new Promise(() => {}) });
  const t0 = Date.now();
  // within()'s timer is unref'd (a pending record never holds the app open); main's loop is alive.
  const alive = setInterval(() => {}, 100);
  const file = await X.recordExit(facts({ provider: 'claude' }), hung.d).finally(() => clearInterval(alive));
  assert.ok(Date.now() - t0 < X.EXIT_MIRROR_READ_MS + 1000, 'bounded by the read timeout');
  assert.equal(hung.mirror.disposed, 1);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).screen.error, /mirror read gave nothing/);
  const throws = deps(hive, { readScreen: () => { throw new Error('mirror gone'); } });
  const f2 = await X.recordExit(facts({ provider: 'claude', incarnation: 8 }), throws.d);
  assert.equal(throws.mirror.disposed, 1);
  assert.equal(JSON.parse(fs.readFileSync(f2, 'utf8')).screen.error, 'mirror gone');
});

test('X10: every reader failing still yields a record; a write failure is logged, never thrown', async () => {
  const hive = newHive();
  const { d, logs } = deps(hive, {
    listProcesses: async () => null, transcript: () => ({ provider: 'codex', file: path.join(TMP, 'gone.jsonl') }),
    openSqlite: () => { throw new Error('SQLITE_BUSY'); }
  });
  const file = await X.recordExit(facts({ pid: null }), d);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.childrenError, 'no pid');
  assert.ok(rec.transcript.error);
  assert.equal(rec.codexLog.error, 'SQLITE_BUSY');
  const blocked = path.join(TMP, 'not-a-dir'); fs.writeFileSync(blocked, 'x');
  const bad = deps(blocked);
  assert.equal(await X.recordExit(facts(), bad.d), null);
  assert.equal(bad.logs.length, 1);
  assert.equal(bad.logs[0].record, null);
  assert.equal(bad.mirror.disposed, 1);
});

// --- main wiring (source pins) -----------------------------------------------------------------

test('X13/X14: main records only an unrequested, non-installer end, takes its facts synchronously and fires and forgets', () => {
  const INDEX = codeOnly(readSource('src/main/index.ts'));
  const obs = INDEX.slice(INDEX.indexOf('ptyManager.setEndObserver((e) => {'), INDEX.indexOf('function recordUnrequestedExit('));
  assert.ok(obs.includes('if (!e.explicit && e.evidence && !pendingInstallRelaunch.has(e.id)) {'), 'the guard');
  assert.ok(obs.indexOf('agentLiveness.notePtyEnd(') < obs.indexOf('recordUnrequestedExit('), 'liveness first');
  const fn = INDEX.slice(INDEX.indexOf('function recordUnrequestedExit('), INDEX.indexOf('ptyManager.setExitHandler('));
  assert.doesNotMatch(fn, /^function recordUnrequestedExit\([^)]*\)[^{]*async|\bawait\b/, 'the facts are taken before any await');
  assert.ok(fn.includes('void recordExit(facts, {'), 'fire and forget');
  for (const t of ['hookSeenAt.get(agentId)', 'hookSeenEvent.get(agentId)', 'hookServer.runningTool(agentId)', 'heavyLock.snapshot().filter((h) => h.agentId === agentId)', 'listProcesses: probeProcesses',
    'new Database(file, { readonly: true, fileMustExist: true, timeout: 0 })', 'disposeScreen: () => mirror?.dispose()']) assert.ok(fn.includes(t), t);
  assert.ok(fn.indexOf('const mirror = ev.takeMirror();') < fn.indexOf('if (!root) { mirror?.dispose(); return; }'), 'no hive: the taken mirror is still disposed');
  // Every hook's event name is stamped where every hook passes (the liveness-edge wrapper).
  const wrap = INDEX.slice(INDEX.indexOf('function withLivenessEdge('), INDEX.indexOf('function noteBootHook('));
  assert.ok(wrap.includes('if (agentId && event) hookSeenEvent.set(agentId, event);'));
});
