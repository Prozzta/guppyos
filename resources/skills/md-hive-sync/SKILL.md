---
name: md-hive-sync
version: 1.1.0
description: |
  Munder Difflin hive sync — runs the start-of-task hive protocol steps:
  reads your standing lessons, recalls memory with `memory wake-up` /
  `memory search` / `memory get`, handles the hive mail in your context, and
  reminds you where to record durable facts before ending.
  Use when asked to "sync with the hive", "check my inbox", "hive status",
  or "hive sync".
  Proactively suggest at the start of a new task if you haven't synced with
  the hive in this conversation. (munder-difflin)
allowed-tools:
  - Read
  - Bash
---

## Hive Sync

Run the hive start-of-task steps. Your start-up prompt's HIVE PROTOCOL and
`$HIVE_ROOT/PROTOCOL.md` are the authority; where they differ from this skill,
follow them.

1. **Recall memory.**
   - On a claims-ledger floor (the default for new floors; your start-up prompt
     says "claim-ledger writer"): run `memory wake-up` for your current claim
     working set and standing lessons.
   - Otherwise: read the `## How I work (standing lessons)` section at the top of
     `$AGENT_DIR/memory.md` and follow it, then run `memory wake-up` for a digest
     of your memory.
   - Then `memory search "<query>"` for anything specific, and
     `memory get <key|card-id>` for the current value of a key or card.
   - Do NOT read `$AGENT_DIR/memory.md` whole. If you must open it, read only its
     last ~40 lines; older notes are in `memory-archive-*.md` and
     `memory search` covers them.

2. **Handle mail.** Messages for you arrive inside your context as a
   `<hive-mail>` block; the harness tracks them. Do not read, list or move
   inbox files. If a message is marked re-delivered, check whether you already
   handled it. (Only if your start-up prompt tells you to read the files in
   your inbox, do that, exactly as it says.) Mail handling is defined by the
   current protocol text, not by your memory: do not record mail-handling
   rules in memory.md.

3. **Report** — summarize what you recalled and any new mail. Note any tasks
   assigned to you or information relevant to the current session.

4. **End-of-task reminder** — before closing, record what you learned:
   - On a claims-ledger floor: use `memory note` (`--kind lesson` for method
     lessons, `--key card.<card-id>` for a card's notes; replace a changed fact
     with `memory note --supersedes ID --reason changed|corrected|moved`). Do not
     write new facts into memory.md.
   - Otherwise: append durable facts, decisions and outcomes to the end of
     `$AGENT_DIR/memory.md`, and method lessons to its
     `## How I work (standing lessons)` section.
   - To message another agent, write ONE message JSON into `$AGENT_DIR/outbox/`
     (schema in PROTOCOL.md). To update a card, send a message and note memory
     in one call, use the `ledger` command (PROTOCOL.md "The ledger command").

`$AGENT_DIR` is your private workspace and `$HIVE_ROOT` the shared hive; both are
set in your environment.
