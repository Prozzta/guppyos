/**
 * GUPPY-BUILD-PREREQS: probes for the "Build from source" group of Settings → Prerequisites.
 *
 * Each probe asks the same question the build will: the Node on PATH (what `npm ci` runs), the
 * Python node-gyp will pick (its own search order, below), and vswhere for each VS component.
 * Pure over injected deps so the tests drive every branch without a toolchain; the IPC handler
 * in index.ts passes the real execFile/existsSync/env.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  buildToolCatalog,
  BUILD_NODE_MAJOR,
  BUILD_PYTHON,
  BUILD_VS_REQUIRES,
  VS_PATH_DEFAULT,
  VS_PATH_TOKEN,
  VS_SETUP_DEFAULT,
  VS_SETUP_TOKEN,
  type ToolSpec,
  type ToolStatus
} from '../shared/toolCatalog';

export interface ExecResult {
  /** Exit 0 and spawned. */
  ok: boolean;
  stdout: string;
  /** Killed by the time box: the answer is unknown, not "missing". */
  timedOut?: boolean;
}

export interface BuildProbeDeps {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  exec: (file: string, args: string[]) => Promise<ExecResult>;
}

const PY_VERSION_ARGS = ['-c', 'import sys; print(sys.executable); print("%d.%d.%d" % sys.version_info[:3])'];
const NODE_ARGS = ['-e', 'process.stdout.write(JSON.stringify([process.versions.node, !!(process.config.variables || {}).enable_pgo_use, process.execPath]))'];

type Row = Pick<ToolStatus, 'found' | 'path'> & Partial<Pick<ToolStatus, 'unknown' | 'detail' | 'warn'>> & { installCommand?: string };

/** The Node on PATH: its major, and whether it was built with PGO (the Node 26 node.profdata break). */
export async function probeNode(deps: BuildProbeDeps): Promise<Row> {
  const r = await deps.exec('node', NODE_ARGS);
  if (r.timedOut) return { found: false, path: null, unknown: true };
  if (!r.ok) return { found: false, path: null };
  let version = '', pgo = false, execPath: string | null = null;
  try { [version, pgo, execPath] = JSON.parse(r.stdout.trim()) as [string, boolean, string]; }
  catch { return { found: false, path: null }; }
  const major = Number(String(version).split('.')[0]);
  const warns: string[] = [];
  if (major !== BUILD_NODE_MAJOR) warns.push(`Node ${version} is on PATH; the build needs Node ${BUILD_NODE_MAJOR}.`);
  if (pgo) warns.push('This Node was built with PGO (enable_pgo_use), which breaks native module builds.');
  return { found: true, path: execPath || null, detail: `v${version}`, ...(warns.length ? { warn: warns.join(' ') } : {}) };
}

interface PyHit { exe: string; version: string; via: string }

/** Run one Python candidate; null when it does not run or is older than node-gyp's 3.6 floor. */
async function tryPython(deps: BuildProbeDeps, file: string, pre: string[], via: string): Promise<PyHit | null | 'timeout'> {
  const r = await deps.exec(file, [...pre, ...PY_VERSION_ARGS]);
  if (r.timedOut) return 'timeout';
  if (!r.ok) return null;
  const [exe, version] = r.stdout.trim().split(/\r?\n/).map((s) => s.trim());
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version ?? '');
  if (!exe || !m || Number(m[1]) !== 3 || Number(m[2]) < 6) return null;
  return { exe, version, via };
}

/** node-gyp's Windows default locations (it checks 3.11 down to 3.8, NOT 3.12). */
function winDefaultLocations(env: BuildProbeDeps['env'], minors: string[]): string[] {
  const sys = env.SystemDrive || 'C:';
  const local = env.LOCALAPPDATA || `${sys}\\Users\\${env.USERNAME || ''}\\AppData\\Local`;
  const pf = env.ProgramW6432 || env.ProgramFiles || `${sys}\\Program Files`;
  const pf86 = env['ProgramFiles(x86)'] || `${pf} (x86)`;
  return minors.flatMap((mm) => [
    `${local}\\Programs\\Python\\Python${mm}\\python.exe`,
    `${pf}\\Python${mm}\\python.exe`,
    `${local}\\Programs\\Python\\Python${mm}-32\\python.exe`,
    `${pf}\\Python${mm}-32\\python.exe`,
    `${pf86}\\Python${mm}-32\\python.exe`
  ]);
}

/**
 * The Python node-gyp will use, found in node-gyp's own order: NODE_GYP_FORCE_PYTHON,
 * npm_config_python, PYTHON, the py launcher (Windows), python3, python, then its Windows default
 * locations. A 3.12 that node-gyp will NOT find (Python312 is not in its default list) is reported
 * with the one-line fix.
 */
export async function probePython(deps: BuildProbeDeps): Promise<Row> {
  const win = deps.platform === 'win32';
  const candidates: Array<[string, string[], string]> = [];
  for (const k of ['NODE_GYP_FORCE_PYTHON', 'npm_config_python', 'PYTHON']) {
    const v = deps.env[k];
    if (v) candidates.push([v, [], k]);
  }
  if (win) candidates.push(['py', ['-3'], 'the py launcher']);
  candidates.push(['python3', [], 'python3 on PATH'], ['python', [], 'python on PATH']);
  if (win) for (const loc of winDefaultLocations(deps.env, ['311', '310', '39', '38'])) if (deps.exists(loc)) candidates.push([loc, [], loc]);

  let sawTimeout = false;
  let hit: PyHit | null = null;
  for (const [file, pre, via] of candidates) {
    const h = await tryPython(deps, file, pre, via);
    if (h === 'timeout') { sawTimeout = true; continue; }
    if (h) { hit = h; break; }
  }
  const mm = BUILD_PYTHON.replace('.', '');
  const wanted = (v: string) => v.startsWith(`${BUILD_PYTHON}.`);
  // node-gyp accepts any 3.6+ (release.yml builds with 3.11): another 3.x is ready, not a warning.
  if (hit) return { found: true, path: hit.exe, detail: `${hit.version} (via ${hit.via})` };

  // node-gyp found no Python: is a 3.12 installed where node-gyp does not look?
  let p312: PyHit | null = null;
  if (win) {
    for (const loc of winDefaultLocations(deps.env, [mm]).filter((l) => !l.includes('-32'))) {
      if (!deps.exists(loc)) continue;
      const h = await tryPython(deps, loc, [], loc);
      if (h && h !== 'timeout' && wanted(h.version)) { p312 = h; break; }
    }
  }
  const pointAt = p312 ? (win ? `setx npm_config_python "${p312.exe}"` : `export npm_config_python="${p312.exe}"`) : '';
  if (p312) {
    return {
      found: true, path: p312.exe, detail: p312.version,
      warn: `Python ${p312.version} is installed, but node-gyp will not find it (not on PATH, no npm_config_python). Set npm_config_python, then open a new terminal and restart Guppy (setx reaches only new processes).`,
      installCommand: pointAt
    };
  }
  return { found: false, path: null, ...(sawTimeout ? { unknown: true } : {}) };
}

export function vswherePath(env: BuildProbeDeps['env']): string {
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return `${pf86}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
}

/** The VS 2022 install (Build Tools included: `-products *`) that has every id, or null.
 *  The range is pinned to 2022 on purpose: the node-gyp this build uses (@electron/node-gyp 10)
 *  knows VS up to 2022 only, so a VS 2026 (version 18) install would not be used by the build. */
async function vswhereFind(deps: BuildProbeDeps, ids: string[]): Promise<{ path: string | null; timedOut?: boolean }> {
  const r = await deps.exec(vswherePath(deps.env), [
    '-products', '*', '-version', '[17.0,18.0)', '-requires', ...ids, '-property', 'installationPath', '-format', 'value'
  ]);
  if (r.timedOut) return { path: null, timedOut: true };
  const first = r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) : undefined;
  return { path: first || null };
}

/** One time-boxed child, no shell (the args reach the program as given). A time-out is reported
 *  as such, so the row says "not checked" instead of "missing". */
export function execBounded(file: string, args: string[], timeoutMs = 10_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        const e = err as (Error & { killed?: boolean; signal?: string | null }) | null;
        resolve({ ok: !e, stdout: String(stdout ?? ''), ...(e && (e.killed || e.signal === 'SIGTERM') ? { timedOut: true } : {}) });
      });
    } catch { resolve({ ok: false, stdout: '' }); }
  });
}

/** The real machine, for the IPC handler. */
export function hostBuildProbeDeps(): BuildProbeDeps {
  return { platform: process.platform, env: process.env, exists: existsSync, exec: (file, args) => execBounded(file, args) };
}

const fill = (cmd: string, setup: string, vsPath: string) =>
  cmd.split(VS_SETUP_TOKEN).join(setup).split(VS_PATH_TOKEN).join(vsPath);

/** Every "Build from source" row for this machine. Never throws: a failed probe is a row. */
export async function buildPrereqStatus(deps: BuildProbeDeps): Promise<ToolStatus[]> {
  const win = deps.platform === 'win32';
  const specs = buildToolCatalog(deps.platform);
  const hasVswhere = win && deps.exists(vswherePath(deps.env));
  // The VS install path the "modify --add" lines target: the one with the C++ tools, else any VS 2022.
  let vsPath = VS_PATH_DEFAULT;
  if (hasVswhere) {
    const base = await vswhereFind(deps, BUILD_VS_REQUIRES['build:vs-vctools']).catch(() => ({ path: null }));
    const any = base.path ? base : await vswhereFind(deps, []).catch(() => ({ path: null }));
    if (any.path) vsPath = any.path;
  }
  const setup = deps.env['ProgramFiles(x86)']
    ? `${deps.env['ProgramFiles(x86)']}\\Microsoft Visual Studio\\Installer\\setup.exe`
    : VS_SETUP_DEFAULT;

  return Promise.all(specs.map(async (spec: ToolSpec): Promise<ToolStatus> => {
    const installCommand = fill(win ? spec.install.win32 : spec.install.posix, setup, vsPath);
    let row: Row = { found: false, path: null };
    try {
      if (spec.id === 'build:node') row = await probeNode(deps);
      else if (spec.id === 'build:python') row = await probePython(deps);
      else if (spec.id in BUILD_VS_REQUIRES) {
        if (hasVswhere) {
          const f = await vswhereFind(deps, BUILD_VS_REQUIRES[spec.id as keyof typeof BUILD_VS_REQUIRES]);
          row = f.timedOut ? { found: false, path: null, unknown: true } : { found: !!f.path, path: f.path };
        }
      }
    } catch { /* a probe must never take the panel down */ }
    const { installCommand: override, ...rest } = row;
    return { ...spec, installCommand: override ?? installCommand, ...rest };
  }));
}
