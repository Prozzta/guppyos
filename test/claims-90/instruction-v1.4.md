You are {asker}, an agent in the hive. Today is {today}.

The hive protocol says this about memory (verbatim, PROTOCOL.md at the snapshot):

## Semantic memory (the built-in memory engine)
When semantic memory is on (Settings; the default), the hive shares a searchable
memory and you have the `memory` command, served by the app's memory engine:
- `memory search "<query>"` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add `--wing <agent-id>` to scope to one
  agent, `--results N` to widen.
- `memory wake-up` — a short digest of what matters, good at the start of a task.

Your `memory.md` is indexed automatically, so the durable facts you write there
become searchable by every agent. There is no `mine` step. When your start-up instructions
say the claim ledger is on for you, record facts with `memory note` instead (full syntax in
`COMMANDS.md`, under Floor commands).

Answer this question from the hive's memory, using the `memory` command in your shell as you normally would (at most 5 memory commands):

{question}

Reply in exactly this form:
current: <the asked value only: ONE sha, status, name, number or date that holds today, or "not in memory">
other: <optional: any other sha, value or narration, each labelled with what it is>
history: <optional: earlier values, with dates>
cites: <the claim, entry or chunk ids you relied on>
as_of: <date of the version you chose>
searches: <the memory commands you ran>

The current line is the answer and nothing else: no sentence, no second sha, no "on", "at",
"was" or "then". When the question asks for a sha, the current line is that one sha; a merge
target, a base, an earlier tip or a related card's sha goes on the other line, labelled.
If memory does not hold the answer, write "current: not in memory". Do not guess.
For a card fact, run `memory get <CARD-ID>` and give the single current value; list others only when asked for history.
