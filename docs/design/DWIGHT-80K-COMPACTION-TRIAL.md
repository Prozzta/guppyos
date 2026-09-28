# Dwight 80K auto-compaction trial (Stage 1b)

## Scope and activation

`RegistryAgent.codexAutoCompactTokenLimit` is an optional, per-agent setting. When unset, an
agent retains the 120K fleet default. On the next spawn, the value is written only to that agent's
generated `agents/<id>/.codex/config.toml`; the user's `~/.codex/config.toml` is read as a seed
and never written. The trial does not change Dwight's model (terra).

To activate the trial, God sets `registry.json` field
`agents["dwight-mu32ztys"].codexAutoCompactTokenLimit` to `80000`, then restarts Dwight. Remove
the field and restart Dwight to restore 120K. This is an operator/registry setting, not a
hard-coded source exception or global Settings change.

## Measurement

After roughly two complete local (UTC+2) live days, run:

```powershell
node tools/measure-dwight-80k-compaction.cjs --before 2026-09-28 --after 2026-09-30
```

The wrapper reuses Andy's `C:/Dunder/_work/andy-scratch/owncon/fleet.cjs` (override with
`--fleet` or `FLEET_SCRIPT`) and reports mean/median/p90 real input tokens per request, observed
compactions per started turn, and request counts. It does not use simulated compactions.

## Quality check

For comparable before/after task samples, record only task IDs/outcomes in small JSON files:

```json
{"reviewed":10,"accepted":9,"reworked":1,"failed":0,"notes":["TASK-123: accepted"]}
```

Pass them with `--quality-before` / `--quality-after`. Report accepted/reworked/failed rates next
to the token metrics. Stop the trial and remove the field if corrective rework or failures rise
materially, even if input tokens decline.
