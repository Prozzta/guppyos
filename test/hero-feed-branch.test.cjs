'use strict';
require('./tools/own-job.cjs');

/**
 * HERO-FEED-BRANCH (card from 1.1.83, still live on 1.1.101).
 *
 * The Settings hero card fetched docs/hero.json from `main` of the human's
 * repository, and the "full changelog" link opened blob/main/CHANGELOG.md.
 * Releases are cut from release-x.y.z branches; `main` is an unmaintained
 * upstream-era branch (last touched 2026-08), so the card showed stale copy
 * and whoever wrote main controlled an in-app link. A new hard-coded name
 * would be wrong again the next time the line moved, so the fix resolves the
 * live line at RUNTIME: the latest release's tag, else the default branch,
 * both from the GitHub API, cached beside the payload and handed to the
 * renderer so the changelog link opens the same line. Offline it fails safe:
 * cache, then compiled-in defaults, never a guessed branch.
 *
 * Round 2 (Creed's audit): the ref check refuses every character that could
 * bend a URL path (percent escapes, backslashes, '#', ':', '@', '//', non-ASCII,
 * zero-width); a failed refresh is remembered (negative cache) so a refusing
 * API costs no more calls until RETRY_AFTER_MS; and getText, the one https
 * seam, follows at most MAX_REDIRECTS hops and stays https on every one.
 *
 * Network is stubbed at that seam (fetchText.getText) for the feed tests, and
 * at node:https.request for the seam's own tests, so this runs offline and
 * every URL asked for is on record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const BS = String.fromCharCode(92);

// The seam: hero.ts (and every mutant of it, loaded beside the real file)
// imports './fetchText', which resolves to this same cached module.
const fetchText = loadTs('src/main/fetchText.ts');
const realGetText = fetchText.getText;
let requests = [];
let routes = {};
fetchText.getText = async (url) => {
  requests.push(url);
  const hit = routes[url];
  if (hit === undefined) throw new Error(`HTTP 404 (${url})`);
  return hit;
};

const updateState = loadTs('src/shared/updateState.ts');
const { REPO, changelogUrl, isGitRef } = updateState;
const { DEFAULT_HERO } = loadTs('src/shared/heroPayload.ts');
const realHero = loadTs('src/main/hero.ts');

const API = `https://api.github.com/repos/${REPO}`;
const RAW_HOST = 'https://raw.githubusercontent.com/';
const rawUrl = (ref) => `${RAW_HOST}${REPO}/${ref}/docs/hero.json`;
const LIVE_HERO = { plan: { label: 'Live', blurb: 'Copy from the live line.' }, sponsor: null, notice: null };
const HOUR = 60 * 60 * 1000;

const tmpDirs = [];
function cachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-feed-branch-'));
  tmpDirs.push(dir);
  return path.join(dir, 'hero.json');
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** GitHub as it is today: a latest release and a default branch, and
 *  docs/hero.json present on whichever of them the feed should read. */
function github({ tag = 'v1.1.101', branch = 'release-1.1.101', heroOn } = {}) {
  routes = {};
  requests = [];
  if (tag !== null) routes[`${API}/releases/latest`] = JSON.stringify({ tag_name: tag });
  if (branch !== null) routes[API] = JSON.stringify({ default_branch: branch });
  routes[rawUrl(heroOn ?? (typeof tag === 'string' && isGitRef(tag) ? tag : branch))] = JSON.stringify(LIVE_HERO);
}
const offline = () => { routes = {}; requests = []; };
const rawRequests = () => requests.filter((u) => u.startsWith(RAW_HOST));
const noMain = () => assert.ok(!requests.some((u) => /\/main\//.test(u)), `NEVER fetches main: ${requests.join(' ')}`);

// ── the behaviours, written against a module so the census can run them on mutants ──
const SCENARIOS = {
  async latestTag(h) {
    github();
    const cp = cachePath();
    const r = await h.loadHero(cp);
    assert.equal(r.ref, 'v1.1.101', 'THE REF IS THE LATEST RELEASE TAG');
    assert.equal(r.hero.plan.label, 'Live');
    assert.equal(r.stale, false);
    assert.deepEqual(rawRequests(), [rawUrl('v1.1.101')], 'hero.json IS READ FROM THE TAG');
    noMain();
    assert.equal(JSON.parse(fs.readFileSync(cp, 'utf8')).ref, 'v1.1.101', 'THE REF IS CACHED BESIDE THE PAYLOAD');
  },
  async defaultBranch(h) {
    github({ tag: null });
    const r = await h.loadHero(cachePath());
    assert.equal(r.ref, 'release-1.1.101', 'WITHOUT A RELEASE THE REF IS THE DEFAULT BRANCH');
    assert.deepEqual(rawRequests(), [rawUrl('release-1.1.101')]);
    noMain();
  },
  async badTag(h) {
    for (const tag of ['v1 ../../evil', 42, '', 'a/../b', 'a%2fevil', `a${BS}evil`, 'x'.repeat(101)]) {
      github({ tag });
      const r = await h.loadHero(cachePath());
      assert.equal(r.ref, 'release-1.1.101', `AN UNUSABLE tag_name (${JSON.stringify(tag)}) FALLS TO THE DEFAULT BRANCH`);
      assert.ok(!requests.some((u) => /evil|\.\./.test(u)), 'THE BAD TAG NEVER REACHES A URL');
      noMain();
    }
  },
  async offlineNoCache(h) {
    offline();
    const r = await h.loadHero(cachePath());
    assert.deepEqual(r.hero, DEFAULT_HERO, 'OFFLINE WITH NO CACHE RENDERS THE DEFAULTS');
    assert.equal(r.stale, true);
    assert.equal(r.ref, null, 'OFFLINE THERE IS NO REF');
    assert.deepEqual(rawRequests(), [], 'OFFLINE NEVER GUESSES A BRANCH TO FETCH');
  },
  async offlineCached(h) {
    offline();
    const cp = cachePath();
    const hero = { ...LIVE_HERO, plan: { label: 'Cached', blurb: 'From last time.' } };
    fs.writeFileSync(cp, JSON.stringify({ hero, fetchedAt: Date.now() - 7 * HOUR, ref: 'v1.1.100' }));
    const r = await h.loadHero(cp);
    assert.equal(r.hero.plan.label, 'Cached', 'OFFLINE SERVES THE EXPIRED CACHE');
    assert.equal(r.stale, true);
    assert.equal(r.ref, 'v1.1.100', 'THE CACHED REF COMES BACK WITH THE CACHED PAYLOAD');
    assert.deepEqual(rawRequests(), []);
  },
  async freshCache(h) {
    github();
    const cp = cachePath();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 1000, ref: 'v1.1.101' }));
    const r = await h.loadHero(cp);
    assert.deepEqual(requests, [], 'A FRESH CACHE MAKES NO REQUEST');
    assert.equal(r.ref, 'v1.1.101', 'A FRESH CACHE STILL CARRIES ITS REF');
    assert.equal(r.stale, false);
  },
  async legacyCache(h) {
    // A 1.1.101 cache has no ref; a damaged one has an unusable ref. Neither
    // may throw or leak into a URL: the link falls back to the releases page.
    for (const extra of [{}, { ref: '../evil' }, { ref: 7 }]) {
      github();
      const cp = cachePath();
      fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 1000, ...extra }));
      const r = await h.loadHero(cp);
      assert.equal(r.ref, null, `A CACHE WITHOUT A USABLE REF (${JSON.stringify(extra)}) REPORTS NONE`);
      assert.equal(r.hero.plan.label, 'Live');
    }
  },
  // L1: a refusing API is asked once per RETRY_AFTER_MS, not twice per mount.
  async negativeCacheNoCache(h) {
    offline();
    const cp = cachePath();
    await h.loadHero(cp);
    const r = await h.loadHero(cp);
    assert.equal(requests.length, 2, 'A FAILED REFRESH IS NOT RETRIED WITHIN THE BACKOFF (two mounts = 2 requests, not 4)');
    assert.deepEqual(r.hero, DEFAULT_HERO);
    assert.equal(r.stale, true);
    assert.equal(r.ref, null);
  },
  async negativeCacheStale(h) {
    offline();
    const cp = cachePath();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 7 * HOUR, ref: 'v1.1.100' }));
    await h.loadHero(cp);
    const r = await h.loadHero(cp);
    assert.equal(requests.length, 2, 'A FAILED REFRESH OVER A STALE CACHE IS NOT RETRIED WITHIN THE BACKOFF');
    assert.equal(r.hero.plan.label, 'Live', 'the stale cache is still served');
    assert.equal(r.ref, 'v1.1.100');
    assert.equal(r.stale, true);
    const onDisk = JSON.parse(fs.readFileSync(cp, 'utf8'));
    assert.equal(onDisk.hero.plan.label, 'Live', 'the failure note keeps the cached payload');
    assert.ok(Date.now() - onDisk.lastAttempt < 5000, 'THE FAILURE IS RECORDED AS lastAttempt');
  },
  async negativeCacheExpires(h) {
    offline();
    const cp = cachePath();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 7 * HOUR, lastAttempt: Date.now() - h.RETRY_AFTER_MS - 1000 }));
    await h.loadHero(cp);
    assert.equal(requests.length, 2, 'THE BACKOFF EXPIRES: an old lastAttempt lets the refresh run again');
    // ...and comes back online: the next successful refresh clears the note.
    github();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 7 * HOUR, lastAttempt: Date.now() - h.RETRY_AFTER_MS - 1000 }));
    const r = await h.loadHero(cp);
    assert.equal(r.stale, false);
    assert.equal(JSON.parse(fs.readFileSync(cp, 'utf8')).lastAttempt, undefined, 'A SUCCESSFUL REFRESH DROPS lastAttempt');
  },
  async negativeCacheForce(h) {
    offline();
    const cp = cachePath();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 7 * HOUR, lastAttempt: Date.now() - 1000 }));
    await h.loadHero(cp, { force: true });
    assert.equal(requests.length, 2, 'A FORCED REFRESH IS THE USER ASKING AND GOES THROUGH THE BACKOFF');
  },
  // Round 3, Andy M1: a time in the future (a clock set back, an edited file) is expired, not fresh.
  async futureFetchedAt(h) {
    github();
    const cp = cachePath();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() + 2 * HOUR, ref: 'v1.1.100' }));
    const r = await h.loadHero(cp);
    assert.deepEqual(rawRequests(), [rawUrl('v1.1.101')], 'A FUTURE fetchedAt IS EXPIRED, NOT FRESH');
    assert.equal(r.ref, 'v1.1.101');
    assert.equal(r.stale, false);
  },
  async futureLastAttempt(h) {
    offline();
    const cp = cachePath();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 7 * HOUR, lastAttempt: Date.now() + 2 * HOUR }));
    await h.loadHero(cp);
    assert.equal(requests.length, 2, 'A FUTURE lastAttempt DOES NOT BACK OFF');
    offline();
    fs.writeFileSync(cp, JSON.stringify({ hero: LIVE_HERO, fetchedAt: Date.now() - 7 * HOUR, lastAttempt: String(Date.now() - 1000) }));
    await h.loadHero(cp);
    assert.equal(requests.length, 2, 'A lastAttempt THAT IS NOT A NUMBER DOES NOT BACK OFF');
  },
  // Round 3, Andy N1: the cache file is untrusted input. A wrong shape is no cache: the defaults,
  // and the refresh is allowed (offline here, so it is asked once and fails).
  async wrongShapeCache(h) {
    for (const shape of [{}, 5, [], 'x', null, { fetchedAt: 0 }, { hero: null, fetchedAt: Date.now() }, { hero: 5, fetchedAt: Date.now() }, { hero: [], fetchedAt: Date.now() },
      { hero: LIVE_HERO, fetchedAt: 'x' }, { hero: LIVE_HERO }]) {
      offline();
      const cp = cachePath();
      fs.writeFileSync(cp, JSON.stringify(shape));
      const r = await h.loadHero(cp);
      assert.equal(requests.length, 2, `A WRONG-SHAPE CACHE (${JSON.stringify(shape)}) DOES NOT BLOCK THE REFRESH`);
      assert.deepEqual(r.hero, DEFAULT_HERO, `A WRONG-SHAPE CACHE (${JSON.stringify(shape)}) IS NO CACHE: THE DEFAULTS`);
      assert.equal(r.ref, null);
      assert.equal(r.stale, true);
    }
  },
  async cachedHeroRevalidated(h) {
    github();
    const cp = cachePath();
    const dirty = { plan: { label: 7, blurb: 'Kept.' }, sponsor: { name: 'S', url: 'http://plain.example/' }, notice: 9 };
    fs.writeFileSync(cp, JSON.stringify({ hero: dirty, fetchedAt: Date.now() - 1000, ref: 'v1.1.101' }));
    const r = await h.loadHero(cp);
    assert.deepEqual(requests, [], 'a fresh cache, still no request');
    assert.deepEqual(r.hero, { plan: { label: DEFAULT_HERO.plan.label, blurb: 'Kept.' }, sponsor: null, notice: null }, 'THE CACHED HERO IS RE-VALIDATED ON READ');
  }
};

for (const [name, run] of Object.entries(SCENARIOS)) {
  test(`hero feed: ${name}`, () => run(realHero));
}

test('the changelog link follows the resolved ref and never names a branch', () => {
  assert.equal(changelogUrl('v1.1.101'), `https://github.com/${REPO}/blob/v1.1.101/CHANGELOG.md`);
  assert.equal(changelogUrl('release-1.1.101'), `https://github.com/${REPO}/blob/release-1.1.101/CHANGELOG.md`);
  for (const none of [null, undefined, '', 'a b', '../x']) {
    assert.equal(changelogUrl(none), `https://github.com/${REPO}/releases`, `no ref (${JSON.stringify(none)}) -> the releases page`);
  }
});

// M1: every value that could bend a URL path. Written against a module so the
// census can run the table on a widened isGitRef.
const REF_OK = ['v1.1.101', 'release-1.1.101', 'feat/x', 'a.b-c_d', 'a', 'v1.1.101-rc.1'];
const REF_BAD = [
  '', 'a b', '..', 'a/../b', 'x.lock', 'a?b', '/x', 'x/', '-x', '.x', 'x'.repeat(101),
  'a%2eb', 'a%2fb', `a${BS}b`, `a${BS}..${BS}b`, 'a#b', 'a:b', 'a@b', 'a//b',
  '\uFF21b', '\u00E9', 'v1\u200B', 'a/.b', 'v1..2', 'a.', 'a./b', 'a\u0000b', 'a\nb',
  'https://evil.example/x', 7, null, undefined, {}, ['v1.1.101']
];
function refTable(mod) {
  for (const ok of REF_OK) assert.equal(mod.isGitRef(ok), true, `isGitRef accepts ${ok}`);
  for (const bad of REF_BAD) {
    assert.equal(mod.isGitRef(bad), false, `isGitRef MUST REFUSE ${JSON.stringify(bad)}`);
    if (typeof bad === 'string') {
      // Belt and braces: even if accepted, nothing here escapes the repo path.
      assert.equal(mod.changelogUrl(bad), `https://github.com/${REPO}/releases`);
    }
  }
}
test('isGitRef admits tags and branches and refuses what cannot go in a URL path', () => refTable(updateState));

// L2: the https seam itself, driven through a fake node:https.request.
function fakeHttps(plan) {
  const real = https.request;
  const seen = [];
  https.request = (url, _opts, cb) => {
    seen.push(url);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = (err) => { if (err) req.emit('error', err); };
    req.end = () => {
      const p = plan(url);
      const res = new EventEmitter();
      res.statusCode = p.status;
      res.headers = p.headers ?? {};
      res.resume = () => {};
      res.setEncoding = () => {};
      process.nextTick(() => {
        cb(res);
        if (p.body !== undefined) res.emit('data', p.body);
        res.emit('end');
      });
    };
    return req;
  };
  return { seen, restore: () => { https.request = real; } };
}
const redirectTo = (location) => ({ status: 302, headers: { location } });
const page = (body) => ({ status: 200, body });

const HTTPS_SCENARIOS = {
  async followsAFewHops(getText) {
    const net = fakeHttps((url) => url.endsWith('/1') ? redirectTo('https://a.example/2')
      : url.endsWith('/2') ? redirectTo('/3') : page('hello'));
    try {
      assert.equal(await getText('https://a.example/1'), 'hello');
      assert.deepEqual(net.seen, ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'], 'a relative Location resolves against the hop that sent it');
    } finally { net.restore(); }
  },
  async stopsAtTheHopLimit(getText) {
    let n = 0;
    // Bounded, so a mutant with no hop limit lands on a page instead of hanging.
    const net = fakeHttps(() => n < 50 ? redirectTo(`https://a.example/${++n}`) : page('end'));
    try {
      await assert.rejects(getText('https://a.example/0'), /too many redirects/, 'A REDIRECT LOOP FAILS AT THE HOP LIMIT');
      assert.equal(net.seen.length, 6, 'the first request plus MAX_REDIRECTS hops, no more');
    } finally { net.restore(); }
  },
  async staysHttpsOnEveryHop(getText) {
    let n = 0;
    const net = fakeHttps(() => n++ < 50 ? redirectTo('http://a.example/plain') : page('end'));
    try {
      await assert.rejects(getText('https://a.example/1'), /https only/, 'A REDIRECT TO http IS REFUSED');
      assert.deepEqual(net.seen, ['https://a.example/1'], 'the http hop is never requested');
      await assert.rejects(getText('http://a.example/1'), /https only/, 'a plain-http URL is refused before any request');
      assert.deepEqual(net.seen, ['https://a.example/1']);
    } finally { net.restore(); }
  },
  // Round 3, Andy L1: the downgrade sits on a LATER hop (https -> https -> http).
  async refusesADowngradeOnALaterHop(getText) {
    const net = fakeHttps((url) => url.endsWith('/1') ? redirectTo('https://a.example/2')
      : url.endsWith('/2') ? redirectTo('http://a.example/3') : page('plain'));
    try {
      await assert.rejects(getText('https://a.example/1'), /https only/, 'A DOWNGRADE ON A LATER HOP IS REFUSED');
      assert.deepEqual(net.seen, ['https://a.example/1', 'https://a.example/2'], 'the http hop is never requested');
    } finally { net.restore(); }
  },
  // Round 3, Andy L2: a relative Location resolves against the hop that sent it, after a move
  // to another host and a deeper path, not against the first URL.
  async relativeAfterAHostMove(getText) {
    const net = fakeHttps((url) => url === 'https://a.example/1' ? redirectTo('https://b.example/deep/x')
      : url === 'https://b.example/deep/x' ? redirectTo('y') : url === 'https://b.example/deep/y' ? redirectTo('../z') : page('moved'));
    try {
      assert.equal(await getText('https://a.example/1'), 'moved');
      assert.deepEqual(net.seen, ['https://a.example/1', 'https://b.example/deep/x', 'https://b.example/deep/y', 'https://b.example/z'],
        'A RELATIVE Location RESOLVES AGAINST THE HOP THAT SENT IT');
    } finally { net.restore(); }
  }
};
for (const [name, run] of Object.entries(HTTPS_SCENARIOS)) {
  test(`getText: ${name}`, () => run(realGetText));
}

test('no shipped file hard-codes the main branch for the hero feed or the changelog', () => {
  const hero = readSource('src/main/hero.ts');
  assert.ok(!/\/main\//.test(hero) && !/['"`]main['"`]/.test(hero), 'hero.ts names no branch');
  const rawRefs = hero.match(/raw\.githubusercontent\.com\/[^`'"]*/g) ?? [];
  assert.deepEqual(rawRefs, ['raw.githubusercontent.com/${REPO}/${ref}/docs/hero.json'], 'the ONE raw URL is built from the resolved ref');
  assert.match(hero, /releases\/latest/, 'the latest release is consulted');
  assert.match(hero, /default_branch/, 'then the default branch');

  const card = readSource('src/renderer/src/components/SettingsHeroCard.tsx');
  assert.ok(!/blob\/main/.test(card), 'the card no longer links blob/main');
  assert.equal((card.match(/changelogUrl\(heroRef\)/g) ?? []).length, 2, 'href and onClick both use the resolved ref');
  assert.match(card, /setHeroRef\(r\.ref \?\? null\)/, 'the ref arrives with the payload');

  const pre = readSource('src/preload/index.ts');
  assert.match(pre, /heroPayload: \(force\?: boolean\): Promise<\{ hero: HeroPayload; fetchedAt: number; stale: boolean; ref: string \| null \}>/);
  assert.match(readSource('src/main/index.ts'), /ipcMain\.handle\('hero:payload'[\s\S]{0,120}loadHero\(/);
});

// ── mutation census: each edit to a real file must die on a named assertion ──
const REF_CLASS = '[A-Za-z0-9._-]*';
const HERO_MUTANTS = [
  { name: 'M1 the ref is main again', dies: /THE REF IS THE LATEST RELEASE TAG/,
    edits: [['const ref = await resolveLiveRef();', "const ref = 'main';"]] },
  { name: 'M2 only the default branch is consulted', dies: /THE REF IS THE LATEST RELEASE TAG/,
    edits: [["return await pick(LATEST_RELEASE_URL, 'tag_name');", "return await pick(REPO_API_URL, 'default_branch');"]] },
  { name: 'M3 the tag is interpolated unvalidated', dies: /FALLS TO THE DEFAULT BRANCH|NEVER REACHES A URL/,
    edits: [['if (!isGitRef(value)) throw', "if (typeof value !== 'string') throw"]] },
  { name: 'M4 offline guesses main', dies: /OFFLINE NEVER GUESSES A BRANCH TO FETCH/,
    edits: [['  } catch {\n    // Remember', "  } catch {\n    void getText(heroUrlFor('main'), { timeoutMs: FETCH_TIMEOUT_MS }).catch(() => undefined);\n    // Remember"]] },
  { name: 'M5 the ref is not cached', dies: /THE REF IS CACHED BESIDE THE PAYLOAD/,
    edits: [['const payload: HeroCache = { hero, fetchedAt: Date.now(), ref };', 'const payload: HeroCache = { hero, fetchedAt: Date.now() };']] },
  { name: 'M6 a stale answer drops its ref', dies: /THE CACHED REF COMES BACK WITH THE CACHED PAYLOAD/,
    edits: [['    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true, ref: cachedRef };\n    return { hero: DEFAULT_HERO',
             '    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true, ref: null };\n    return { hero: DEFAULT_HERO']] },
  { name: 'M7 a fresh cache drops its ref', dies: /A FRESH CACHE STILL CARRIES ITS REF/,
    edits: [['stale: false, ref: cachedRef };', 'stale: false, ref: null };']] },
  { name: 'M8 the cached ref is trusted', dies: /REPORTS NONE/,
    edits: [['cached && isGitRef(cached.ref) ? cached.ref : null', "cached && typeof cached.ref === 'string' ? cached.ref : null"]] },
  { name: 'M9 no negative cache', dies: /NOT RETRIED WITHIN THE BACKOFF/,
    edits: [['const backingOff = cached && within(cached.lastAttempt, RETRY_AFTER_MS);', 'const backingOff = false;']] },
  { name: 'M10 the failure is not recorded', dies: /NOT RETRIED WITHIN THE BACKOFF|RECORDED AS lastAttempt/,
    edits: [['const failed: HeroCache = { ...(cached ?? { hero: DEFAULT_HERO, fetchedAt: 0 }), lastAttempt: Date.now() };', 'const failed: HeroCache = { ...(cached ?? { hero: DEFAULT_HERO, fetchedAt: 0 }) };']] },
  { name: 'M11 the backoff never expires', dies: /THE BACKOFF EXPIRES/,
    edits: [['within(cached.lastAttempt, RETRY_AFTER_MS)', 'within(cached.lastAttempt, Infinity)']] },
  { name: 'M12 a forced refresh is backed off too', dies: /A FORCED REFRESH IS THE USER ASKING/,
    edits: [['if (cached && !opts.force && backingOff) {', 'if (cached && backingOff) {']] },
  // Round 3 (Andy M1, N1)
  { name: 'M13 a future fetchedAt is fresh', dies: /A FUTURE fetchedAt IS EXPIRED/,
    edits: [['within(cached.fetchedAt, TTL_MS)', 'now - cached.fetchedAt < TTL_MS']] },
  { name: 'M14 a future lastAttempt backs off', dies: /A FUTURE lastAttempt DOES NOT BACK OFF/,
    edits: [['within(cached.lastAttempt, RETRY_AFTER_MS)', "typeof cached.lastAttempt === 'number' && now - cached.lastAttempt < RETRY_AFTER_MS"]] },
  { name: 'M15 no future guard at all', dies: /A FUTURE fetchedAt IS EXPIRED|A FUTURE lastAttempt DOES NOT BACK OFF/,
    edits: [["typeof ts === 'number' && now - ts >= 0 && now - ts < ms", "typeof ts === 'number' && now - ts < ms"]] },
  { name: 'M16 a non-number lastAttempt backs off', dies: /A lastAttempt THAT IS NOT A NUMBER DOES NOT BACK OFF/,
    edits: [["typeof ts === 'number' && now - ts >= 0", '(ts as number) !== undefined && now - (ts as number) >= 0']] },
  { name: 'M17 the cache shape is not checked', dies: /A WRONG-SHAPE CACHE/,
    edits: [["cached = readCache(JSON.parse(readFileSync(cachePath, 'utf8')));", "cached = JSON.parse(readFileSync(cachePath, 'utf8'));"]] },
  { name: 'M18 the cached hero is not re-validated', dies: /THE CACHED HERO IS RE-VALIDATED ON READ/,
    edits: [['return { ...(c as unknown as HeroCache), hero: parseHeroPayload(c.hero) };', 'return c as unknown as HeroCache;']] },
  { name: 'M19 a null hero passes', dies: /A WRONG-SHAPE CACHE \(\{"hero":null/,
    edits: [['if (!c?.hero || typeof c.hero', 'if (c?.hero === undefined || typeof c.hero']] },
  { name: 'M20 an array hero passes', dies: /A WRONG-SHAPE CACHE \(\{"hero":\[\]/,
    edits: [[' || Array.isArray(c.hero)) return null;', ') return null;']] },
  { name: 'M21 a non-number fetchedAt passes', dies: /A WRONG-SHAPE CACHE \(\{"hero":\{.*"fetchedAt":"x"\}\)/,
    edits: [["if (typeof c.fetchedAt !== 'number') return null;", '']] }
];
const REF_MUTANTS = [
  { name: "J3 '%' allowed", dies: /MUST REFUSE "a%2/,
    edits: [[REF_CLASS, '[A-Za-z0-9._%-]*']], count: 2 },
  { name: 'J4 backslash allowed', dies: /MUST REFUSE "a\\\\/,
    edits: [[REF_CLASS, `[A-Za-z0-9._${BS}${BS}-]*`]], count: 2 },
  { name: "J5 '..' allowed", dies: /MUST REFUSE "v1\.\.2"/,
    edits: [["    && !value.includes('..')\n", '']] },
  { name: 'J6 a trailing dot allowed', dies: /MUST REFUSE "a\."/,
    edits: [["seg.endsWith('.') || seg.endsWith('.lock')", "seg.endsWith('.lock')"]] },
  { name: 'J7 non-ASCII allowed', dies: /MUST REFUSE "Ａb"/,
    edits: [['/^[A-Za-z0-9][A-Za-z0-9._-]*(\\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/', '/^[\\p{L}0-9][\\p{L}0-9._-]*(\\/[\\p{L}0-9][\\p{L}0-9._-]*)*$/u']] }
];
const HTTPS_MUTANTS = [
  { name: 'F1 no hop limit', dies: /A REDIRECT LOOP FAILS AT THE HOP LIMIT/,
    edits: [['if (hop >= MAX_REDIRECTS) {', 'if (false) {']] },
  { name: 'F2 http allowed on a hop', dies: /A REDIRECT TO http IS REFUSED/,
    edits: [["if (!/^https:\\/\\//i.test(url)) return Promise.reject(new Error('https only'));", "if (hop === 0 && !/^https:\\/\\//i.test(url)) return Promise.reject(new Error('https only'));"]] },
  // Round 3: Andy's A1 and A3.
  { name: 'A1 https checked on the first two hops only', dies: /A DOWNGRADE ON A LATER HOP IS REFUSED/,
    edits: [["if (!/^https:\\/\\//i.test(url)) return Promise.reject(new Error('https only'));", "if (hop <= 1 && !/^https:\\/\\//i.test(url)) return Promise.reject(new Error('https only'));"]] },
  { name: 'A3 a relative Location resolves against a fixed base', dies: /A RELATIVE Location RESOLVES AGAINST THE HOP THAT SENT IT/,
    edits: [['new URL(res.headers.location, url)', 'new URL(res.headers.location, "https://a.example/")']] }
];

function mutate(src, edits, count = 1) {
  let out = src;
  for (const [from, to] of edits) {
    assert.equal(out.split(from).length - 1, count, `mutant anchor must occur exactly ${count}x: ${from}`);
    out = out.split(from).join(to);
  }
  return out;
}

async function census(file, mutants, runAll) {
  const src = readSource(file);
  for (const m of mutants) {
    const mod = loadTs.fromText(file, mutate(src, m.edits, m.count));
    let death = null;
    try { await runAll(mod); } catch (e) { death = e; }
    assert.ok(death, `${m.name} must die`);
    assert.match(String(death.message), m.dies, `${m.name} died elsewhere: ${death.message}`);
  }
}

test('mutation census: every mutant dies, the real files survive', async () => {
  for (const run of Object.values(SCENARIOS)) await run(realHero);
  refTable(updateState);
  for (const run of Object.values(HTTPS_SCENARIOS)) await run(realGetText);
  assert.equal(HERO_MUTANTS.length + REF_MUTANTS.length + HTTPS_MUTANTS.length, 30, '21 hero.ts + 5 isGitRef + 4 getText');

  await census('src/main/hero.ts', HERO_MUTANTS, async (mod) => { for (const run of Object.values(SCENARIOS)) await run(mod); });
  await census('src/shared/updateState.ts', REF_MUTANTS, (mod) => refTable(mod));
  await census('src/main/fetchText.ts', HTTPS_MUTANTS, async (mod) => { for (const run of Object.values(HTTPS_SCENARIOS)) await run(mod.getText); });
});
