'use strict';

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
 * Network is stubbed at the one https seam (fetchText.getText), so this runs
 * offline and every URL the feed asks for is on record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

// The seam: hero.ts (and every mutant of it, loaded beside the real file)
// imports './fetchText', which resolves to this same cached module.
const fetchText = loadTs('src/main/fetchText.ts');
let requests = [];
let routes = {};
fetchText.getText = async (url) => {
  requests.push(url);
  const hit = routes[url];
  if (hit === undefined) throw new Error(`HTTP 404 (${url})`);
  return hit;
};

const { REPO, changelogUrl, isGitRef } = loadTs('src/shared/updateState.ts');
const { DEFAULT_HERO } = loadTs('src/shared/heroPayload.ts');
const realHero = loadTs('src/main/hero.ts');

const API = `https://api.github.com/repos/${REPO}`;
const RAW_HOST = 'https://raw.githubusercontent.com/';
const rawUrl = (ref) => `${RAW_HOST}${REPO}/${ref}/docs/hero.json`;
const LIVE_HERO = { plan: { label: 'Live', blurb: 'Copy from the live line.' }, sponsor: null, notice: null };

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
    for (const tag of ['v1 ../../evil', 42, '', 'a/../b', 'x'.repeat(101)]) {
      github({ tag });
      const r = await h.loadHero(cachePath());
      assert.equal(r.ref, 'release-1.1.101', `AN UNUSABLE tag_name (${JSON.stringify(tag)}) FALLS TO THE DEFAULT BRANCH`);
      assert.ok(!requests.some((u) => /evil|\.\./.test(u)), 'THE BAD TAG NEVER REACHES A URL');
      noMain();
    }
  },
  async offlineNoCache(h) {
    routes = {}; requests = [];
    const r = await h.loadHero(cachePath());
    assert.deepEqual(r.hero, DEFAULT_HERO, 'OFFLINE WITH NO CACHE RENDERS THE DEFAULTS');
    assert.equal(r.stale, true);
    assert.equal(r.ref, null, 'OFFLINE THERE IS NO REF');
    assert.deepEqual(rawRequests(), [], 'OFFLINE NEVER GUESSES A BRANCH TO FETCH');
  },
  async offlineCached(h) {
    routes = {}; requests = [];
    const cp = cachePath();
    const hero = { ...LIVE_HERO, plan: { label: 'Cached', blurb: 'From last time.' } };
    fs.writeFileSync(cp, JSON.stringify({ hero, fetchedAt: Date.now() - 7 * 60 * 60 * 1000, ref: 'v1.1.100' }));
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

test('isGitRef admits tags and branches and refuses what cannot go in a URL path', () => {
  for (const ok of ['v1.1.101', 'release-1.1.101', 'feat/x', 'a.b-c_d']) assert.equal(isGitRef(ok), true, ok);
  for (const bad of ['', 'a b', '..', 'a/../b', 'x.lock', 'a?b', '/x', 'x/', '-x', 'x'.repeat(101), 7, null, undefined, {}]) {
    assert.equal(isGitRef(bad), false, JSON.stringify(bad));
  }
});

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

// ── mutation census: each edit to the real hero.ts must die on a named assertion ──
const MUTANTS = [
  { name: 'M1 the ref is main again', dies: /THE REF IS THE LATEST RELEASE TAG/,
    edits: [['const ref = await resolveLiveRef();', "const ref = 'main';"]] },
  { name: 'M2 only the default branch is consulted', dies: /THE REF IS THE LATEST RELEASE TAG/,
    edits: [["return await pick(LATEST_RELEASE_URL, 'tag_name');", "return await pick(REPO_API_URL, 'default_branch');"]] },
  { name: 'M3 the tag is interpolated unvalidated', dies: /FALLS TO THE DEFAULT BRANCH|NEVER REACHES A URL/,
    edits: [['if (!isGitRef(value)) throw', "if (typeof value !== 'string') throw"]] },
  { name: 'M4 offline guesses main', dies: /OFFLINE NEVER GUESSES A BRANCH TO FETCH/,
    edits: [['  } catch {\n    if (cached) return', "  } catch {\n    void getText(heroUrlFor('main'), { timeoutMs: FETCH_TIMEOUT_MS }).catch(() => undefined);\n    if (cached) return"]] },
  { name: 'M5 the ref is not cached', dies: /THE REF IS CACHED BESIDE THE PAYLOAD/,
    edits: [['const payload: HeroCache = { hero, fetchedAt: Date.now(), ref };', 'const payload: HeroCache = { hero, fetchedAt: Date.now() };']] },
  { name: 'M6 a stale answer drops its ref', dies: /THE CACHED REF COMES BACK WITH THE CACHED PAYLOAD/,
    edits: [['stale: true, ref: cachedRef };', 'stale: true, ref: null };']] },
  { name: 'M7 a fresh cache drops its ref', dies: /A FRESH CACHE STILL CARRIES ITS REF/,
    edits: [['stale: false, ref: cachedRef };', 'stale: false, ref: null };']] },
  { name: 'M8 the cached ref is trusted', dies: /REPORTS NONE/,
    edits: [['cached && isGitRef(cached.ref) ? cached.ref : null', 'cached && typeof cached.ref === \'string\' ? cached.ref : null']] }
];

function mutate(src, edits) {
  let out = src;
  for (const [from, to] of edits) {
    assert.equal(out.split(from).length - 1, 1, `mutant anchor must occur exactly once: ${from}`);
    out = out.replace(from, to);
  }
  return out;
}

test('mutation census: every mutant of hero.ts dies, the real file survives', async () => {
  const src = readSource('src/main/hero.ts');
  for (const run of Object.values(SCENARIOS)) await run(realHero);
  assert.equal(MUTANTS.length, 8);
  for (const m of MUTANTS) {
    const mod = loadTs.fromText('src/main/hero.ts', mutate(src, m.edits));
    let death = null;
    for (const run of Object.values(SCENARIOS)) {
      try { await run(mod); } catch (e) { death = e; break; }
    }
    assert.ok(death, `${m.name} must die`);
    assert.match(String(death.message), m.dies, `${m.name} died elsewhere: ${death.message}`);
  }
});
