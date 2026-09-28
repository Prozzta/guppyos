'use strict';
/**
 * Knowledge Graph core + agent-CLI tests. Self-contained, no test framework —
 * run with `node test/kg-core.test.cjs` (mirrors test/slack.test.cjs).
 * Exercises: tokenize/chunk/score, the ingest→store→search round-trip for the
 * two v1 modalities (text + image), list/get/remove, and the real `kg.cjs` CLI
 * an agent invokes (proving the out-of-process retrieval path end to end).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const kg = require('../src/main/kg-core.cjs');
const CLI = path.join(__dirname, '..', 'resources', 'kg.cjs');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
}
function writeFixture(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

(async () => {
  console.log('knowledge-graph core tests');

  // ─── tokenize ───────────────────────────────────────────────────────────
  await test('tokenize lowercases, splits on non-alphanumerics, drops stop-words and 1-char tokens', async () => {
    const toks = kg.tokenize('The Refund-Policy is X, valid for 30 days!');
    assert.ok(toks.includes('refund'), 'has refund');
    assert.ok(toks.includes('policy'), 'has policy');
    assert.ok(toks.includes('30'), 'keeps numbers');
    assert.ok(!toks.includes('the'), 'drops stop-word "the"');
    assert.ok(!toks.includes('is'), 'drops stop-word "is"');
    assert.ok(!toks.includes('x'), 'drops 1-char token');
  });

  // ─── detectModality ─────────────────────────────────────────────────────
  await test('detectModality buckets by extension', async () => {
    assert.strictEqual(kg.detectModality('a/b/notes.md'), 'text');
    assert.strictEqual(kg.detectModality('logo.PNG'), 'image');
    assert.strictEqual(kg.detectModality('report.pdf'), 'pdf');
    assert.strictEqual(kg.detectModality('data.csv'), 'sheet');
    assert.strictEqual(kg.detectModality('main.ts'), 'code');
    assert.strictEqual(kg.detectModality('weird.xyz'), 'text'); // unknown → text
  });

  // ─── chunkText ──────────────────────────────────────────────────────────
  await test('chunkText returns one chunk for short text and multiple for long text', async () => {
    assert.deepStrictEqual(kg.chunkText(''), []);
    assert.deepStrictEqual(kg.chunkText('short note'), ['short note']);
    const long = ('paragraph alpha. '.repeat(120) + '\n\n').repeat(6); // ~12k chars
    const chunks = kg.chunkText(long, { size: 1000, overlap: 100 });
    assert.ok(chunks.length > 5, `expected several chunks, got ${chunks.length}`);
    for (const c of chunks) assert.ok(c.length <= 1500, `chunk under cap: ${c.length}`);
  });

  await test('chunkText always terminates and covers the text (deterministic)', async () => {
    const text = 'word '.repeat(5000);
    const a = kg.chunkText(text, { size: 800, overlap: 120 });
    const b = kg.chunkText(text, { size: 800, overlap: 120 });
    assert.deepStrictEqual(a, b, 'deterministic');
    assert.ok(a.join(' ').includes('word'), 'covers content');
  });

  // ─── scoreChunk ─────────────────────────────────────────────────────────
  await test('scoreChunk: 0 when no term matches, higher for title + phrase matches', async () => {
    const terms = kg.tokenize('refund policy');
    const none = kg.scoreChunk({ title: 'Holidays', text: 'office closed friday' }, terms, 'refund policy');
    assert.strictEqual(none, 0);
    const body = kg.scoreChunk({ title: 'Holidays', text: 'our refund policy is generous' }, terms, 'refund policy');
    const titled = kg.scoreChunk({ title: 'Refund Policy', text: 'our refund policy is generous' }, terms, 'refund policy');
    assert.ok(body > 0, 'body match scores');
    assert.ok(titled > body, 'title match boosts above body-only');
  });

  // ─── ingest → search round-trip: TEXT modality ──────────────────────────
  await test('ingest a markdown doc, then search finds it with a snippet', async () => {
    const root = tmpRoot();
    const src = writeFixture(root, 'refund-policy.md',
      '# Refund Policy 2026\n\nCustomers may request a full refund within 30 days of purchase. '
      + 'Refunds for enterprise plans require manager approval.\n');
    const { docId, chunkCount, meta } = await kg.ingest(root, { srcPath: src, tags: ['policy', 'support'] });
    assert.ok(docId, 'returns a docId');
    assert.ok(chunkCount >= 1, 'at least one chunk');
    assert.strictEqual(meta.modality, 'text');
    assert.strictEqual(meta.title, 'Refund Policy 2026', 'title derived from heading');
    // store layout exists
    assert.ok(fs.existsSync(path.join(root, 'index.jsonl')), 'index.jsonl written');
    assert.ok(fs.existsSync(path.join(root, 'docs', docId, 'text.md')), 'text.md written');
    assert.ok(fs.existsSync(path.join(root, 'docs', docId, 'meta.json')), 'meta.json written');
    assert.ok(fs.existsSync(path.join(root, 'docs', docId, 'original.md')), 'original copied');

    const hits = kg.search(root, 'refund within 30 days');
    assert.ok(hits.length >= 1, 'finds the doc');
    assert.strictEqual(hits[0].docId, docId);
    assert.ok(/refund/i.test(hits[0].snippet), 'snippet contains the match');
  });

  // ─── ingest → search round-trip: IMAGE modality (metadata-level) ────────
  await test('ingest an image by metadata (no OCR) and find it by caption/tags', async () => {
    const root = tmpRoot();
    // a tiny fake binary file standing in for an image artifact
    const img = path.join(root, 'org-chart.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { docId, meta } = await kg.ingest(root, {
      srcPath: img, title: 'Company Org Chart',
      caption: 'Engineering reports to the CTO; Sales reports to the CRO.',
      tags: ['orgchart', 'leadership']
    });
    assert.strictEqual(meta.modality, 'image');
    assert.strictEqual(meta.extractor, 'image-meta@1');
    assert.ok(fs.existsSync(path.join(root, 'docs', docId, 'original.png')), 'binary retained for future OCR');

    const byCaption = kg.search(root, 'who does engineering report to');
    assert.ok(byCaption.some((h) => h.docId === docId), 'found via caption text');
    const byTag = kg.search(root, 'orgchart leadership');
    assert.ok(byTag.some((h) => h.docId === docId), 'found via tags');
  });

  // ─── list / getDoc / removeDoc ──────────────────────────────────────────
  await test('list, get, and remove manage the corpus and prune the index', async () => {
    const root = tmpRoot();
    const a = await kg.ingest(root, { text: 'Alpha document about onboarding new hires.', title: 'Onboarding' });
    const b = await kg.ingest(root, { text: 'Beta document about the deployment runbook.', title: 'Runbook' });

    const docs = kg.list(root);
    assert.strictEqual(docs.length, 2, 'two docs listed');

    const got = kg.getDoc(root, a.docId);
    assert.ok(got && /onboarding/i.test(got.text), 'getDoc returns full text');
    assert.strictEqual(kg.getDoc(root, 'nope'), null, 'unknown id → null');

    assert.strictEqual(kg.removeDoc(root, a.docId), true);
    assert.strictEqual(kg.list(root).length, 1, 'one doc after remove');
    assert.strictEqual(kg.search(root, 'onboarding').length, 0, 'removed doc no longer searchable');
    assert.ok(kg.search(root, 'deployment runbook').some((h) => h.docId === b.docId), 'other doc intact');

    const s = kg.stats(root);
    assert.strictEqual(s.docCount, 1);
  });

  await test('search returns [] for empty query or empty store', async () => {
    const root = tmpRoot();
    assert.deepStrictEqual(kg.search(root, 'anything'), [], 'empty store');
    await kg.ingest(root, { text: 'hello world', title: 'Greeting' });
    assert.deepStrictEqual(kg.search(root, '   '), [], 'blank query');
  });

  // ─── the real agent CLI (out-of-process retrieval path) ─────────────────
  console.log('knowledge-graph agent CLI (kg.cjs) tests');

  await test('agent runs `kg search` against KG_ROOT and gets ranked, attributed results', async () => {
    const root = tmpRoot();
    await kg.ingest(root, {
      srcPath: writeFixture(root, 'pto.md',
        '# PTO Policy\n\nFull-time employees accrue 20 days of paid time off per year. '
        + 'Unused PTO rolls over up to 5 days.\n'),
      tags: ['hr', 'pto']
    });
    const res = spawnSync(process.execPath, [CLI, 'search', 'how much paid time off'],
      { encoding: 'utf8', env: { ...process.env, KG_ROOT: root } });
    assert.strictEqual(res.status, 0, `exit 0 (stderr: ${res.stderr})`);
    assert.ok(/PTO Policy/.test(res.stdout), 'CLI surfaces the title');
    assert.ok(/20 days/.test(res.stdout), 'CLI surfaces the matching passage');
    assert.ok(/id:/.test(res.stdout), 'CLI surfaces a doc id for `kg get`');
  });

  await test('agent `kg search --json` is machine-parseable', async () => {
    const root = tmpRoot();
    await kg.ingest(root, { text: 'The wifi password is hunter2 for the guest network.', title: 'Wifi' });
    const res = spawnSync(process.execPath, [CLI, 'search', 'guest wifi password', '--json'],
      { encoding: 'utf8', env: { ...process.env, KG_ROOT: root } });
    assert.strictEqual(res.status, 0, `exit 0 (stderr: ${res.stderr})`);
    const parsed = JSON.parse(res.stdout);
    assert.ok(Array.isArray(parsed) && parsed.length >= 1, 'JSON array of hits');
    assert.strictEqual(parsed[0].title, 'Wifi');
  });

  await test('agent CLI degrades gracefully when KG_ROOT is unset (flag off)', async () => {
    const env = { ...process.env };
    delete env.KG_ROOT;
    const res = spawnSync(process.execPath, [CLI, 'search', 'anything'], { encoding: 'utf8', env });
    assert.strictEqual(res.status, 0, 'exits 0 (non-fatal) when KG is off');
    assert.ok(/not configured|off|unavailable/i.test(res.stderr + res.stdout), 'explains it is off');
  });

  // ─── SYNC-CHILD-CALLS: pdftotext is an ASYNC child (fake execFile) ────────
  await test('pdftotext runs through async execFile: same args, 20 s cap, 32 MB buffer, hidden', async () => {
    const root = tmpRoot();
    const pdf = writeFixture(root, 'handbook.pdf', '%PDF-1.4 fake');
    const calls = [];
    let deliver;
    const execFile = (file, args, opts, cb) => { calls.push({ file, args, opts }); deliver = cb; };
    let settled = false;
    const p = kg.ingest(root, { srcPath: pdf }, { execFile }).then((r) => { settled = true; return r; });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.length, 1, 'one pdftotext per PDF');
    assert.strictEqual(calls[0].file, 'pdftotext');
    assert.deepStrictEqual(calls[0].args, ['-q', pdf, '-']);
    assert.strictEqual(calls[0].opts.timeout, 20000);
    assert.strictEqual(calls[0].opts.maxBuffer, 32 * 1024 * 1024);
    assert.strictEqual(calls[0].opts.windowsHide, true);
    assert.strictEqual(settled, false, 'ingest waits for the child without blocking the caller');
    deliver(null, 'Vacation policy: twenty days of paid leave.');
    const { meta } = await p;
    assert.strictEqual(meta.extractor, 'pdftotext@1');
    assert.strictEqual(kg.search(root, 'vacation policy')[0].docId, meta.id);
  });

  await test('pdftotext failure (absent / timeout / non-zero) falls back to pdf-pending, as before', async () => {
    const root = tmpRoot();
    const pdf = writeFixture(root, 'scan.pdf', '%PDF-1.4 fake');
    for (const err of [Object.assign(new Error('spawn pdftotext ENOENT'), { code: 'ENOENT' }),
      Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }),
      Object.assign(new Error('exit 1'), { code: 1 })]) {
      const { meta } = await kg.ingest(root, { srcPath: pdf, title: 'Scan' }, { execFile: (f, a, o, cb) => cb(err, '') });
      assert.strictEqual(meta.extractor, 'pdf-pending@1');
    }
    const threw = await kg.ingest(root, { srcPath: pdf }, { execFile: () => { throw new Error('EPERM'); } });
    assert.strictEqual(threw.meta.extractor, 'pdf-pending@1', 'a throwing spawn is a miss, not a crash');
    assert.strictEqual(await kg.tryPdfToText(path.join(root, 'missing.pdf'), () => { throw new Error('must not run'); }), null);
  });

  await test('kg-core.cjs has no synchronous child process left', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'kg-core.cjs'), 'utf8');
    assert.ok(!/spawnSync|execSync|execFileSync/.test(src), 'no *Sync child API');
  });

  // ─── summary ────────────────────────────────────────────────────────────
  if (failures > 0) {
    console.log(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll knowledge-graph tests passed');
})();
