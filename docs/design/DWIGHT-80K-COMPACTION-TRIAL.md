# Dwight 80K auto-compaction trial (Stage 1b)

## Scope and activation

`RegistryAgent.codexAutoCompactTokenLimit` is an optional, per-agent setting. Only integers in
the inclusive 40K--200K range are accepted; unset, malformed, and out-of-range values retain the
120K fleet default and produce one `codex-compact-limit-ignored` log row at spawn. On the next
spawn, the accepted value is written only to that agent's
generated `agents/<id>/.codex/config.toml`; the user's `~/.codex/config.toml` is read as a seed
and never written. The trial does not change Dwight's model (terra).

`registry.json` is frequently read-modify-written by the main process, so activation is only safe
while the app is fully stopped. God stops Munder Difflin, sets
`agents["dwight-mu32ztys"].codexAutoCompactTokenLimit` to `80000`, saves the registry, and then
starts the app. Before starting the measurement clock, confirm the regenerated file contains
exactly `model_auto_compact_token_limit = 80000`:

```powershell
Select-String -LiteralPath C:\Dunder\hive\agents\dwight-mu32ztys\.codex\config.toml -Pattern '^model_auto_compact_token_limit = 80000$'
```

Remove the field while the app is stopped and restart Dwight to restore 120K. This is an
operator/registry setting, not a hard-coded source exception or global Settings change.

## Measurement

After at least three complete, clean local (UTC+2) shipped days on each side, run:

```powershell
node tools/measure-dwight-80k-compaction.cjs --before 2026-09-29 --before 2026-09-30 --before 2026-10-01 --after 2026-10-03 --after 2026-10-04 --after 2026-10-05 --quality-before before-quality.json --quality-after after-quality.json
```

The wrapper reuses Andy's `C:/Dunder/_work/andy-scratch/owncon/fleet.cjs` (override with
`--fleet` or `FLEET_SCRIPT`) and fails if a selected date has no shipped row, contains an app
restart, or differs in model, Codex CLI version, or app build. It reports each day's exact
per-request median/p90 and total tokens per started turn across all requests, including observed
compaction requests. Do not use 2026-09-28 for baseline: its 01:06--03:02Z hold and 1.1.70--1.1.72
restart windows make it non-comparable.

## Quality check

For comparable before/after task samples, record only task IDs/outcomes in small JSON files:

```json
{"reviewed":10,"accepted":9,"reworked":1,"failed":0,"notes":["TASK-123: accepted"]}
```

Pass them with `--quality-before` / `--quality-after`, using comparable task mixes. The wrapper
validates the counts and reports accepted/reworked/failed rates next to token metrics. Stop the
trial and remove the field if corrective rework or failures rise materially, even if input tokens
decline.
