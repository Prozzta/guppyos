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

## Rev 2 (Andy's audit `RESOLVER-AUDIT.md`: C1, C2, R2, the Setup nits; god 017bc2)

- **C1: "unknown" means "no answer", not only "the box fired".**
  - **win32:** a miss is ONLY an answer from `where`: it ran (listed nothing usable), or it exited 1 ("could not find"). Everything else is `unknown`: our box, `where` exit 2, a spawn error (EAGAIN/ENOMEM), a synchronous exec throw (EMFILE), and a foreign signal (`whereAnswered`).
  - **POSIX:** only a shell that printed both fences answered. No fence (the box, a shell that could not start, one that died) is `unknown`.
  - **`CommandResolver`:** a THROWN lookup is `unknown` (retried once, never cached), not a miss. The lookups never throw for a bad name; they return a miss.
- **C2: the lossy `cmd.exe` route.** `PtyManager.spawn` refuses an UNRESOLVED bare name (the lookup gave no answer) when an argument contains a newline, with the retryable reason. Such an agent would start looking healthy without its hive protocol (Andy's probe: `cmd.exe /d /s /c` kept only line one). It is the one guard at the one place, so it also covers `noAutoInstall` relaunches.
- **R2: the decisions are a pure module.** `src/main/cliLookupPolicy.ts` holds `cliStatus`, `missingCliAction`, `npmRungDecision`, `headlessSpawnRefusal`, `daemonExecutable`, `toolRowStatus`, `lossyRouteRefusal`, and the shared reason. These are tested as behaviour. `index.ts` (five sites) and `pty.ts` call them, with one pin per call site.
- **Setup panel nits:**
  - an unknown row shows "Could not check (the machine was busy). Close and reopen this panel to check again." instead of the install command;
  - it is not counted in "recommended missing" or in Michael's install seed.
- **LOAD-FLAKES REFUSES (agreed with Creed, taken off his branch):**
  - `test/tools/codex-resolve-probe.cjs` resolves with the product's own `CommandResolver` and lookup through `whereTimeoutMs: 60_000`, so a loaded machine cannot fire the 3 s box in the preflight fixture. The app's box is unchanged.
  - The probe line also reports `unknown`.
  - The 0.156.0 test now also asserts `found`, `!unknown` and `version`, which closes its vacuous pass.
  - One pin checks the seam.
- **R1 (POSIX `userShellPathAsync` caches a timed-out PATH fallback):** left on the card as a follow-up, as god ruled. Windows is unaffected.
- **N3 (from Andy):** under sustained load the one retry doubles the wait for an unknown: 3 s each, plus up to the tree-kill bound. That is accepted; a spawn waits at most about 2 × 14 s.
- **Separate card (reported to god):** the same lossy `cmd.exe` route is reached by a FOUND target that `resolveWindowsShimSpawn` cannot decode (a hand-written `.bat`, or a non-npm shim) with a multi-line argument. That is pre-existing and outside this fix: it only warns in the console.

- **Rev 2 full suite (b6bf9a1):** 3202 tests, 3186 pass, 0 fail, 16 skipped, 130 s. Mutants: 19 of 19 KILLED at named tests.

## Rev 3 (Andy Round 2: C3; god 1a44a1: fix the class at the root, LOSSY-CMD-ROUTE folded in)

- **One rule** (`lossyRouteRefusal`, called once in `PtyManager.spawn` right before `buildCmdCommandLine`):
  - ANY spawn that would take `cmd.exe /d /s /c` with an argument containing `\n` (so CRLF too) is refused before a session or process exists, whatever the reason.
  - The reason says which cause it is:
    - **retryable** (`engine CLI "<x>" could not be checked: ... retry the spawn`): the command's lookup gave no answer (C2), OR the npm shim's INTERPRETER lookup gave no answer (C3, which names `node`);
    - **not installed**: the lookup answered "absent";
    - **unsupported launcher** (`... is an unsupported launcher for a multi-line argument: <path> can only start through cmd.exe ...`): a FOUND `.cmd`/`.bat` that `resolveWindowsShimSpawn` cannot decode, such as a hand-written `.bat` or a shim that is not from npm (LOSSY-CMD-ROUTE). This one is not retryable.
  - Single-line arguments keep the `cmd.exe` route unchanged.
- **C3 plumbing:** `resolveWindowsShimSpawn(resolved, seen)` records `seen.unknownInterpreter` when the interpreter lookup is `unknown`. It still returns null on every failure, so the decode contract is unchanged, and `spawn` passes the recorded value to the rule.
- **Warning cleanup:** the old "A MULTI-LINE ARGUMENT ... WILL BE TRUNCATED" console warning can no longer be reached. The fallback warning now says that only single-line arguments get there.
- **Tests (PtyManager.spawn, win32, fixture npm shim and a hand-written .bat in a temp dir):**
  - one test per cause: C2 (an unresolved name), C3 (a found npm `claude.cmd` whose `node` lookup is unknown), and LOSSY-CMD-ROUTE (a found hand-written `.bat`);
  - a single-line control: the same `.bat` still starts through `cmd.exe`;
  - the policy behaviour test covers all the reasons, including CRLF;
  - one wiring pin covers the call site, and one pins the interpreter report.
- **Andy's nit on M15:** the Setup-row assertions are now their own test, `policy: the Setup row ...`, and M15 is named there.
- **Mutants (rev 3):** 25 of 25 KILLED at named tests (`t12/resmut3.cjs` + `resmut3-extra.cjs`; results `resmut3.txt`).

## Rev 3.1 (Andy Round 3: product PASS; T1 + N1, god aa7240)
- **T1 (test-only):** the SPAWN control's real `cmd.exe` now runs in `os.tmpdir()`, not in the fixture dir it locked. Its exit is awaited with `killAllAsync`. Each fixture removal is isolated and retried (`rmSync` `maxRetries`), so one EBUSY can no longer fail the file or leak later dirs. The 33 leaked `lossy-rule-*` dirs in %TEMP% are removed. Two consecutive runs: 89 of 89 pass and 0 new dirs leak.
- **N1:** `resolveWindowsShimSpawn` now reports WHY the npm shim's interpreter could not be used (`unknown` / `missing` / `not-exe`). A real npm `claude.cmd` whose `node` is a known miss, or only a `.cmd`, now says `engine CLI "claude" needs its interpreter "node", which is not installed: install node ...`. It no longer says "unsupported launcher ... install the CLI with npm". An unknown `node` is still retryable. A new PtyManager.spawn test covers N1, and the policy test covers `missing` and `not-exe`.
