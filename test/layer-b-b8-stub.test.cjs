'use strict';
/**
 * ZT-I1-MAIL layer (b), dry run #3 follow-up (god-approved, test infrastructure only):
 *  (a) the stub hook client mirrors the real shim (write, read the whole reply, destroy on 'end',
 *      5 s cap), and a stub run with any mail-hook-late row for a stub agent is a FAIL whose report
 *      lists the rows;
 *  (b) B8 checks the marker in the detail-panel HEADER, records hive:inbox in the SAME renderer
 *      evaluation as the DOM rows, saves a DOM snapshot, and waits by CONDITION: a hive:inbox poll
 *      that started after the mark has COMPLETED (main-process probe) and the DOM shows its rows.
 *      The 10 s is only a cap, and hitting it FAILS B8 with the snapshot.
 * Nothing here launches the app, Electron, a window or any CLI. The only child processes are the
 * plain-node stub TUI itself (hidden, killed after each test) talking to an in-test pipe server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readSource, codeOnly } = require('./read-source.cjs');

const RUNNER = path.join(__dirname, 'tools', 'layer-b-run.cjs');
const lb = require(RUNNER);
const src = codeOnly(readSource(RUNNER), 'layer-b-run.cjs');
const method = (name) => { const a = src.indexOf(`  ${name} {`) >= 0 ? src.indexOf(`  ${name} {`) : src.indexOf(`  async ${name} {`); assert.ok(a >= 0, name); return src.slice(a, src.indexOf('\n  }\n', a)); };

// ─────────────────────────────────────────────────────────────── (a) the stub hook client

/** Start the stub TUI (plain node, hidden) against an in-test pipe server; `onConn(conn, line)`
 *  answers each hook frame. Returns { child, conns } and kills the child after the test. */
async function withStub(t, onConn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-stubhook-'));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\lb-stubhook-${process.pid}-${Date.now()}` : path.join(dir, 's.sock');
  const conns = [];
  const server = net.createServer((conn) => {
    const rec = { line: null, openedAt: Date.now(), replyAt: null, eofAt: null, finishAt: null, closedAt: null };
    conns.push(rec);
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1 || rec.line) return;
      rec.line = JSON.parse(buf.slice(0, nl));
      onConn({ reply: (text) => { rec.replyAt = Date.now(); conn.end(text); } }, rec.line);
    });
    // The product's delivery signal (src/main/hooks.ts watchMailFlush) is 'finish' vs 'close'. A
    // client EOF makes the server auto-end (allowHalfOpen false), which emits 'finish' with NO
    // reply written, or leaves the late reply nowhere to go: so the client must not EOF first.
    conn.on('end', () => { rec.eofAt = Date.now(); });
    conn.on('finish', () => { rec.finishAt = Date.now(); });
    conn.on('close', () => { rec.closedAt = Date.now(); });
    conn.on('error', () => {});
  });
  await new Promise((r) => server.listen(pipe, r));
  const stub = path.join(dir, 'stub.cjs');
  fs.writeFileSync(stub, lb.stubSource('lb-test', pipe, path.join(dir, 'typed.log'), dir, 50));
  const child = spawn(process.execPath, [stub], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* gone */ } server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { child, conns };
}
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return cond(); };

test('(a) the stub hook client keeps its side open until it has READ the reply: no EOF before a (slow) 512 KiB reply, which then finishes', { timeout: 30_000 }, async (t) => {
  const big = JSON.stringify({ hookSpecificOutput: { additionalContext: 'x'.repeat(512 * 1024) } });
  // The server answers 300 ms later (a busy main process). The OLD stub (c.end(payload), never
  // read) sent its EOF ~50 ms in: the server auto-ended with no reply written (measured).
  const { conns } = await withStub(t, (conn) => setTimeout(() => conn.reply(big), 300));
  assert.ok(await until(() => conns.length >= 1 && conns[0].closedAt, 15_000), 'the SessionStart frame was answered and the connection closed');
  const c = conns[0];
  assert.equal(c.line.hook_event_name, 'SessionStart');
  assert.ok(c.replyAt, 'the reply was written');
  assert.ok(c.eofAt === null || c.eofAt >= c.replyAt, `no client EOF before the reply (eof +${c.eofAt - c.openedAt} ms, reply +${c.replyAt - c.openedAt} ms)`);
  assert.ok(c.finishAt && c.finishAt >= c.replyAt, 'finish comes from flushing the reply (the product\'s delivered signal), not from an auto-end');
});

test('(a) the stub hook client hangs up after 5 s when no reply ever ends (the real shim\'s cap)', { timeout: 30_000 }, async (t) => {
  const { conns } = await withStub(t, () => { /* never answer */ });
  assert.ok(await until(() => conns.length >= 1 && conns[0].line, 10_000));
  assert.ok(await until(() => conns[0].closedAt, 9_000), 'the stub closed the silent connection');
  const held = conns[0].closedAt - conns[0].openedAt;
  assert.ok(held >= 4_500 && held < 8_000, `closed by the 5 s cap (held ${held} ms)`);
});

test('(a) static: the stub writes (no half-close), reads, destroys on end, caps at 5 s, like HOOK_SHIM', () => {
  const s = lb.stubSource('a', 'p', 't', 'd', 600);
  const emit = s.slice(s.indexOf('function emit('), s.indexOf('function replyFromInbox('));
  assert.match(emit, /c\.write\(JSON\.stringify\(/);
  assert.ok(!/c\.end\(/.test(emit), 'never c.end(payload): that hung up before the reply');
  assert.match(emit, /c\.on\('data', function \(\) \{\}\);/);
  assert.match(emit, /c\.on\('end', finish\);/);
  assert.match(emit, /setTimeout\(finish, 5000\)/);
  assert.match(emit, /c\.destroy\(\)/);
  const shim = readSource(path.join(__dirname, '..', 'src', 'main', 'hive.ts'));
  assert.match(shim, /const c = net\.createConnection\(sock, \(\) => c\.write\(JSON\.stringify\(payload\) \+ '\\\\n'\)\);/);
  assert.match(shim, /c\.on\('end', \(\) => done\(0\)\);/);
  assert.match(shim, /setTimeout\(\(\) => process\.exit\(0\), 5000\)\.unref\(\);/);
});

test('(a) lateHookRows: every mail-hook-late row is listed; the ones for a stub agent (or after allStubsSince) are flagged', () => {
  const row = (agentId, ts, extra = {}) => JSON.stringify({ ts, kind: 'mail-hook-late', agentId, ids: ['m1'], epoch: 1, hookKind: 'UserPromptSubmit', transport: 'pipe', latencyMs: null, limitMs: 2000, ...extra });
  const text = [row('god', 100), row('lb-claude', 200), JSON.stringify({ ts: 150, kind: 'mail-surfaced', agentId: 'god' }), 'not json mail-hook-late', row('lb-codex', 900), ''].join('\n');
  const r = lb.lateHookRows([text], ['god'], 500);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.stub.map((x) => x.agentId), ['god', 'lb-codex']);
  assert.deepEqual(lb.lateHookRows([text], ['god', 'lb-claude', 'lb-codex'], null).stub.length, 3, 'dry run: every agent is a stub');
  assert.equal(lb.lateHookRows([row('lb-claude', 1)], ['god'], null).stub.length, 0, 'a real CLI\'s late row is listed, not flagged');
});

test('(a) a run with a stub mail-hook-late row FAILS its check, and the report lists the rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-late-'));
  try {
    const late = JSON.stringify({ ts: 5, kind: 'mail-hook-late', agentId: 'god', ids: ['x'], hookKind: 'UserPromptSubmit', transport: 'pipe', latencyMs: null, limitMs: 2000 });
    fs.writeFileSync(path.join(dir, 'log.jsonl'), late + '\n');
    const checks = [];
    const fake = { s: { hive: dir }, spec: [{ id: 'god', stub: true }, { id: 'lb-claude', stub: false }], allStubsSince: null, check(ok, label, detail) { checks.push({ ok, label, detail }); return ok; } };
    lb.LayerB.prototype.assertNoStubLateHooks.call(fake);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail, /god UserPromptSubmit \["x"\] latency null/);
    assert.equal(fake.lateHooks.stub.length, 1);
    fs.writeFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ ts: 5, kind: 'mail-hook-late', agentId: 'lb-claude' }) + '\n');
    checks.length = 0;
    lb.LayerB.prototype.assertNoStubLateHooks.call(fake);
    assert.equal(checks[0].ok, true, 'a real CLI\'s late row does not fail the stub check');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The teardown runs it (after the final stop, before the evidence); a failed check means ok:false.
  const td = src.slice(src.indexOf('try { this.assertNoStubLateHooks(); }'), src.indexOf('try { evidence = this.collectEvidence(); }'));
  assert.ok(td.length > 0 && src.indexOf("await this.stopApp('final')") < src.indexOf('try { this.assertNoStubLateHooks(); }'));
  assert.match(src, /const ok = !this\.stopReason && asserted\.every\(\(f\) => f\.status === 'PASS'\) && this\.checks\.every\(\(c\) => c\.ok\);/);
  const rep = method('report(extra)');
  assert.match(rep, /'## mail-hook-late rows'/);
  assert.match(rep, /\.\.\.this\.lateHooks\.rows\.map\(\(r\) =>/);
  assert.match(src, /this\.allStubsSince = Date\.now\(\);[^\n]*\n\s*await this\.launch\(this\.exe174, '1\.1\.74\+seams \(rollback\)'\);/);
});

// ─────────────────────────────────────────────────────────────── (b) B8

/** The serialized functions must stand alone (they run in another process). */
const standalone = (fn) => new Function(`return (${fn.toString()});`)();

test('(b) the main-process hive:inbox probe: transparent, records COMPLETED calls in order, fails closed, restores', async () => {
  const install = standalone(lb.installInboxProbe);
  const query = standalone(lb.inboxProbeQuery);
  const uninstall = standalone(lb.uninstallInboxProbe);
  const rows = [{ id: 'm1', mail_state: 'delivered', body: 'LBN-00000001 hello' }, { id: 'm2', body: 'no state' }];
  let release;
  const orig = async (_evt, id) => { if (id === 'slow') await new Promise((r) => { release = r; }); if (id === 'boom') throw new Error('boom'); return rows; };
  const ipcMain = { _invokeHandlers: new Map([['hive:inbox', orig]]) };
  const root = {};
  let t = 1000;
  const now = () => t++;
  assert.deepEqual(JSON.parse(install({ _invokeHandlers: new Map() }, {}, now)).ok, false, 'no handler: the probe says so (B8 FAILS, never a timing fallback)');
  assert.equal(JSON.parse(install(ipcMain, root, now)).ok, true);
  assert.equal(JSON.parse(install(ipcMain, root, now)).already, true, 'idempotent');
  const h = ipcMain._invokeHandlers.get('hive:inbox');
  assert.notEqual(h, orig);
  assert.equal(await h({}, 'lb-claude'), rows, 'transparent: the same rows object reaches the renderer');
  let q = JSON.parse(query(root, 'lb-claude', 0));
  assert.equal(q.call.seq, 1);
  assert.deepEqual(q.call.rows, [{ id: 'm1', state: 'delivered', body: 'LBN-00000001 hello' }, { id: 'm2', state: 'unknown', body: 'no state' }]);
  assert.ok(q.call.doneAt >= q.call.startedAt);
  assert.equal(JSON.parse(query(root, 'lb-claude', q.seq)).call, null, 'nothing started after the mark yet');
  assert.equal(JSON.parse(query(root, 'god', 0)).call, null, 'another agent\'s poll never counts');
  // A call in flight is not "completed".
  const mark = JSON.parse(query(root, 'lb-claude', 0)).seq;
  const pending = h({}, 'slow');
  assert.equal(JSON.parse(query(root, 'slow', mark)).call, null);
  release(); await pending;
  assert.equal(JSON.parse(query(root, 'slow', mark)).call.seq, mark + 1);
  // A failed call propagates and is never counted.
  await assert.rejects(h({}, 'boom'), /boom/);
  assert.equal(JSON.parse(query(root, 'boom', 0)).call, null);
  assert.equal(JSON.parse(uninstall(ipcMain, root)).ok, true);
  assert.equal(ipcMain._invokeHandlers.get('hive:inbox'), orig, 'the original handler is back');
});

/** A tiny DOM stand-in: tag + attributes + children; querySelector(All) for `tag[attr]`,
 *  `tag[attr="v"]`, `tag[attr^="v"]` and `[attr="v"]` (all the snapshot uses). */
function el(tag, attrs = {}, children = []) {
  const e = { tag, attrs, children: [], parentElement: null };
  for (const c of children) { if (typeof c === 'string') e.children.push({ text: c }); else { c.parentElement = e; e.children.push(c); } }
  Object.defineProperty(e, 'textContent', { get: () => e.children.map((c) => (c.text !== undefined ? c.text : c.textContent)).join('') });
  e.getAttribute = (k) => (k in attrs ? attrs[k] : null);
  const all = () => { const out = []; const rec = (n) => { for (const c of n.children) if (c.tag) { out.push(c); rec(c); } }; rec(e); return out; };
  const match = (n, sel) => {
    const m = /^([a-z]*)\[([a-z-]+)(?:(\^?=)"([^"]*)")?\]$/.exec(sel);
    if (!m) throw new Error(`fake DOM: unsupported selector ${sel}`);
    const [, tg, k, op, v] = m;
    if (tg && n.tag !== tg) return false;
    if (!(k in n.attrs)) return false;
    return !op || (op === '=' ? n.attrs[k] === v : String(n.attrs[k]).startsWith(v));
  };
  e.querySelectorAll = (sel) => all().filter((n) => match(n, sel));
  e.querySelector = (sel) => e.querySelectorAll(sel)[0] || null;
  return e;
}
function fakeDoc({ name = 'Marker-V1-abc', messagesActive = true, rows = [] } = {}) {
  const tab = (label, active) => el('button', { 'aria-label': label, title: label, style: active ? 'background: var(--cth-cream-100);' : 'background: transparent;' }, [label]);
  const header = el('div', {}, [el('span', { title: `${name} — double-click to rename` }, [name.toUpperCase()]), el('button', { 'aria-label': `Rename ${name}` }, ['r']),
    el('button', {}, [el('span', { 'aria-label': 'Edit this agent' }, ['Edit'])])]);
  const threads = rows.map((r) => el('div', {}, [el('div', {}, [el('span', {}, ['god']), el('span', { title: `mail state: ${r.state}` }, [r.label]), el('span', {}, ['date'])]), el('div', {}, [r.body])]));
  return el('body', {}, [header, el('div', {}, [tab('terminal', !messagesActive), tab('messages', messagesActive), tab('git', false)]), el('div', {}, threads)]);
}

test('(b) domPanelSnapshot: the header name (exact case, from the Rename button), the tab states, the rows, the nonce rows', () => {
  const snap = standalone(lb.domPanelSnapshot)(fakeDoc({ rows: [{ state: 'delivered', label: 'waiting', body: 'LBN-00000001 hi' }, { state: 'acted', label: 'handled', body: 'other' }] }), 'LBN-00000001');
  assert.equal(snap.header.name, 'Marker-V1-abc');
  assert.match(snap.header.text, /MARKER-V1-ABC/, 'the visible name is upper-cased: the old case-sensitive text check could never match');
  assert.deepEqual(snap.tabs, [{ label: 'terminal', active: false }, { label: 'messages', active: true }, { label: 'git', active: false }]);
  assert.equal(snap.messagesTabActive, true);
  assert.equal(snap.stateSpans, 2);
  assert.deepEqual(snap.rows.map((r) => [r.state, r.label]), [['delivered', 'waiting'], ['acted', 'handled']]);
  assert.equal(snap.nonceRows, 1);
  const none = standalone(lb.domPanelSnapshot)(el('body', {}, []), 'x');
  assert.equal(none.header, null);
  assert.equal(none.stateSpans, 0);
});

test('(b) panelMatchesPoll: only a completed poll, on the marker\'s panel, with the messages tab active, whose rows the DOM shows', () => {
  const N = 'LBN-00000001';
  const snapFor = (o) => standalone(lb.domPanelSnapshot)(fakeDoc(o), N);
  const rows = [{ state: 'delivered', label: 'waiting', body: `${N} hi` }];
  const call = { seq: 7, doneAt: 1, rows: [{ id: 'm1', state: 'delivered', body: `${N} hi` }] };
  assert.equal(lb.panelMatchesPoll(snapFor({ rows }), null, 'Marker-V1-abc', N).ok, false, 'no completed poll: never ok');
  assert.match(lb.panelMatchesPoll(snapFor({ rows, name: 'Codex-LB' }), call, 'Marker-V1-abc', N).why, /shows "Codex-LB"/);
  assert.match(lb.panelMatchesPoll(snapFor({ rows, messagesActive: false }), call, 'Marker-V1-abc', N).why, /messages tab/);
  assert.match(lb.panelMatchesPoll(snapFor({ rows: [] }), call, 'Marker-V1-abc', N).why, /not the completed poll/, 'stale DOM (the poll not rendered yet)');
  assert.match(lb.panelMatchesPoll(snapFor({ rows: [{ ...rows[0], body: 'other' }] }), call, 'Marker-V1-abc', N).why, /with the nonce/);
  assert.equal(lb.panelMatchesPoll(snapFor({ rows }), call, 'MARKER-V1-ABC', N).ok, true, 'the name match ignores case');
  assert.equal(lb.panelMatchesPoll(snapFor({ rows }), call, 'Marker-V1-abc', N).ok, true);
});

test('Jim LOW gap R4: panelMatchesPoll rejects on the NONCE COUNT ALONE (same states, same row count, header and tab right)', () => {
  const N = 'LBN-00000001';
  const snapFor = (rows) => standalone(lb.domPanelSnapshot)(fakeDoc({ rows }), N);
  const call = (bodies) => ({ seq: 9, doneAt: 1, rows: bodies.map((b, i) => ({ id: `m${i}`, state: 'delivered', body: b })) });
  // The poll has TWO rows with the nonce; the DOM shows the same two delivered rows, ONE with it.
  const dom = snapFor([{ state: 'delivered', label: 'waiting', body: `${N} a` }, { state: 'delivered', label: 'waiting', body: 'other' }]);
  const r = lb.panelMatchesPoll(dom, call([`${N} a`, `${N} b`]), 'Marker-V1-abc', N);
  assert.equal(r.ok, false, 'the state multiset matches; only the nonce count differs');
  assert.match(r.why, /the poll returned 2 row\(s\) with the nonce, the DOM shows 1/);
  // And the other way round: the DOM shows the nonce the poll does not have.
  const r2 = lb.panelMatchesPoll(snapFor([{ state: 'delivered', label: 'waiting', body: `${N} a` }, { state: 'delivered', label: 'waiting', body: `${N} b` }]), call([`${N} a`, 'other']), 'Marker-V1-abc', N);
  assert.equal(r2.ok, false);
  assert.match(r2.why, /the poll returned 1 row\(s\) with the nonce, the DOM shows 2/);
  assert.equal(lb.panelMatchesPoll(dom, call([`${N} a`, 'other']), 'Marker-V1-abc', N).ok, true, 'equal counts match');
});

test('(b) waitPanelPoll: returns ok ONLY when the condition holds; the 10 s cap returns ok:false with the snapshot; no probe returns at once', async () => {
  const N = 'LBN-00000001';
  const snapOk = standalone(lb.domPanelSnapshot)(fakeDoc({ rows: [{ state: 'delivered', label: 'waiting', body: N }] }), N);
  const call = { seq: 3, startedAt: 1, doneAt: 2, rows: [{ id: 'm', state: 'delivered', body: N }] };
  // The condition becomes true on the 3rd check (a poll completes, then it renders).
  let n = 0;
  const fake = { aborted: () => false,
    inboxProbe: async () => ({ installed: true, seq: 3, call: n >= 1 ? call : null }),
    panelSnapshot: async () => { n++; return n >= 3 ? snapOk : standalone(lb.domPanelSnapshot)(fakeDoc({ rows: [] }), N); } };
  const w = await lb.LayerB.prototype.waitPanelPoll.call(fake, 'lb-claude', 'Marker-V1-abc', 2, N, 'before');
  assert.equal(w.ok, true);
  assert.equal(n, 3, 'it waited for the condition, not for a time');
  assert.equal(w.probe.call.seq, 3);
  // Never true: the cap ends it (Date.now jumps 4 s per check), ok:false with the snapshot.
  const realNow = Date.now;
  let t0 = realNow();
  Date.now = () => (t0 += 4000);
  try {
    const never = { aborted: () => false, inboxProbe: async () => ({ installed: true, seq: 9, call: null }), panelSnapshot: async () => snapOk };
    const c = await lb.LayerB.prototype.waitPanelPoll.call(never, 'lb-claude', 'Marker-V1-abc', 9, N, 'after');
    assert.equal(c.ok, false);
    assert.equal(c.capped, true);
    assert.equal(c.snap, snapOk, 'the snapshot comes back for the FAIL');
  } finally { Date.now = realNow; }
  const gone = await lb.LayerB.prototype.waitPanelPoll.call({ aborted: () => false, inboxProbe: async () => ({ installed: false, seq: 0, call: null }), panelSnapshot: async () => snapOk }, 'lb-claude', 'M', 0, N, 'x');
  assert.equal(gone.ok, false);
});

test('(b) b8Verdict: a capped wait or an unobservable poll is a FAIL with the snapshot; a held message missing from the rendered poll is a FAIL', () => {
  const v = (x) => lb.LayerB.prototype.b8Verdict.call({}, x);
  const snap = { header: { name: 'Marker-V1-abc' }, tabs: [], stateSpans: 0 };
  const obs = (ok, rows = [], ipc = []) => ({ label: ok ? 'fine' : 'before Stop', wait: { ok, snap, probe: { seq: 1 }, match: { ok, why: ok ? 'poll #2 rendered' : 'no hive:inbox poll for the agent has completed since the mark' } }, capture: ok ? { dom: { rows }, ipc } : null });
  const r1 = [{ label: 'waiting', text: 'N' }];
  assert.equal(v({ probe: { ok: false, error: 'no handler' }, prep: { ok: true }, obsBefore: null, obsAfter: null, domBefore: [], domAfter: [], acted: true })[0], 'FAIL');
  const capped = v({ probe: { ok: true }, prep: { ok: true }, obsBefore: obs(false), obsAfter: obs(true), domBefore: [], domAfter: [], acted: true });
  assert.equal(capped[0], 'FAIL');
  assert.match(capped[1], /10 s cap/);
  assert.match(capped[1], /snapshot \{"header":\{"name":"Marker-V1-abc"\}/);
  assert.equal(v({ probe: { ok: true }, prep: { ok: true }, obsBefore: obs(true), obsAfter: obs(true), domBefore: [], domAfter: [], acted: true })[0], 'FAIL');
  assert.equal(v({ probe: { ok: true }, prep: { ok: true }, obsBefore: obs(true, r1), obsAfter: obs(true, r1), domBefore: r1, domAfter: r1, acted: null })[0], 'NOT-PROVEN');
  const unselected = v({ probe: { ok: true }, prep: { ok: false, step: 'tab', why: 'the messages tab never became the active one within the 10 s cap', snap: { header: { name: 'Marker-V1-abc' }, tabs: [{ label: 'terminal', active: true }, { label: 'messages', active: false }], stateSpans: 0 } }, obsBefore: null, obsAfter: null, domBefore: [], domAfter: [], acted: true });
  assert.equal(unselected[0], 'FAIL', 'a selection step that hit its cap FAILS B8');
  assert.match(unselected[1], /^selection step "tab": the messages tab never became the active one within the 10 s cap; snapshot \{"header":\{"name":"Marker-V1-abc"\},"tabs":\[\{"label":"terminal","active":true\}/);
  const handled = [{ label: 'handled', text: 'N' }];
  const pass = v({ probe: { ok: true }, prep: { ok: true }, obsBefore: obs(true, r1, [{ state: 'delivered', hasNonce: true }]), obsAfter: obs(true, handled, [{ state: 'acted', hasNonce: true }]), domBefore: r1, domAfter: handled, acted: true });
  assert.equal(pass[0], 'PASS');
  assert.match(pass[1], /panel header "Marker-V1-abc"/);
  assert.match(pass[1], /hive:inbox in the same evaluation: \["delivered"\]/);
});

test('(b) static: B8 has no fixed sleep, reads the header (not agent-effective-model), captures DOM + hive:inbox in ONE evaluation, saves b8-dom.json', () => {
  const fact = src.slice(src.indexOf('  async factB1B8B9() {'), src.indexOf('  async factB2() {'));
  assert.ok(!/agent-effective-model/.test(src), 'the model element renders only when a run model is known');
  assert.deepEqual(fact.match(/sleep\(\d+\)/g), ['sleep(2000)'], 'the only sleep is the B9 sample spacing');
  assert.ok(!/sleep\(/.test(method('async clickAgentCard(name)')) && !/sleep\(/.test(method('async clickMessagesTab()')), 'the clicks do not wait');
  assert.ok(!/sleep\(/.test(method('async b8Prepare(marker, nonce)')), 'the selection waits only through panelCondition');
  const pc = method('async panelCondition(pred, nonce)');
  assert.match(pc, /if \(pred\(snap\)\) return \{ ok: true, snap \};/);
  assert.match(pc, /if \(Date\.now\(\) >= cap\) return \{ ok: false, capped: true, snap \};/);
  assert.equal((pc.match(/return \{ ok: true/g) || []).length, 1, 'one way to succeed: the condition');
  assert.ok(!/sleep\(/.test(method('async b8Observe(agentId, marker, nonce, label)')));
  const w = method('async waitPanelPoll(agentId, marker, afterSeq, nonce, label)');
  assert.match(w, /if \(m\.ok\) return \{ ok: true, \.\.\.last \};/);
  assert.match(w, /const cap = Date\.now\(\) \+ 10_000;/);
  assert.match(w, /if \(!q\.installed \|\| Date\.now\(\) >= cap\) return \{ ok: false, capped: Date\.now\(\) >= cap, \.\.\.last \};/);
  assert.equal((w.match(/return \{ ok: true/g) || []).length, 1, 'one way to succeed: the condition');
  const obs = method('async b8Observe(agentId, marker, nonce, label)');
  assert.match(obs, /const mark = await this\.inboxProbe\('query', agentId, 0\);\n\s*const w = await this\.waitPanelPoll\(agentId, marker, mark\.seq, nonce, label\);/);
  assert.match(obs, /this\.samples\.b8\.push\(rec\);/);
  const cap = method('async captureRowsAndInbox(agentId, nonce)');
  assert.equal((cap.match(/this\.page\.eval\(/g) || []).length, 1, 'ONE renderer evaluation');
  assert.ok(cap.indexOf('domPanelSnapshot') < cap.indexOf('window.cth.hiveInbox('), 'the DOM is read first, then the reader, in the same evaluation');
  // The fact: the probe is installed BEFORE the selection; both observations come after it.
  assert.ok(fact.indexOf("this.inboxProbe('install')") < fact.indexOf('this.b8Prepare(this.markerV1, N1)'));
  assert.ok(fact.indexOf('this.b8Prepare(this.markerV1, N1)') < fact.indexOf("this.b8Observe(C, this.markerV1, N1, 'before Stop (held delivered)')"));
  assert.match(fact, /const obsBefore = probe\.ok && prep\.ok \? await this\.b8Observe\(/, 'no poll wait on an unproven selection');
  assert.match(fact, /this\.fact\('B8', \.\.\.this\.b8Verdict\(/);
  assert.match(method('collectEvidence()'), /W\.write\(path\.join\(dst, 'b8-dom\.json'\), redact\(JSON\.stringify\(this\.samples\.b8 \|\| \[\], null, 2\)\)\);/);
  // The main-process probe evaluation is the sync kind, like every main-process expression.
  assert.match(method('async inboxProbe(kind, agentId, afterSeq)'), /this\.mainCdp\.eval\(expr, undefined, \{ sync: true \}\)/);
});

// ─────────────────────────────────────────────────────────────── dry run #4 follow-up

test('(dry #4) B8 selection: card click, then WAIT for the header marker; tab click, then WAIT for it active; the tab is clicked only once the agent panel exists', async () => {
  const N = 'LBN-00000001';
  const events = [];
  // A fake page: the card click swaps the Command Center (no tabs) for the agent's panel only on a
  // LATER check (the next render), exactly the dry-run #4 failure mode.
  let panel = 'command-center';
  let tab = 'terminal';
  let checks = 0;
  const snap = () => ({ header: panel === 'agent' ? { name: 'Marker-V1-abc' } : null, tabs: panel === 'agent' ? [{ label: 'terminal', active: tab === 'terminal' }, { label: 'messages', active: tab === 'messages' }] : [], messagesTabActive: panel === 'agent' && tab === 'messages', stateSpans: 0, rows: [] });
  const fake = { samples: { b8: [] }, aborted: () => false,
    clickAgentCard: async () => { events.push('card'); setTimeout(() => { panel = 'agent'; }, 300); return { card: true, wasCurrent: false }; },
    clickMessagesTab: async () => { events.push(`tab(panel=${panel})`); if (panel === 'agent') setTimeout(() => { tab = 'messages'; }, 300); return { tab: panel === 'agent', wasActive: false }; },
    panelSnapshot: async () => { checks++; return snap(); },
    panelCondition: lb.LayerB.prototype.panelCondition };
  const r = await lb.LayerB.prototype.b8Prepare.call(fake, 'Marker-V1-abc', N);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(events, ['card', 'tab(panel=agent)'], 'the tab was clicked only after the header proved the agent panel');
  assert.equal(fake.samples.b8.length, 2, 'both steps recorded');
  assert.ok(fake.samples.b8.every((x) => x.wait.ok));
  assert.ok(checks >= 3, 'it waited on the condition, re-checking');
});

test('(dry #4) B8 selection: a step that never holds FAILS at its 10 s cap with the snapshot (no tab click on an unproven panel)', async () => {
  const realNow = Date.now;
  let t0 = realNow();
  Date.now = () => (t0 += 3000);
  try {
    const events = [];
    const stuck = { header: { name: 'Marker-V1-abc' }, tabs: [{ label: 'terminal', active: true }, { label: 'messages', active: false }], messagesTabActive: false, stateSpans: 0, rows: [] };
    const fake = { samples: { b8: [] }, aborted: () => false,
      clickAgentCard: async () => { events.push('card'); return { card: true, wasCurrent: true }; },
      clickMessagesTab: async () => { events.push('tab'); return { tab: true, wasActive: false }; },
      panelSnapshot: async () => stuck, panelCondition: lb.LayerB.prototype.panelCondition };
    const r = await lb.LayerB.prototype.b8Prepare.call(fake, 'Marker-V1-abc', 'N');
    assert.equal(r.ok, false);
    assert.equal(r.step, 'tab');
    assert.equal(r.snap, stuck);
    assert.equal(fake.samples.b8[1].wait.capped, true);
    const wrong = { ...stuck, header: { name: 'Codex-LB' } };
    const f2 = { ...fake, samples: { b8: [] }, panelSnapshot: async () => wrong, clickMessagesTab: async () => { events.push('tab2'); return {}; } };
    const r2 = await lb.LayerB.prototype.b8Prepare.call(f2, 'Marker-V1-abc', 'N');
    assert.equal(r2.step, 'card');
    assert.ok(!events.includes('tab2'), 'no tab click on the wrong panel');
  } finally { Date.now = realNow; }
});

test('(dry #4) waitState reads log.jsonl ROWS: a ~0.7 s surfacing that went back to delivered is seen (1 s ledger sampling missed it)', async () => {
  const rows = [
    { kind: 'mail', stage: 'delivered', agentId: 'lb-claude', id: 'm1' },
    { kind: 'mail-surface-unconfirmed', stage: 'redelivered', agentId: 'lb-claude', ids: ['m1'], epoch: 'e1' },
    { kind: 'mail-hook-late', agentId: 'lb-claude', ids: ['m2'] },
    { kind: 'mail', stage: 'surfaced', agentId: 'lb-claude', ids: ['m3'] },
    { kind: 'mail', stage: 'acted', agentId: 'lb-claude', ids: ['m3'] },
    { kind: 'mail', stage: 'redelivered', agentId: 'lb-claude', ids: ['m4'], reason: 'restart' },
    { kind: 'mail', stage: 'acted', agentId: 'lb-codex', ids: ['m1'] }
  ];
  const st = (id) => [...lb.logReachedStates(rows, 'lb-claude', id)].sort();
  assert.deepEqual(st('m1'), ['delivered', 'surfacing'], 'the unconfirmed back-edge proves it was surfacing; another agent\'s row does not count');
  assert.deepEqual(st('m2'), ['surfacing']);
  assert.deepEqual(st('m3'), ['acted', 'surfaced', 'surfacing']);
  assert.deepEqual(st('m4'), [], 'a restart back-edge (no epoch) is not a surfacing');
  // The tail reads only NEW bytes, keeps a torn last line for later, and survives a rotation.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-tail-'));
  try {
    const file = path.join(dir, 'log.jsonl');
    fs.writeFileSync(file, JSON.stringify(rows[0]) + '\n' + '{"kind":"mail-surface-unconf');
    const tail = new lb.HiveLogTail(dir);
    assert.equal(tail.read().length, 1);
    fs.appendFileSync(file, 'irmed","stage":"redelivered","agentId":"lb-claude","ids":["m1"],"epoch":"e1"}\n');
    assert.deepEqual([...lb.logReachedStates(tail.read(), 'lb-claude', 'm1')].sort(), ['delivered', 'surfacing']);
    fs.renameSync(file, path.join(dir, 'log.1.jsonl'));
    fs.writeFileSync(file, JSON.stringify(rows[4]) + '\n');
    assert.deepEqual([...lb.logReachedStates(tail.read(), 'lb-claude', 'm1')].sort(), ['delivered', 'surfacing'], 'the rotated rows are kept');
    assert.ok(lb.logReachedStates(tail.read(), 'lb-claude', 'm3').has('acted'));
    // waitState itself: resolves from the rows while the LEDGER already says delivered again.
    const fake = { s: { hive: dir }, entry: () => ({ state: 'delivered' }), waitFor: lb.LayerB.prototype.waitFor, aborted: () => false, abort: { signal: { throwIfAborted() {} } } };
    fs.appendFileSync(file, JSON.stringify({ kind: 'mail-surface-late', stage: 'redelivered', agentId: 'lb-claude', ids: ['b2'], epoch: 'e9' }) + '\n');
    const got = await lb.LayerB.prototype.waitState.call(fake, 'lb-claude', 'b2', ['surfacing', 'surfaced', 'acted'], 5_000);
    assert.deepEqual([got.state, got.via, got.actedAt], ['surfacing', 'log', null]);
    assert.deepEqual(got.entry, { state: 'delivered' }, 'the ledger entry rides along on the log path too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ws = method('async waitState(agentId, id, states, budgetMs)');
  assert.match(ws, /logReachedAt\(this\.logTail\.read\(\), agentId, id\)/);
});

test('Jim MEDIUM (6a5b855b audit): waitState\'s LOG path carries actedAt from the acted ROW\'s ts (and the entry); B7 never bounds by Date.now()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-acted-'));
  try {
    fs.writeFileSync(path.join(dir, 'log.jsonl'), [
      { ts: 1000, kind: 'mail', stage: 'delivered', agentId: 'lb-codex', id: 'b7' },
      { ts: 2000, kind: 'mail', stage: 'surfaced', agentId: 'lb-codex', ids: ['b7'] },
      { ts: 3000, kind: 'mail', stage: 'acted', agentId: 'lb-codex', ids: ['b7'] }
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const ledger = { state: 'acted', actedAt: 2999, updatedAt: 3001 };
    const mk = (entry) => ({ s: { hive: dir }, entry: () => entry, waitFor: lb.LayerB.prototype.waitFor, abort: { signal: { throwIfAborted() {} } } });
    const got = await lb.LayerB.prototype.waitState.call(mk(ledger), 'lb-codex', 'b7', ['acted'], 5_000);
    assert.equal(got.via, 'log');
    assert.equal(got.actedAt, 3000, 'the acted ROW is the authority');
    assert.equal(got.at, 3000);
    assert.equal(got.entry, ledger, 'the ledger entry rides along');
    assert.equal(lb.b7EpochEnd(got), 3000);
    // No acted row yet, the ledger says acted: its actedAt.
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-acted2-'));
    try {
      fs.writeFileSync(path.join(d2, 'log.jsonl'), '');
      const g2 = await lb.LayerB.prototype.waitState.call({ ...mk(ledger), s: { hive: d2 } }, 'lb-codex', 'b7', ['acted'], 5_000);
      assert.deepEqual([g2.via, g2.actedAt], ['ledger', 2999]);
    } finally { fs.rmSync(d2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Neither available: null, never a clock reading.
  assert.equal(lb.b7EpochEnd(null), null);
  assert.equal(lb.b7EpochEnd({ state: 'acted', via: 'log', actedAt: null }), null);
  const b7 = src.slice(src.indexOf('  async factB7() {'), src.indexOf('\n  }\n', src.indexOf('  async factB7() {')));
  assert.match(b7, /const end = b7EpochEnd\(acted\);/);
  assert.match(b7, /const compactAt = end === null \? \[\] :/);
  assert.ok(!/Date\.now\(\)/.test(b7.slice(b7.indexOf('const end = '), b7.indexOf('const midEpoch'))), 'no Date.now() in the bound');
});
