/**
 * The setup catalog — every EXTERNAL tool the harness can use, what it buys the
 * user, and how to install it on this platform.
 *
 * Why this file exists: the app ships as one Electron bundle, but several of its
 * best features are thin wrappers over tools that live outside it — git for
 * worktrees and one CLI per agent engine. (Semantic memory is built in: no row.)
 * Every one of them degrades
 * SILENTLY when absent, which is friendly right up until the user cannot tell
 * "off" from "broken" and has no single place that says which is which. This
 * catalog is that place.
 *
 * The engine rows are DERIVED from AGENT_PROVIDER_PRESETS rather than restated
 * here: those presets already carry `defaultCommand`, `installCommand`,
 * `nativeInstallCommand` and `docsUrl`, and a second hand-maintained copy would
 * drift the moment a provider is added.
 */

import { AGENT_PROVIDER_PRESETS } from './agentProvider';

/** GUPPY-BUILD-PREREQS: 'build' rows are the opt-in "Build from source" group (buildToolCatalog). */
export type ToolKind = 'prerequisite' | 'engine' | 'build';

export interface ToolSpec {
  /** Stable row id. For a probed binary this is also the name we look up. */
  id: string;
  /** The executable to probe on PATH, or null when there is nothing to probe. */
  bin: string | null;
  label: string;
  kind: ToolKind;
  /** One line, benefit-framed: what the user LOSES without it. */
  why: string;
  /** Part of "set up everything". Everything else is opt-in. */
  essential: boolean;
  /** Install command per platform. Empty string = no scripted install. */
  install: { posix: string; win32: string };
  /** Shown when there is no scripted install, or as extra context. */
  note?: string;
  docsUrl?: string;
}

/** Base rows — the non-engine tools. Engines are appended by `toolCatalog()`. */
const BASE_TOOLS: ToolSpec[] = [
  {
    id: 'git',
    bin: 'git',
    label: 'git',
    kind: 'prerequisite',
    why: "Worktrees let agents work in parallel without fighting over one checkout, and the hive keeps its own history in git.",
    essential: true,
    install: {
      posix: 'xcode-select --install   # macOS · or: sudo apt install git',
      win32: 'winget install --id Git.Git -e'
    },
    docsUrl: 'https://git-scm.com/downloads'
  },
  {
    id: 'node',
    bin: 'node',
    label: 'Node.js',
    kind: 'prerequisite',
    why: 'Runs the npm-installed agent engines (OpenCode, and Claude Code on machines without the native build).',
    essential: false,
    // Deliberately no scripted command: the app already ships a checksum-verified
    // Node installer (nodeInstall.ts) that runs automatically when an engine needs
    // one. Printing a rival curl|sh here would compete with it.
    install: { posix: '', win32: '' },
    note: 'The app installs this for you when an engine needs it — nothing to do by hand.',
    docsUrl: 'https://nodejs.org'
  }
];

/**
 * The full catalog for a platform. `platform` is a `process.platform` value; only
 * win32 vs everything-else matters.
 */
export function toolCatalog(): ToolSpec[] {
  const engines: ToolSpec[] = AGENT_PROVIDER_PRESETS
    // `custom` is whatever the user typed — there is nothing to detect or install.
    .filter((p) => p.id !== 'custom' && !!p.defaultCommand)
    .map((p) => ({
      id: `engine:${p.id}`,
      bin: p.defaultCommand,
      label: p.label,
      kind: 'engine' as const,
      why: `Agent engine — ${p.defaultCommand}.`,
      // Claude Code is the recommended engine and the only one the floor assumes
      // by default, so it is the one engine "set up everything" will install.
      essential: p.id === 'claude',
      install: {
        posix: p.installCommand ?? p.nativeInstallCommand?.posix ?? '',
        win32: p.installCommand ?? p.nativeInstallCommand?.win32 ?? ''
      },
      docsUrl: p.docsUrl
    }));
  return [...BASE_TOOLS, ...engines];
}

/** A catalog row plus what we found on THIS machine. */
export interface ToolStatus extends ToolSpec {
  found: boolean;
  /** Absolute path when found, or null. */
  path: string | null;
  /** RESOLVER-TIMEOUT-MISS: the lookup timed out (machine under load), so `found: false` is not
   *  known to be true. Reopening the panel checks again (an unknown is never cached). */
  unknown?: boolean;
  /** Extra live context — e.g. a version string. */
  detail?: string;
  /** GUPPY-BUILD-PREREQS: present but not usable as is (wrong Node major, a Python node-gyp will
   *  not find). The row shows this line and its installCommand even though `found` is true. */
  warn?: string;
  /** `install` already resolved for the running platform. */
  installCommand: string;
}

// ─── GUPPY-BUILD-PREREQS: the "Build from source" group ─────────────────────
// What `npm ci` needs on a machine that builds Guppy itself: better-sqlite3 and node-pty are
// native addons, compiled by node-gyp through @electron/rebuild in postinstall. None of it is
// needed to RUN the app, so the group is opt-in (probed only when the user opens it) and no row
// is essential. Nothing here installs anything: the rows show the command, the user runs it.

/** The Node major the build is pinned to: .nvmrc says the same and the CI workflows read .nvmrc
 *  (test-pinned). */
export const BUILD_NODE_MAJOR = 24;
/** The Python the floor builds with. node-gyp accepts any 3.6+, so another 3.x is a warning. */
export const BUILD_PYTHON = '3.12';

/** vswhere `-requires` ids per VS row (all must be present). The VC-tools row probes the MSVC
 *  x86/x64 compiler component (what node-gyp itself checks), which both the Build Tools VCTools
 *  workload and a full VS "Desktop development with C++" install provide. */
export const BUILD_VS_REQUIRES: Record<'build:vs-vctools' | 'build:vs-spectre' | 'build:vs-clangcl', string[]> = {
  'build:vs-vctools': ['Microsoft.VisualStudio.Component.VC.Tools.x86.x64'],
  'build:vs-spectre': ['Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'],
  'build:vs-clangcl': ['Microsoft.VisualStudio.Component.VC.Llvm.Clang', 'Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset']
};

/** The row that only a clang-cl built Node needs: the probe keeps it when the Node on PATH reports
 *  process.config clang 1 (official Node 24 does), drops it when it reports 0. */
export const BUILD_CLANGCL_ID = 'build:vs-clangcl';

/** Install-text placeholders the main process fills from the probe (vswhere's installer and the
 *  found VS install path); left as written when VS is not there yet. */
export const VS_SETUP_TOKEN = '{vsSetup}';
export const VS_PATH_TOKEN = '{vsPath}';
export const VS_SETUP_DEFAULT = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe';
export const VS_PATH_DEFAULT = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools';

const ADMIN_NOTE = 'Needs an admin prompt (it asks for UAC approval).';
const vsModify = (ids: string[]) =>
  `"${VS_SETUP_TOKEN}" modify --installPath "${VS_PATH_TOKEN}" ${ids.map((id) => `--add ${id}`).join(' ')} --passive --norestart`;

export const BUILD_GROUP = {
  title: 'Build from source',
  blurb: 'Only for building Guppy itself from its source code. Running the app needs none of this.',
  why: 'npm ci compiles two native modules, better-sqlite3 (the memory database) and node-pty (the agent terminals), with node-gyp. These are the tools that build needs.',
  posixNote: 'You also need a C/C++ compiler: on macOS run xcode-select --install, on Linux install build-essential (or your distro\'s gcc, g++ and make).'
} as const;

const BUILD_TOOLS: (ToolSpec & { platforms: Array<'win32' | 'posix'> })[] = [
  {
    id: 'build:node',
    bin: 'node',
    label: `Node.js ${BUILD_NODE_MAJOR}`,
    kind: 'build',
    why: `The build is pinned to Node ${BUILD_NODE_MAJOR} (.nvmrc). A native module with no prebuild for this Node is compiled with the running Node's own settings: a Node built with PGO (Node 26) asks for a profile that is not there, and one built with clang-cl and LTCG (Node 24) fails to link (llvm-lib rejects /LTCG). Guppy's modules use prebuilds or Electron's headers, so npm ci is not affected.`,
    essential: false,
    install: {
      posix: `nvm install ${BUILD_NODE_MAJOR} && nvm use ${BUILD_NODE_MAJOR}`,
      win32: `winget install --id CoreyButler.NVMforWindows -e   # then, in a new terminal: nvm install ${BUILD_NODE_MAJOR} && nvm use ${BUILD_NODE_MAJOR}`
    },
    docsUrl: 'https://nodejs.org/en/download',
    platforms: ['win32', 'posix']
  },
  {
    id: 'build:python',
    bin: 'python',
    label: 'Python 3',
    kind: 'build',
    why: `node-gyp runs Python to generate the native build files. Any 3.x it finds works: the release workflow builds with 3.11, this floor with ${BUILD_PYTHON}.`,
    essential: false,
    install: {
      posix: `brew install python@${BUILD_PYTHON}   # macOS · or: sudo apt install python${BUILD_PYTHON}`,
      win32: `winget install --id Python.Python.${BUILD_PYTHON} -e`
    },
    docsUrl: 'https://www.python.org/downloads/',
    platforms: ['win32', 'posix']
  },
  {
    id: 'build:vs-vctools',
    bin: null,
    label: 'VS 2022 Build Tools (C++)',
    kind: 'build',
    why: 'The MSVC C++ compiler that builds better-sqlite3 and node-pty on Windows.',
    essential: false,
    install: {
      posix: '',
      win32: 'winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
    },
    note: ADMIN_NOTE,
    docsUrl: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
    platforms: ['win32']
  },
  {
    id: 'build:vs-spectre',
    bin: null,
    label: 'Spectre-mitigated libraries',
    kind: 'build',
    why: 'node-pty links the Spectre-mitigated MSVC libraries. Without them its build stops with MSB8040.',
    essential: false,
    install: { posix: '', win32: vsModify(BUILD_VS_REQUIRES['build:vs-spectre']) },
    note: `${ADMIN_NOTE} Install the VS 2022 Build Tools first.`,
    platforms: ['win32']
  },
  {
    id: BUILD_CLANGCL_ID,
    bin: null,
    label: 'ClangCL toolset',
    kind: 'build',
    why: 'This Node was built with clang-cl (process.config clang 1), so node-gyp builds a native module that has no prebuild for it with the ClangCL platform toolset.',
    essential: false,
    install: { posix: '', win32: vsModify(BUILD_VS_REQUIRES[BUILD_CLANGCL_ID]) },
    note: `${ADMIN_NOTE} Install the VS 2022 Build Tools first.`,
    platforms: ['win32']
  }
];

/** The "Build from source" rows for a `process.platform` value: on posix, Node and Python only. */
export function buildToolCatalog(platform: string): ToolSpec[] {
  const key = platform === 'win32' ? 'win32' : 'posix';
  return BUILD_TOOLS.filter((t) => t.platforms.includes(key)).map(({ platforms: _p, ...spec }) => spec);
}

/**
 * The prompt handed to Michael by "ask Michael to set up everything".
 *
 * Written as an explicit contract rather than a wish: name the exact commands so
 * he does not have to guess or search, and tell him to VERIFY rather than assume.
 */
export function setupPrompt(missing: ToolStatus[]): string {
  if (missing.length === 0) return '';
  const lines = missing.map((t) => {
    const cmd = t.installCommand ? `\n  install: ${t.installCommand}` : '';
    const note = t.note ? `\n  note: ${t.note}` : '';
    return `- ${t.label} (${t.id})${cmd}${note}`;
  });
  return [
    'Set up my missing local tooling. These are the tools this harness uses that are not installed on this machine:',
    '',
    ...lines,
    '',
    'For each one: run the install command in your own terminal, then VERIFY it actually resolves',
    '(`which <bin>`, or `where <bin>` on Windows) before moving on — do not assume an installer that',
    'printed no error succeeded.',
    '',
    'If a command needs my password or a decision only I can make, stop and ask me rather than',
    'guessing or working around it. When you are done, report one line per tool: installed, already',
    'present, or failed with the reason.'
  ].join('\n');
}
