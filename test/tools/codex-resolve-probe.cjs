'use strict';
/**
 * god R1 (Jim's real-mode sweep): the ZERO-TOKEN real-run preflight's child. The runner starts this
 * file hidden with env = its JAILED app env (exactly what the app gets), because the product's
 * resolver reads process.env (PATH, PATHEXT, APPDATA, LOCALAPPDATA, USERPROFILE).
 *
 * It runs the PRODUCT's own code, loaded from src/ (test/load-ts.cjs), exactly as index.ts:803-806
 * codexCliNow does for a Codex spawn:
 *   path    = PtyManager.prototype.commandPath('codex')   (src/main/pty.ts:500-503) over the
 *             app-wide commandResolver (src/main/commandResolver.ts: where.exe hidden, then the
 *             %APPDATA%\npm / %LOCALAPPDATA% candidates)
 *   version = readCodexVersion(path)      (src/main/codexCli.ts:46: reads @openai/codex/package.json;
 *             codexCli.ts imports only node:fs and node:path, so it starts no process)
 *   noDaemon = codexSupportsNoDaemon(version)
 * and prints ONE JSON line { path, found, version, noDaemon }. It never starts codex.
 */
const loadTs = require('../load-ts.cjs');

(async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const { CommandResolver, nodeResolverDeps } = loadTs('src/main/commandResolver.ts');
  const { readCodexVersion, codexSupportsNoDaemon } = loadTs('src/main/codexCli.ts');
  // PtyManager.commandPath resolves through `this.resolveCommand`, i.e. `this.resolver.resolve`
  // (pty.ts:500-517). Its constructor is not needed for a lookup, so the product method is called
  // on an object that carries only that. RESOLVER-TIMEOUT-MISS (LOAD-FLAKES REFUSES): the product's
  // own resolver and lookup, with the `whereTimeoutMs` seam at 60 s, so a loaded machine cannot
  // turn this preflight's answer into "the 3 s box fired" (the app's box is unchanged).
  const self = Object.create(PtyManager.prototype);
  self.resolver = new CommandResolver({ deps: () => ({ ...nodeResolverDeps(), whereTimeoutMs: 60_000 }) });
  const resolved = await self.resolver.resolve('codex');
  const path = await PtyManager.prototype.commandPath.call(self, 'codex');
  const version = readCodexVersion(path);
  process.stdout.write(`${JSON.stringify({ path, found: path !== null, unknown: resolved.unknown === true, version, noDaemon: codexSupportsNoDaemon(version) })}\n`);
})().catch((e) => { process.stdout.write(`${JSON.stringify({ error: String(e && e.stack || e) })}\n`); process.exitCode = 1; });
