/**
 * Auto-update status model + presentation mapping.
 *
 * Deliberately electron-free: main (src/main/updater.ts) produces these states
 * from electron-updater events, the toolbar badge
 * (src/renderer/src/components/UpdateBadge.tsx) renders them, and the rules that
 * matter — which state wins when two arrive out of order, what the button says
 * and does — live here where they can be unit-tested without booting Electron.
 */

/** One newer release the user can choose to install. `notes` is that
 *  release's own body (markdown, or plain text converted from the atom feed's
 *  HTML); `url` is its release page; `downloadUrl` its installer for THIS
 *  machine when the release named one. */
export interface ReleaseOption {
  version: string;
  notes?: string;
  url: string;
  downloadUrl?: string;
}

export type UpdateStatus =
  /** Nothing known yet (fresh window, or dev build where we never check). */
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available' }
  /** `versions`: EVERY newer release known, newest first (so
   *  `versions[0].version === version`). Optional: a status without it is the
   *  one-version list `[version]` — see `releaseChoices`. */
  | { state: 'available'; version: string; notes?: string; versions?: ReleaseOption[] }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string; notes?: string }
  /** This install can't self-update (win-portable, or the native path failed):
   *  notify-only, link to the release page. `reason` is the underlying error.
   *  `notes` is the release body — the notify-only poll already reads the same
   *  `releases/latest` JSON that carries it, so the toast can show "what's new"
   *  here too without a second request. */
  | { state: 'available-manual'; version: string; url: string; reason?: string; notes?: string;
      /** Direct asset for THIS platform/arch, when the release has one. The
       *  modal's primary button downloads it; without it the button falls back
       *  to the releases page. */
      downloadUrl?: string;
      /** Every newer release, newest first — same contract as on 'available'. */
      versions?: ReleaseOption[] }
  /** First launch after the version moved: `version` is the one now RUNNING and
   *  `notes` its release body, so the renderer can show that release's page. */
  | { state: 'just-updated'; version: string; notes?: string }
  | { state: 'error'; message: string };

export type UpdateAction = 'none' | 'check' | 'download' | 'restart' | 'open-release' | 'manual';

/** THE ONLY place the app's release home is named. Every update feed, release
 *  lookup, installer download URL, "view release" link and the Settings hero
 *  fetch is derived from this one constant, so the app can never be repointed
 *  half-way — one file saying Prozzta while another still says upstream.
 *
 *  It is the human's own repository, and deliberately NOT the upstream project
 *  this app was forked from. The packaged app must only ever look for, fetch or
 *  offer a build from here. Prozzta/guppyos publishes its releases on
 *  purpose (from 1.1.79); while it has none newer than the running build, the
 *  updater finds nothing to offer and stays dormant.
 *
 *  (The git remote named `upstream` is the dev-time cherry-pick library and is
 *  not a runtime path; nothing in the running app reads it.) */
export const REPO = 'Prozzta/guppyos';

/** REBRAND-GUPPY: the first release whose artifacts are named Guppy-*. Up to 1.1.82 they keep
 *  Munder-Difflin-*, because 1.1.81 (and older) build their manual-download link from those
 *  fixed names; a build that knows this switch can follow the rename from 1.1.83 on. */
export const GUPPY_ARTIFACTS_FROM = '1.1.83';

/** The artifact-name prefix electron-builder.yml gives release v{version}. */
export function artifactPrefix(version: string): string {
  const v = version.replace(/^v/, '');
  return parseVersion(v) && !isNewer(GUPPY_ARTIFACTS_FROM, v) ? 'Guppy' : 'Munder-Difflin';
}

/** The installer for THIS machine in the release tagged v{version}, by the
 *  names electron-builder.yml produces (see artifactPrefix). Used when a status carries no
 *  `downloadUrl` of its own (the native updater path never does). */
export function installerUrl(version: string, platform: string, arch: string): string {
  const v = version.replace(/^v/, '');
  const p = artifactPrefix(v);
  const file = platform === 'darwin' ? `${p}-${v}-mac-${arch}.dmg`
    : platform === 'win32' ? `${p}-${v}-win-x64-setup.exe`
    : `${p}-${v}-linux-x86_64.AppImage`;
  return `https://github.com/${REPO}/releases/download/v${v}/${file}`;
}

/** Newest first, numerically (0.3.10 above 0.3.9). */
function byNewest(a: ReleaseOption, b: ReleaseOption): number {
  return isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0;
}

/** Keep only versions newer than `current`, one row per version, newest first. */
function tidy(list: ReleaseOption[], current: string): ReleaseOption[] {
  const seen = new Set<string>();
  const out: ReleaseOption[] = [];
  for (const r of list) {
    const v = r.version.replace(/^v/, '');
    if (!parseVersion(v) || !isNewer(v, current) || seen.has(v)) continue;
    seen.add(v);
    out.push({ ...r, version: v });
  }
  return out.sort(byNewest);
}

/**
 * The fallback poll's `GET /releases` list -> every newer, published, stable
 * release. Drafts and prereleases are dropped (the native path never offers
 * them either), and each keeps its own body and this machine's installer.
 */
export function newerReleases(
  releases: unknown,
  current: string,
  platform: string,
  arch: string,
  pickAsset: (assets: ReadonlyArray<{ name?: string; browser_download_url?: string }> | undefined) => string | null = () => null
): ReleaseOption[] {
  if (!Array.isArray(releases)) return [];
  const list: ReleaseOption[] = [];
  for (const raw of releases as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object' || raw.draft === true || raw.prerelease === true) continue;
    const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
    const version = tag.replace(/^v/, '');
    if (!parseVersion(version)) continue;
    list.push({
      version,
      notes: typeof raw.body === 'string' ? raw.body : undefined,
      url: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${REPO}/releases/tag/v${version}`,
      downloadUrl: pickAsset(raw.assets as ReadonlyArray<{ name?: string; browser_download_url?: string }> | undefined)
        ?? installerUrl(version, platform, arch)
    });
  }
  return tidy(list, current);
}

/**
 * The fallback poll's raw response body -> the newer releases, or why it could not be
 * read (truncated, not JSON, or GitHub's error object such as a rate limit). The
 * caller logs the error instead of failing silently (UAV-163 C1).
 */
export function releaseListFromBody(
  body: string,
  current: string,
  platform: string,
  arch: string,
  pickAsset?: (assets: ReadonlyArray<{ name?: string; browser_download_url?: string }> | undefined) => string | null
): { versions: ReleaseOption[] } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch (e) {
    return { error: `not JSON (${body.length} B): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed)) {
    const msg = parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
      ? (parsed as { message: string }).message : typeof parsed;
    return { error: `not a release list: ${msg}` };
  }
  return { versions: newerReleases(parsed, current, platform, arch, pickAsset) };
}

/**
 * electron-updater's `releaseNotes` with `fullChangelog = true` — an array of
 * `{version, note}` for every release in (current, latest], read from the atom
 * feed it already downloaded — -> the options list. The latest release is
 * ALWAYS in the result even if the feed somehow lacked it, because that one is
 * what electron-updater itself resolved. `toText` turns the feed's HTML into
 * something the markdown digest can read.
 */
export function releaseOptionsFromNotes(
  releaseNotes: unknown,
  latest: string,
  current: string,
  platform: string,
  arch: string,
  toText: (html: string) => string = (h) => h
): ReleaseOption[] {
  const list: ReleaseOption[] = [];
  const option = (version: string, note: unknown): ReleaseOption => {
    const v = version.replace(/^v/, '');
    return {
      version: v,
      notes: typeof note === 'string' && note.trim() ? toText(note) : undefined,
      url: `https://github.com/${REPO}/releases/tag/v${v}`,
      downloadUrl: installerUrl(v, platform, arch)
    };
  };
  if (Array.isArray(releaseNotes)) {
    for (const r of releaseNotes as Array<{ version?: unknown; note?: unknown }>) {
      if (r && typeof r.version === 'string') list.push(option(r.version, r.note));
    }
  }
  const out = tidy(list, current);
  if (!out.some((r) => r.version === latest.replace(/^v/, '')) && isNewer(latest, current)) {
    out.unshift(option(latest, typeof releaseNotes === 'string' ? releaseNotes : undefined));
    out.sort(byNewest);
  }
  return out;
}

/**
 * The versions a picker offers for `status`, newest first — the first entry is
 * the preselected one. A status that predates `versions` (or carries an empty
 * list) is its own single version, so every surface can treat "one release"
 * and "many" the same way.
 */
export function releaseChoices(status: UpdateStatus | null, current: string): ReleaseOption[] {
  if (!status || (status.state !== 'available' && status.state !== 'available-manual')) return [];
  const own: ReleaseOption = {
    version: status.version,
    notes: status.notes,
    url: status.state === 'available-manual' ? status.url : `https://github.com/${REPO}/releases/tag/v${status.version}`,
    downloadUrl: status.state === 'available-manual' ? status.downloadUrl : undefined
  };
  const list = tidy([...(status.versions ?? []), own], current);
  // The status's own version leads even if a list somehow named something
  // newer: it is what the headline and the native download refer to.
  const i = list.findIndex((r) => r.version === status.version.replace(/^v/, ''));
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
}

/** Where downloading `option` goes: its own asset, else the conventional installer. */
export function optionDownloadUrl(option: ReleaseOption, platform: string, arch: string): string {
  return option.downloadUrl ?? installerUrl(option.version, platform, arch);
}

/** The newer release a status knows about, or null. Every state that names a
 *  version newer than the running one counts, whatever the updater is doing
 *  with it: the manual path is always on offer. */
export function pendingVersion(status: UpdateStatus | null, current: string): string | null {
  if (!status || !('version' in status)) return null;
  if (status.state === 'just-updated') return null;
  return isNewer(status.version, current) ? status.version : null;
}

/** Where a manual download of `status`'s release goes: the asset the release
 *  itself named when it did, else the conventional installer URL. */
export function manualDownloadUrl(status: UpdateStatus, platform: string, arch: string): string | null {
  if (!('version' in status) || status.state === 'just-updated') return null;
  if (status.state === 'available-manual' && status.downloadUrl) return status.downloadUrl;
  return installerUrl(status.version, platform, arch);
}

export interface UpdateBadgeView {
  /** Extra text beside the version, or null to show the version alone. */
  label: string | null;
  /** What a click does. 'none' renders the badge non-interactive. */
  action: UpdateAction;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
  /** Tooltip — the only place the underlying error is ever surfaced verbatim. */
  title: string;
  busy: boolean;
}

/** `1.2.3` / `v1.2.3` -> [1,2,3]; null for anything that isn't semver-ish. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Download percentages arrive as floats and, on a resumed/differential
 *  download, occasionally out of range. Clamp so the UI can't render `-0%`
 *  or `104%`. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** How far along the update pipeline a state is. A later stage is never
 *  replaced by an earlier one for the SAME version — see `reduceStatus`. */
function rank(s: UpdateStatus): number {
  switch (s.state) {
    case 'idle': return 0;
    case 'checking': return 1;
    case 'not-available': return 1;
    case 'error': return 1;
    case 'just-updated': return 1;
    case 'available-manual': return 2;
    case 'available': return 3;
    case 'downloading': return 4;
    case 'downloaded': return 5;
  }
}

function versionOf(s: UpdateStatus): string | null {
  return 'version' in s ? s.version : null;
}

/**
 * Fold a new status into the current one.
 *
 * The rule that matters: once an update is staged, the 6-hourly re-check (or a
 * manual "check now") must NOT wipe the "restart to update" affordance out from
 * under the user — `checking` / `not-available` / a transient `error` are all
 * lower-rank and lose. A genuinely NEWER version always wins, so a long-running
 * app that sees 0.3.7 while 0.3.6 is staged moves forward rather than sticking.
 */
export function reduceStatus(prev: UpdateStatus | null, next: UpdateStatus): UpdateStatus {
  if (!prev) return next;
  const pv = versionOf(prev);
  const nv = versionOf(next);
  if (pv && nv && isNewer(nv, pv)) return next;   // a newer release supersedes
  if (pv && nv && pv !== nv) return next;         // different (e.g. rolled back) release
  return rank(next) >= rank(prev) ? next : prev;
}

/**
 * What the toolbar badge shows and does for a given status.
 *
 * `currentVersion` is the running app's version — it is always rendered next to
 * the logo, so every one of these views is "v0.3.6" plus at most one extra chip.
 */
export function describeUpdate(status: UpdateStatus | null, currentVersion: string): UpdateBadgeView {
  const v = currentVersion;
  // The title-bar badge is the MANUAL path, always: click downloads the
  // installer and the user replaces the app. Auto-update (download, restart)
  // lives in Settings -> Updates. So any state that names a newer release reads
  // the same here, whatever the background updater is doing with it.
  if (status?.state === 'downloading') {
    // Settings started the automatic download; the chip reports progress and
    // nothing else, so the two paths are not raced against each other.
    return {
      label: `downloading ${clampPercent(status.percent)}%`, action: 'none', tone: 'busy', busy: true,
      title: `Downloading v${status.version}… ${clampPercent(status.percent)}%`
    };
  }
  const pending = pendingVersion(status, v);
  if (pending) {
    const why = status?.state === 'available-manual' && status.reason
      ? ` (this install could not update itself: ${status.reason})` : '';
    return {
      label: `v${pending} · download`, action: 'manual', tone: 'ready', busy: false,
      title: `Click to download v${pending}, then replace the app you have${why}`
    };
  }
  switch (status?.state) {
    case 'checking':
      return { label: 'checking…', action: 'none', tone: 'busy', busy: true, title: `Checking for updates (you're on v${v})` };
    case 'error':
      return {
        label: 'update check failed', action: 'check', tone: 'warn', busy: false,
        title: `${status.message} — click to try again`
      };
    case 'not-available':
    case 'just-updated':
      // A check has confirmed it, so say so. Idle (no check yet) stays bare.
      return { label: 'latest', action: 'check', tone: 'idle', busy: false, title: `v${v} is the latest version — click to check again` };
    case 'idle':
    default:
      return { label: null, action: 'check', tone: 'idle', busy: false, title: `v${v} — click to check for updates` };
  }
}

export interface UpdateSettingsView {
  /** Headline: the version that matters right now — yours, or the one waiting. */
  headline: string;
  /** One sentence of explanation. Carries the verbatim error when there is one. */
  detail: string;
  /** Primary button label, or null while the updater is mid-flight and there is
   *  nothing useful to press. */
  button: string | null;
  action: UpdateAction;
  busy: boolean;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
}

/**
 * What the Settings → General "Updates" block shows and does.
 *
 * Separate from `describeUpdate` on purpose. The toolbar chip has room for two
 * words and has to stay quiet when nothing is happening, so its idle state says
 * nothing at all; Settings is where someone goes *to ask*, so every state gets a
 * full sentence and — outside the two mid-flight states — a button. The states
 * and the transitions between them are shared, which is the part that has to
 * stay in sync.
 */
export function describeUpdateSettings(
  status: UpdateStatus | null,
  currentVersion: string
): UpdateSettingsView {
  const v = currentVersion;
  switch (status?.state) {
    case 'checking':
      return {
        headline: `You're on v${v}`,
        detail: 'Checking for a newer release…',
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'available':
      return {
        headline: `v${status.version} is available`,
        detail: `You're on v${v}. Download it now — you'll be asked to restart once it's ready.`,
        button: `Download v${status.version}`, action: 'download', busy: false, tone: 'ready'
      };
    case 'downloading':
      return {
        headline: `Downloading v${status.version}`,
        detail: `${clampPercent(status.percent)}% done. You can keep working; the restart is yours to trigger.`,
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'downloaded':
      return {
        headline: `v${status.version} is ready to install`,
        detail: `Restart Munder Difflin to finish updating from v${v}.`,
        button: 'Restart to update', action: 'restart', busy: false, tone: 'ready'
      };
    case 'available-manual':
      return {
        headline: `v${status.version} is available`,
        detail: status.reason
          ? `This install can't update itself (${status.reason}) — download it from the release page.`
          : `This install can't update itself — download it from the release page.`,
        button: status.downloadUrl ? `Download v${status.version}` : 'Open release page',
        action: 'open-release', busy: false, tone: 'warn'
      };
    case 'just-updated':
      return {
        headline: `You're on v${v}`,
        detail: 'Freshly updated. This is the latest release.',
        button: 'Check for updates', action: 'check', busy: false, tone: 'idle'
      };
    case 'error':
      return {
        headline: 'Update check failed',
        detail: `${status.message} (you're on v${v}).`,
        button: 'Try again', action: 'check', busy: false, tone: 'warn'
      };
    case 'not-available':
      return {
        headline: `v${v} is the latest version`,
        detail: "You're already up to date — nothing to install.",
        button: 'Check again', action: 'check', busy: false, tone: 'idle'
      };
    case 'idle':
    default:
      return {
        headline: `You're on v${v}`,
        detail: 'Updates are checked automatically every 6 hours. Check now if you want to be sure.',
        button: 'Check for updates', action: 'check', busy: false, tone: 'idle'
      };
  }
}

/** What to do with the installer once it has downloaded, per platform. Shown
 *  on the title-bar badge's hover card and in the notice after the click. */
export function manualInstallSteps(platform: string): { os: string; steps: string[] } {
  if (platform === 'darwin') {
    return {
      os: 'macOS',
      steps: [
        'Open the .dmg and drag Munder Difflin onto Applications. Choose Replace when asked.',
        'Quit this app, open the new one from Applications, and pick the same project.'
      ]
    };
  }
  if (platform === 'win32') {
    return {
      os: 'Windows',
      steps: [
        'Quit this app, then run the downloaded setup .exe. It replaces the installed version.',
        'Open Munder Difflin again and pick the same project.'
      ]
    };
  }
  return {
    os: 'Linux',
    steps: [
      'Make the downloaded .AppImage executable (chmod +x) and move it over the one you run now.',
      'Quit this app, launch the new AppImage, and pick the same project.'
    ]
  };
}
