# Layer B source-pin map

`layer-b-run.cjs` is now a compatibility entry.  Source pins resolve the orchestration module via
`primaryLayerBSource()` and AST-wide pins enumerate `layerBSources()`; this is the one-for-one map
from the former monolith.

| Former source pin | Current target | Coverage retained |
| --- | --- | --- |
| `layer-b-runner-static.test.cjs` source/AST pins | `layer-b-core.cjs` via `primaryLayerBSource()` | W mutations, hidden spawns, launch/teardown, jail, credentials, caps, evidence, CLI flow |
| `layer-b-runner-static.test.cjs` whole-file AST pins | entry + core + every `layer-b/*.cjs` via `layerBSources()` | direct disk mutation and `windowsHide` on every spawn |
| `layer-b-b8-stub.test.cjs` | core via `primaryLayerBSource()` | B8 DOM/inbox/teardown wiring |
| `layer-b-codex-argv.test.cjs` | core via `primaryLayerBSource()` | Codex argv and launch sequencing |
| `layer-b-codex-resolve.test.cjs` | core via `primaryLayerBSource()` | product resolver probe and preflight wiring |
| `layer-b-git-env.test.cjs` | core via `primaryLayerBSource()` | jailed git environment and evidence wiring |
| `layer-b-jail-links.test.cjs` | core via `primaryLayerBSource()` | link gate, defaults, listing and compare wiring |
| `layer-b-trust-runner.test.cjs` | core via `primaryLayerBSource()` | trust seed and PTY input-capture wiring |
| `layer-b-powershell.test.cjs` | compatibility entry exports from core | real encoded PowerShell watcher and process-scan behavior |
| `own-procs-pid-recycle.test.cjs` PPID/CreationDate pin | `layer-b-core.cjs` by explicit source key | process-tree walks remain CreationDate-checked |
| `rebrand-a-182.test.cjs` packaged-path canary | `layer-b-core.cjs` by explicit source path | Guppy/Munder live paths and product-name matchers |
| `layer-b-runner-static.test.cjs` absence pins | entry + core + every `layer-b/*.cjs` via `layerBSources()` | no `--force`, fixed port, `sandbox windows`, Codex bypass, or PowerShell `-Command` in an extracted helper |
| `layer-b-codex-argv.test.cjs` tools census | every `test/tools/*.cjs` except its explicit compatibility/repro exclusions | now also scans `layer-b-core.cjs` |
| `tools/codex-exit-repro.cjs` | compatibility entry exports from core | retained consumer of the public Layer B API |
| PTY input helper | `layer-b/pty-input.cjs` in `layerBSources()` | behavior through entry exports plus whole-module AST pins |
| Run-bar helper | `layer-b/run-bar.cjs` in `layerBSources()` | behavior through entry exports plus whole-module AST pins |

Runtime/behavior tests continue to require `layer-b-run.cjs`, proving the compatibility entry exports
the same public API.  The entry itself is still covered by the all-module AST inventory.
