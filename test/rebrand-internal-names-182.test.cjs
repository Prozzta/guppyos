'use strict';
// REBRAND-GUPPY (1.1.82): the app is now Guppy (name, exe, data folder), but an existing 1.1.81
// install must upgrade IN PLACE with all its data (the Human, 2026-10-03). That depends on
// internal names users never see. Each pin below says what breaks if the name changes; see
// _work/creed-rebrand/REBRAND-SURVEY.md. Changing one of these needs a migration plan and a
// deliberate edit here, never a tidy-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const builder = read('electron-builder.yml');
/** A top-level `key: value` of electron-builder.yml (values here are plain scalars). */
const top = (key) => {
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(builder);
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : null;
};

test('appId stays in.munderdiffl.app and no nsis.guid is set (same installer identity)', () => {
  // NSIS derives its GUID as UUID.v5(appId) unless nsis.guid is set. Same GUID = same uninstall
  // entry, same install folder (InstallLocation), shortcuts renamed in place, same AUMID for
  // notifications and the taskbar. A new one installs a SECOND app beside the old.
  assert.equal(top('appId'), 'in.munderdiffl.app');
  assert.doesNotMatch(builder, /^\s+guid:/m, 'nsis.guid would replace the appId-derived GUID');
});

// The Human (2026-10-03, second ruling): the exe and the data folder DO become Guppy. Andy's branch
// (rebrand/a) makes that change; until it is merged into a 1.1.82 tree these two are skipped, and
// from version 1.1.82 on they are mandatory (no skip).
const pkg = JSON.parse(read('package.json'));
const atLeast182 = (() => { const [a, b, c] = pkg.version.split('.').map(Number); return a > 1 || (a === 1 && (b > 1 || (b === 1 && c >= 82))); })();
const untilRebrandA = (t) => { if (!atLeast182 && top('productName') === 'Munder Difflin') { t.skip('rebrand/a not merged yet; mandatory from 1.1.82'); return true; } return false; };

test('the app is Guppy: productName and the exe name', (t) => {
  if (untilRebrandA(t)) return;
  assert.equal(top('productName'), 'Guppy');
  // executableName defaults to productName; if set, it must say Guppy too.
  assert.equal(top('executableName') ?? top('productName'), 'Guppy');
  assert.match(read('src/main/heavyJob.ts'), /bin === 'guppy'/, 'the heavy-lock classifier knows the new exe as a node runner');
});

test('the data folder is Guppy (1.1.81 data copied there once, never moved)', (t) => {
  if (untilRebrandA(t)) return;
  // Either a productName in package.json (Electron's app name, so userData = %APPDATA%\Guppy) or
  // an explicit userData path ending in Guppy.
  const index = read('src/main/index.ts');
  const viaPackage = pkg.productName === 'Guppy';
  const viaPath = /setPath\(\s*'userData'[^\n]*'Guppy'/.test(index);
  assert.ok(viaPackage || viaPath, 'userData must resolve to a Guppy folder');
});

test('the munderdifflin:// scheme and the hire format id stay', () => {
  // Hire links people have already shared, and manifests already written.
  assert.match(builder, /^\s+schemes:\s*\n\s+- munderdifflin\s*$/m);
  assert.match(read('src/main/index.ts'), /setAsDefaultProtocolClient\('munderdifflin'\)/);
  assert.match(read('src/shared/hire.ts'), /protocol !== 'munderdifflin:'/);
  assert.match(read('src/shared/hire.ts'), /HIRE_SPEC_V1 = 'munder-difflin\/hire@1'/);
});

test('markers in files 1.1.81 already wrote on the machine stay byte-identical', () => {
  const hive = read('src/main/hive.ts');
  // Only AGY agent files containing this mark are updated or removed: a new wording orphans them.
  assert.match(hive, /AGY_AGENT_MARK = 'Written by the Munder Difflin app'/);
  // Codex config blocks are found again by these exact headers.
  assert.match(hive, /# --- munder-hive: this agent's standing hive instructions/);
  assert.match(hive, /# --- munder-hive lifecycle hooks/);
  assert.match(read('src/main/codexAgentConfig.ts'), /# --- munder-hive: per-agent token limits/);
  // AGY and Grok hook groups, agent-file names, the extension, the MCP server.
  assert.match(hive, /existing\['munder-hive'\] = group/);
  assert.match(hive, /join\(hookDir, 'munder-hive\.json'\)/);
  assert.match(hive, /n\.startsWith\('munder-'\)/);
  assert.match(hive, /name: 'munder-hive-bridge'/);
  assert.match(read('src/main/codexHookMcp.ts'), /MCP_SERVER_NAME = 'munder_hooks'/);
  assert.match(read('src/main/agyStatuslineOwnership.ts'), /'\.munder-statusline-owner\.json'/);
  // The hook pipe a running hive's shims connect to.
  assert.match(hive, /\\\\\\\\\.\\\\pipe\\\\munder-difflin-\$\{/);
});

test('MUNDER_* env names stay (the app and the shipped CLIs move in lockstep)', () => {
  const wiring = read('src/main/nativeMemory/mainWiring.ts');
  const cli = read('resources/memory-cli.cjs');
  for (const name of ['MUNDER_HIVE_ROOT', 'MUNDER_MEMORY_URL']) {
    assert.ok(wiring.includes(name), `${name} injected by the app`);
    assert.ok(cli.includes(name), `${name} read by memory-cli.cjs`);
  }
  assert.match(read('src/main/codexScreenGuard.ts'), /WAKE_INCARNATION_ENV = 'MUNDER_WAKE_INCARNATION'/);
  assert.match(read('src/main/devIsolation.ts'), /process\.env\.MUNDER_DEV === '1'/);
});

test('1.1.82 keeps the Munder-Difflin artifact names (1.1.81 builds its download link from them)', () => {
  // src/shared/updateState.ts installerUrl in 1.1.81 hard-codes these. Rename them only in a
  // release after one whose installerUrl knows the new names (planned: 1.1.83).
  for (const name of ['Munder-Difflin-${version}-win-x64-setup.exe', 'Munder-Difflin-${version}-win-x64-portable.exe', 'Munder-Difflin-${version}-mac-${arch}.${ext}', 'Munder-Difflin-${version}-linux-x86_64.AppImage']) {
    assert.ok(builder.includes(`artifactName: ${name}`), name);
  }
});
