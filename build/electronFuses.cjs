// ELECTRON-FUSES (1.1.105): the fuses of the packaged Guppy binary, flipped in afterPack.
// electron-builder 26 has an `electronFuses` option, but the hook is kept because the inspect fuse
// depends on the build env (MUNDER_LAYERB_SEAMS). It flips them with @electron/fuses. On 26.18.0
// PlatformPackager.doPack embeds the Windows asar integrity resource (beforeCopyExtraFiles), copies
// extra files, runs afterPack (this hook), then sanityCheckPackage, doAddElectronFuses (a no-op with
// no electronFuses config) and doSignAfterPack: the fuses are flipped after the integrity data is in
// the exe and before any signature is made.
//
// Every fuse @electron/fuses 1.8.0 knows is set explicitly; one that stays ON says which call site
// relies on it. Electron 45's ninth fuse, WasmTrapHandlers, is newer than 1.8.0 (only the ESM-only,
// Node 22 2.x knows it), so it keeps Electron's default: on. test/electron-fuses.test.cjs asserts it.
'use strict';
const path = require('path');

/** The layer-(b) seams build (MUNDER_LAYERB_SEAMS=1), by the same rule electron.vite.config.ts
 *  uses to compile the seams in: a trial build never carries them. */
function isLayerBSeamsBuild(env = process.env) {
  return env.GUPPY_TRIAL_BUILD !== '1' && env.MUNDER_LAYERB_SEAMS === '1';
}

/** The fuse state for a build, by @electron/fuses option name. */
function fuseState(env = process.env) {
  return {
    // ON, relied on (a KNOWN, ACCEPTED limit: anyone who can run Guppy.exe can run it as Node).
    // Guppy runs its own binary as Node: the hive-node launcher and the hive command wrappers
    // (src/main/hive.ts writeNodeLauncher, writeCommandDir), the bin/runtime node shim
    // (hive.ts writeRuntimeShims), the proxy bridge (hive.ts startProxyBridge) and the heavy-job
    // helper (resources/heavy-preload.cjs, it respawns process.execPath).
    RunAsNode: true,
    // ON, relied on: the heavy-job lock rides on NODE_OPTIONS (src/main/ptyEnv.ts appends
    // --require heavy-preload.cjs to every hive agent's NODE_OPTIONS), and a node an agent runs
    // through hive-node or the runtime shim IS this binary. Off, those processes would silently
    // skip the lock. The fuse also gates NODE_EXTRA_CA_CERTS (users behind a corporate CA).
    EnableNodeOptionsEnvironmentVariable: true,
    // OFF in a normal build: nothing in the product passes --inspect. ON only in the layer-(b)
    // seams build: test/tools/layer-b-core.cjs (launch, `--inspect=127.0.0.1:<port>`) drives the
    // packaged main process over that inspector.
    EnableNodeCliInspectArguments: isLayerBSeamsBuild(env),
    // ON, relied on: the main window and the Blob are loaded from file:// as module bundles
    // (src/main/index.ts win.loadFile(renderer/index.html), w.loadFile(renderer/blob.html)).
    GrantFileProtocolExtraPrivileges: true,
    // ON: electron-builder embeds the asar integrity data (Windows resource / macOS Info.plist);
    // the app refuses an app.asar whose header does not match.
    EnableEmbeddedAsarIntegrityValidation: true,
    // ON: the app loads only from app.asar (asar is on; nothing loads resources/app or default_app).
    // Scripts run as Node by path (RunAsNode above) are not affected.
    OnlyLoadAppFromAsar: true,
    // OFF (default): no browser-process V8 snapshot.
    LoadBrowserProcessSpecificV8Snapshot: false,
    // OFF (default; ELECTRON-FUSES ruling 2026-11-11): encrypting cookies is one-way; nothing asks for it.
    EnableCookieEncryption: false
  };
}

/** The packaged executable of an afterPack context. */
function executablePath(context) {
  const name = context.packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case 'darwin':
    case 'mas':
      return path.join(context.appOutDir, `${name}.app`);
    case 'win32':
      return path.join(context.appOutDir, `${name}.exe`);
    default:
      return path.join(context.appOutDir, context.packager.executableName);
  }
}

/** Flip the fuses of the packaged binary. */
async function flipElectronFuses(context, env = process.env) {
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  const state = fuseState(env);
  // Not strictlyRequireAllFuses: it demands all 9 of Electron 45's fuses and 1.8.0 can write 8.
  // fuseState names every fuse 1.8.0 knows (the test checks that), and the test pins the wire length.
  const config = { version: FuseVersion.V1 };
  for (const [name, on] of Object.entries(state)) {
    if (FuseV1Options[name] === undefined) throw new Error(`@electron/fuses has no fuse ${name}`);
    config[FuseV1Options[name]] = on;
  }
  // An unsigned macOS build must still start after its binary changed: re-sign it ad hoc. A real
  // signature is made afterwards by electron-builder's sign step.
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') config.resetAdHocDarwinSignature = true;
  const exe = executablePath(context);
  await flipFuses(exe, config);
  console.log(`  • electron fuses: ${Object.entries(state).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' ')}`);
}

module.exports = { fuseState, isLayerBSeamsBuild, executablePath, flipElectronFuses };
