# LOAD-FLAKES-176: the renderer half (Jim)

Both flakes are on the harness side. Neither is a product bug: the product's sampler starts at app start (`index.ts` `startRendererMemorySampler`) and does not depend on a renderer 'ready'. Creed's helper claims were checked against the code and the measurements before any fix.

## 1. app-recovery-harness RENDERED (:12): "harness timed out"

- **Root cause:** `harness-main.cjs` had ONE timer covering setup and the scenario. Setup means esbuild bundling the real App, `loadFile`, and `executeJavaScript` of the bundle, which is 57.9 MB with the inline sourcemap. On a saturated CPU, setup alone used up the scenario's 150 s before `__harnessRun()` started.
  - Idle measurements: bundle 0.8 s, eval 1.0 s, 3.7 s in all with the map; 17.4 MB and 2.7 s without it.
- **Fix:**
  - Setup has its own guard (`--setup-timeout`, default 300 s). Its error names the phase: `harness setup timed out after N ms in phase bundle|load|eval (the scenario never started)`.
  - The scenario's `--timeout` starts right before `__harnessRun()`. Its error reports how long setup took.
  - The inline sourcemap is off unless `HARNESS_SOURCEMAP=1`, which cuts the bundle to 17 MB and makes the eval about 2.4× faster.
  - `run.cjs` exports `HARNESS_SETUP_TIMEOUT_MS` and `harnessTestTimeout(scenarioMs) = setup + scenario + 60 s`. The node:test timeouts of app-recovery, both impact-loop-171 tests and models-refresh-173 use it, so the harness's named error always wins over node's generic timeout.

## 2. renderer-memory-recovery-harness (:36): FROZEN, "timed out waiting for ready"

- **Root cause:** a race inside the page. On mode 'hog' the page did two things in parallel:
  - it sent `page:ready` only after a SECOND round trip (`invoke('page:notice')`);
  - it armed its own 50 ms timer, which froze the renderer forever.

  When main answered `page:notice` later than about 50 ms (a loaded machine), the freeze won, 'ready' was never sent, and main's `waitFor('ready')` timed out after 600 s. Creed's gate reproduced this (round 3/b, 605.9 s).
- **Fix:**
  - The page no longer freezes on its own timer. It freezes only when main sends `page:hog`, which main does after it has received 'ready' and started the sampler. So 'ready' always comes before the freeze.
  - A new seam, `--notice-delay-ms`, answers `page:notice` late. The test passes 500 ms on EVERY run, so each run takes the order that froze the old page. The old page freezes deterministically under that delay (the proof script is `t12/rr/mem-proof.sh`).

## Tests

- `test/load-flakes-176-renderer.test.cjs` holds:
  - source-order pins for both fixes: eval, then the scenario timer, then the run; and ready, then the sampler, then `page:hog`, with no self-timed freeze;
  - the timeout arithmetic and its wiring;
  - one behaviour run: a 1 ms setup guard fails with the named phase and never reports a scenario timeout.
- 5 of 5 pass.
