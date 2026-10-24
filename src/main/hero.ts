/**
 * Fetch + cache the Settings hero payload.
 *
 * Same shape as the skills catalog: served from cache when fresh, refreshed in
 * the background otherwise, and NEVER fatal — a failed fetch falls back to the
 * cached copy, then to the defaults compiled into the app. The card must render
 * instantly and offline, because it sits at the top of a dialog people open to
 * change a folder.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getText } from './fetchText';
import { parseHeroPayload, DEFAULT_HERO, type HeroPayload } from '../shared/heroPayload';
import { REPO, isGitRef } from '../shared/updateState';

// docs/hero.json of THIS app's own repository (see REPO). It is content, not a
// build, but it is rendered inside the app with its links, so it must come from
// the same place as every update: never from the upstream project.
//
// HERO-FEED-BRANCH: and from the LIVE line of that repository. Releases are cut
// from release-x.y.z branches and the upstream-era default branch is unmaintained,
// so a branch name written here would be wrong again the moment the line moved.
// The ref is resolved from GitHub on every refresh instead: the latest release's
// tag, else the repository's default branch. No name is hard-coded.
const API_URL = `https://api.github.com/repos/${REPO}`;
export const LATEST_RELEASE_URL = `${API_URL}/releases/latest`;
export const REPO_API_URL = API_URL;
export function heroUrlFor(ref: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${ref}/docs/hero.json`;
}
/** Plan copy and sponsors change on a human timescale. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** After a FAILED refresh, no new request until this has passed; the stale cache
 *  or the defaults are served meanwhile. Otherwise a refusing API (offline, rate
 *  limited, 403) would cost two unauthenticated calls per Settings mount. A
 *  forced refresh is the user asking, and goes through. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type Fetch = (url: string, opts: { timeoutMs?: number }) => Promise<string>;

/** Which line of the repository is live right now: the latest release's tag,
 *  else the default branch. Throws when neither answer arrives or neither is a
 *  plausible git ref (a ref is interpolated into a URL, so it is validated, not
 *  trusted); the caller then falls back to cache or defaults, never to a name. */
export async function resolveLiveRef(fetch: Fetch = getText): Promise<string> {
  const pick = async (url: string, key: string): Promise<string> => {
    const body: unknown = JSON.parse(await fetch(url, { timeoutMs: FETCH_TIMEOUT_MS }));
    const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
    if (!isGitRef(value)) throw new Error(`no usable ${key} from ${url}`);
    return value;
  };
  try {
    return await pick(LATEST_RELEASE_URL, 'tag_name');
  } catch {
    return pick(REPO_API_URL, 'default_branch');
  }
}

export interface HeroCache { hero: HeroPayload; fetchedAt: number; ref?: string; lastAttempt?: number }
export interface HeroResult {
  hero: HeroPayload;
  fetchedAt: number;
  stale: boolean;
  /** The ref docs/hero.json was read from, for links into the same line
   *  (the changelog). null when nothing was ever fetched: offline on a fresh
   *  install, or a cache written before the ref was stored. */
  ref: string | null;
}

/** The cache file is untrusted input (an old build, a hand edit, a torn write).
 *  A wrong shape is no cache at all: the defaults, and the refresh is allowed.
 *  A right shape still has its hero re-validated, field by field. */
function readCache(raw: unknown): HeroCache | null {
  // JSON null has no fields; a number, a string or an array has no .hero.
  const c = raw as Record<string, unknown> | null;
  if (!c?.hero || typeof c.hero !== 'object' || Array.isArray(c.hero)) return null;
  if (typeof c.fetchedAt !== 'number') return null;
  return { ...(c as unknown as HeroCache), hero: parseHeroPayload(c.hero) };
}

export async function loadHero(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<HeroResult> {
  let cached: HeroCache | null = null;
  try {
    if (existsSync(cachePath)) cached = readCache(JSON.parse(readFileSync(cachePath, 'utf8')));
  } catch { cached = null; }
  const cachedRef = cached && isGitRef(cached.ref) ? cached.ref : null;

  // A time in the future (a clock set back, an edited file) is expired, not fresh.
  const now = Date.now();
  const within = (ts: unknown, ms: number): boolean => typeof ts === 'number' && now - ts >= 0 && now - ts < ms;
  if (cached && !opts.force && within(cached.fetchedAt, TTL_MS)) {
    return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: false, ref: cachedRef };
  }
  const backingOff = cached && within(cached.lastAttempt, RETRY_AFTER_MS);
  if (cached && !opts.force && backingOff) {
    return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true, ref: cachedRef };
  }

  try {
    const ref = await resolveLiveRef();
    const body = await getText(heroUrlFor(ref), { timeoutMs: FETCH_TIMEOUT_MS });
    // Parse the JSON and the SHAPE separately: valid JSON that is not a hero
    // payload must still degrade to defaults rather than render as undefined.
    const hero = parseHeroPayload(JSON.parse(body));
    const payload: HeroCache = { hero, fetchedAt: Date.now(), ref };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(payload));
    } catch { /* cache is an optimisation */ }
    return { hero, fetchedAt: payload.fetchedAt, stale: false, ref };
  } catch {
    // Remember the failure (negative cache) so the next mount inside
    // RETRY_AFTER_MS serves what we have without asking again.
    const failed: HeroCache = { ...(cached ?? { hero: DEFAULT_HERO, fetchedAt: 0 }), lastAttempt: Date.now() };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(failed));
    } catch { /* cache is an optimisation */ }
    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true, ref: cachedRef };
    return { hero: DEFAULT_HERO, fetchedAt: 0, stale: true, ref: null };
  }
}
