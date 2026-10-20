# Guppy v1.1.96

**A local hive of Claude Code, Antigravity, Codex, Gemini, Cursor, Grok & Copilot agents that run themselves.**
Messaging, routing, and remembering, coordinated by your clone, Michael. Local-first and open source.

### → [**Guppyos on GitHub**](https://github.com/Prozzta/guppyos)

---

## What's new in 1.1.96

**Heavy jobs are counted where they really run, and god's screen reading survives a busy start.**
Rollback: reinstall 1.1.95.

- **Test processes request their own heavy-job slot.** A named `node --test` command stays light;
  work hidden in a script, alias, or computed command is counted and queued with its agent.
- **Screen reading survives a busy start.** The hidden terminal copy is measured over a full
  window, is not disabled during its first 30 seconds, and backs off before retrying if needed.
- **God can read from the hidden copy.** `screenGateSource=mirror` selects it, with a fallback to
  the visible terminal if the mirror cannot answer.
- **Shell-keyword commands are classified** so a heavy command inside `if`, `then`, `do`, `{`,
  and similar wrappers is counted.
- **Agent-folder file requests are enforced.** Window file-list, read, and write requests reject
  folders that are not registered agent folders.
- **Windows `npm ci` works in agent shells.** The winpty batch calls are fully qualified when
  `NoDefaultCurrentDirectoryInExePath` is set.
- **Releases have one path:** a verified local build. The GitHub workflow is manual and dry-run.

See [CHANGELOG.md](CHANGELOG.md) for the complete 1.1.96 release notes.
