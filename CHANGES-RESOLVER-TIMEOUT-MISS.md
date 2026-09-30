# RESOLVER-TIMEOUT-MISS (1.1.76): a timed-out command lookup is UNKNOWN, not "not installed"

Branch `fix/176-resolver-timeout-unknown`, on top of `fix/176-codex-nodaemon-hardening` (6ab65753), since both touch `index.ts`.
Builder: Jim. Auditor: Andy. Card: RESOLVER-TIMEOUT-MISS. Verdict and caller map: `_work/loadflakes-mf4-refuses.md`, the "Verdict" section.
The Human decides on ASK ME whether this goes into 1.1.76.

## The defect (v1.1.75)
- Under CPU load, the resolver's 3 s `where` (win32) or login-shell `which` (POSIX) is killed by its time box.
- `lookupCommandAsync` answered `found:false`, exactly like a real miss, and `CommandResolver` cached it for 60 s.
- On PATH-only installs (nvm-windows, custom npm prefix) no install-dir candidate rescues the lookup. Every caller then acted on the false answer:
  - the missing-CLI path RAN THE INSTALLER (`npm install -g …`) in the agent's pty;
  - the headless spawn refused with "not installed";
  - codex lost `--no-daemon` (6ab65753 already fails closed there);
  - the Setup panel said MISSING.

## The change
- **`commandResolver.ts`:**
  - **Timeout means unknown.** A lookup whose run was ended by the box (`err.killed`), with no candidate match, returns `{ found:false, unknown:true }` (`ResolvedCommand.unknown`). A real `where` exit 1 is still a plain miss.
  - **Retry once, never cache.** `CommandResolver.resolve` retries an unknown ONCE at once (concurrent callers share the lookup and its retry). An answer that is still unknown is returned as unknown and **never cached**. Real misses are cached as before.
  - **The time box is a seam.** `ResolverDeps.whereTimeoutMs` (default `LOOKUP_TIMEOUT_MS` = 3000) replaces the four hard-coded 3000s: `where`, the login shell, and both halves of `resolveCliAsync`.
  - **Shell timeouts are detected.** `captureFenced` is the timeout-aware form of `captureFromLoginShellAsync`, whose signature and behaviour are unchanged.
- **`pty.ts`:** new `commandStatus(cmd)`, which returns `'found' | 'missing' | 'unknown'`. `isCommandAvailable` and `commandPath` are unchanged (unknown is not found, and the path is null).
- **`index.ts`, the callers:**
  - **Spawn missing-CLI check** (`spawnAgentCore`): the installer runs ONLY on `missing`. On `unknown` the spawn proceeds (a truly absent CLI then fails visibly) and a `cli-lookup-unknown` row is logged. It never runs `npm install -g` over an install.
  - **npm/node rung probe:** an unknown npm or node keeps the npm rung, so the app never downloads Node over what may be a working one.
  - **Headless spawn** (spawn requests): an unknown refuses with a DISTINCT, retryable reason: `engine CLI "<bin>" could not be checked: its lookup timed out (machine under load); retry the spawn`. It never says "not installed".
  - **Codex daemon start** (codex remote): an unknown lookup returns false (local TUI) instead of running a bare name.
  - **Setup catalog** (`tools:status`): the row carries `unknown: true`, and `SetupPanel` shows NOT CHECKED. Reopening re-checks, because unknown is never cached.
- **Covered without a caller change:**
  - `hiddenClaude`: its bare name runs through cmd.exe, which finds it on PATH; the gain is that unknown is no longer cached.
  - `codexCliNow` at spawn and app start: a null version keeps `--no-daemon` via 6ab65753's gate.
  - `pty.ts` shim decode: a miss falls back to cmd.exe, which is harmless.
  - `resolveCliAsync` (models refresh): uncached; one refresh reports no CLI, and the next one retries.
  - The onboarding wizard's "is not installed … press check again": check again re-checks.

## Tests
- **New `test/resolver-timeout-unknown-176.test.cjs`** (15 tests, all fakes, no real `where`, shell or npm):
  - lookup: win32 timeout gives unknown; exit 1 gives a miss; a candidate rescues a timeout; POSIX timeout gives unknown and a shell failure gives a miss; the seam and the default box (also `resolveCliAsync`);
  - resolver: retry once; unknown is never cached; a miss is still cached and a throw is still a miss; concurrent callers share one lookup and one retry; end to end with a hung fake `where`;
  - `commandStatus` is tri-state;
  - wiring pins: installer only on missing, npm rung on unknown, the headless distinct reason, the daemon start, the catalog and the panel.
- **Updated pins, same intent, new call sites:**
  - `sync-child-calls-173`: a timed-out lookup is unknown; the checks use `commandStatus`; the codex-remote line;
  - `command-name-validation`: the guard precedes `captureFenced` and `commandStatus`.

## Mutants: 14 of 14 killed
Script `agents/jim-mtujpe28/t12/resmut.cjs`, results `resmut.txt`.
- **M1-M9, behavioural:**
  - win32 and POSIX timeouts never unknown; no retry; unknown cached;
  - `timedOut` ignoring `killed`, or treating every failure as a timeout;
  - the seam ignored; `resolve` dropping `unknown`; `commandStatus` mapping unknown to missing.
- **M10-M14, wiring:** installer on "not found"; headless "not installed" on unknown; unknown npm counted as missing; the daemon running a bare name; the catalog dropping unknown.
- **Stated limit:** `index.ts` cannot be loaded in a test, so M10-M14 are killed by source pins, not by behaviour.

## Suite
Targeted (the three resolver files, plus `layer-b-codex-resolve` and `cli-install-ladder`): 71 of 71 pass. Typecheck: node and web, clean. Full suite on a quiet machine @ f2908d6: **3178 pass, 0 fail, 16 skipped** (3194 tests, 158 s).

## For Creed's fixture (REFUSES 0.158.0)
The probe can now build a `CommandResolver({ deps: () => ({ ...nodeResolverDeps(), whereTimeoutMs: 60_000 }) })` and set `self.resolver` to it. The box then never fires, and the retry wrapper can go.
