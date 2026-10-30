# The message queue — how anything gets typed into an agent's terminal

Every agent runs a real CLI in a real PTY. That CLI has exactly one input line, and
you are not the only one who wants it: you type into the terminal directly, and the
harness also has messages of its own to deliver. This document is the contract for
who gets that line and when.

Two different queues get called "the queue". They are not the same thing:

| Name | Lives in | Holds |
|---|---|---|
| **MD queue** | the harness (zustand store, per agent) | messages parked by *Munder Difflin* until that agent's terminal is free |
| **Claude queue** | inside Claude Code itself | text Claude Code has accepted but not started on yet |

Everything below is about the **MD queue**. The harness cannot see the Claude queue
and never reasons about it.

---

## 1. One submit owner

One place submits automatic text into a live agent's PTY: **main's
`automaticSubmit.ts`**, the one main-owned programmatic submit transaction. Nothing in
the renderer writes a queued message to a PTY itself; it *asks* main through
`window.cth.autoSubmit(...)`, and main types, checks and presses Enter, or declines.

Three paths ask the owner:

- **The renderer drain** (`useHive.ts` effect 4) decides *which* queued item is next
  and *when* it is worth asking, then calls `cth.autoSubmit` with the request id
  `queue:<agent>:<item id>`. The Human's own composer items go to main's message box
  instead (`cth.messageBoxDeliver`) when main's control snapshot reports the `term`
  path.
- **Boot prompts.** Seed and orientation prompts call `cth.autoSubmit` with the
  `BOOT_SEQUENCE` class and keep asking while main answers "not now" (see
  `submitBootPrompt`). There is no direct-write exception for god any more.
- **Inbox wakes** never touch the MD queue. `inboxWakeBridge.ts` in main turns every
  wake edge (a durable inbox write, a Stop/idle hook, a control release, a capacity
  change, SEND_AGAIN after an interference) into one coalesced `requestInboxWake`,
  plus a 15 s reconciliation beat. That re-reads the inbox, takes the one in-flight
  claim and submits through the owner as `CAPACITY_GATED` under a stable request id.
  The renderer's 4 s inbox *hint* (effect 3) only asks main to look; it carries no
  payload and submits nothing.

```
composer / Slack ingress ──────┐
non-Claude work orders (2e) ───┼──▶ enqueueMessage ──▶ MD queue ──▶ drain (effect 4) ─┐
voice queue inserts (5c) ──────┤                                                     │
context triggers /compact (6) ─┘                                                     ├──▶ automaticSubmit.ts ──▶ PTY
boot prompts (submitBootPrompt) ─────────────────────────────────────────────────────┤      (main, the one owner)
inbox wake edges ──▶ inboxWakeBridge.ts (main) ──▶ requestInboxWake ─────────────────┘
```

This is load-bearing. When the inbox nudge wrote straight into the terminal, it was
a second writer with its own idea of when the prompt was free — and its text landed
on top of a half-written line, so the nudge and the user's sentence were submitted
together as one garbled prompt. With one owner, every "is this terminal free, and
did Enter really go out?" decision is made in one place, and it is idempotent on the
request id: main delivers an id at most once, so a reload between main's Enter and
the renderer's acknowledgement cannot type a message twice.

The drain runs on every store change (debounced 200 ms, so a burst of PTY output
coalesces) plus a 3 s backstop tick.

## 2. What the drain checks, and what main answers

The drain picks the next item (`pickQueuedForDelivery`; a person's message is offered
ahead of an automatic one main refused last time) and asks main only when **all** of
these hold:

| Condition | Why |
|---|---|
| agent is idle, or breaker-pinned with a terminal quiet for `QUIESCE_IDLE_MS` | don't interrupt a running turn (the Human's message-box items skip this: main judges idle) |
| auto-delivery not paused — **or the message was manually released** | floor-wide switch (Command Center); see below |
| no capacity hold from main — **or the message was manually released** | a limited provider delays work instead of destroying it |
| past the boot grace window | the CLI is still painting its banner |
| `isTerminalAutomationSafe(ptyId)` | the user owns the prompt — see below (skipped on the message-box path) |
| 4.5 s since the last delivery to this agent (`FLUSH_COOLDOWN_MS`) | back-to-back sends jam the TUI |
| the item's delivery-time precondition still holds | an inbox nudge with no mail left pending is dropped, not deferred |

**Manual release (v0.3.5).** While floor-wide auto-delivery is paused, every queued row
shows a **send now** link. Clicking it sets `manual: true` on that message and moves it
to the front of its queue. The drain then bypasses **only the pause and capacity
checks** for that message, and asks main with the `USER_RELEASED` class instead of
`CAPACITY_GATED`. Every other condition still applies, so a manually released message
waits for idle and respects your draft/picker.

**Main's transaction.** The owner runs ADMIT → READY → STAGE → GAP and ends in one of
three acknowledgements:

| Ack | Meaning |
|---|---|
| **COMMIT** | the final check passed and Enter went out in the same turn |
| **ABORT** | capacity refused late; nobody typed, our text was erased and the erase verified on screen. Retryable |
| **INTERFERED** | a human wrote after STAGE. No Enter, no clear, no retry: the item is held and automatic delivery to that terminal is inhibited until a person resolves it ("send queued message" or "already handled - drop") |

A human write before STAGE, or any other "not now" before typing, is a side-effect-free
refusal (REFUSED). Only `CAPACITY_GATED` submissions can ABORT; `USER_RELEASED` and
`BOOT_SEQUENCE` do not ask capacity. Raw human keystrokes never pass through the owner.

What the drain does with each outcome:

| Outcome | Queue item |
|---|---|
| `COMMITTED` | removed (and its work order recorded) |
| `REFUSED` / `ABORTED` | stays queued at no attempt cost; nothing of ours is on the prompt |
| `INTERFERED` | held — shown as held by the composer from main's control snapshot, never retried into the prompt, never dropped |
| `HUMAN_HANDLED` | removed: a person marked it already handled |
| `TYPED_NOT_SENT` | removed: the message box typed it but pressed no Enter, so it is on the terminal now |
| `FAILED` / `REJECTED` | retried on the next cooldown-spaced flush, then dropped loudly after `MAX_SEND_ATTEMPTS` (3) |

## 3. The user owns the prompt

`isTerminalAutomationSafe` is the gate that protects your typing. It refuses
delivery while any of these is true (`terminalAutomation.ts`):

| Block | Set by | Cleared by |
|---|---|---|
| `exited` | the PTY died | respawn |
| `picker` | you submitted a bare `/model`-style command that opens a menu | an Enter / Escape / Ctrl-C typed into that terminal, or expiry |
| `draft` | you have unsubmitted text on the prompt | submitting or clearing it, or expiry |
| `settling` | a short repaint window after the line was freed | time |

Both `picker` and `draft` expire after **30 minutes** (`STALE_PICKER_MS`,
`STALE_INPUT_MS`). The expiry exists because both flags are inferred, not reported —
a picker closed some way we can't observe, or a draft flag left set by a TUI that
swallowed keys, would otherwise wedge that agent's MD queue for the rest of the
session.

Two rules about what happens when a block expires:

- **Automation never erases your text.** Expiry means the queued message is typed
  *after* whatever is on the line; the two fuse into one prompt. An earlier version
  sent Ctrl-U first, which silently destroyed real drafts that had merely been left
  alone for a minute.
- **Automation never closes your menu.** We do not send Escape at a picker. You may
  have opened it deliberately and stepped away; taking it down to make room for a
  queued message is not the harness's call, and we cannot verify that Escape worked
  anyway. The composer has a button that does it — because then *you* asked.

Both windows are long on purpose. Treating a live draft as abandoned is the
expensive mistake; leaving a queued message parked a while longer is the cheap one.

## 4. Reading the prompt instead of modelling it

`inputDirty` is inferred by counting keystrokes in `term.onData`. That model drifts:
a TUI that eats keys for its own UI leaves the count above zero while the prompt is
visibly empty — a **phantom draft**, which blocks the MD queue against text that
does not exist.

xterm already holds the rendered screen, so `promptLineHasText` reads it directly
(`term.buffer.active`, the row at `baseY + cursorY`, stripped of prompt chrome).

It is deliberately **one-directional**: the buffer read can only *clear* a draft,
never invent one.

- screen says empty ⇒ believe it, drop the block
- screen says text, or cannot be read ⇒ fall back to the keystroke count

The asymmetry is the point, because the two mistakes don't cost the same. A wrong
"empty" opens the gate and fuses a queued message onto what you're writing. A wrong
"has text" only parks that message until the draft expires. So the cheap mistake is
the one we allow to happen.

One case where the screen is not evidence at all: `inputDirty` is set the moment you
press a key, but the character only reaches xterm's buffer after the PTY echoes it
back. Inside that gap the buffer is still showing the previous state, so a read of a
freshly started draft would return "empty" — the expensive direction. A read within
`ECHO_GRACE_MS` (1 s) of the last keystroke therefore returns "don't know" and clears
nothing.

## 5. Seeing why nothing is being delivered

A held MD queue used to look exactly like an idle agent with nothing to do. The
`typing` badge (`--cth-status-typing`, label **"your draft"**) fixes that: it renders
on agent cards and in the fullscreen roster whenever `hasTerminalDraft(ptyId)` is
true.

It is not an agent status and is never stored on the agent — the PTY parser owns
that field and would overwrite it. It is derived at render from the same draft
detection the gate uses, so the badge is reporting the same draft the gate sees.

It does **not** apply the 30-minute expiry the gate applies. Past that window the
gate starts delivering while the badge still reads "your draft" — which is honest:
your text really is still sitting on the prompt. The badge answers "is my text
there", not "is the queue blocked".

## 6. Where the code lives

| File | Role |
|---|---|
| `src/main/automaticSubmit.ts` | the one submit owner: admission classes, ADMIT → READY → STAGE → GAP, COMMIT / ABORT / INTERFERED. Electron-free, every effect injected |
| `src/main/automaticSubmitWiring.ts` | joins the owner to the real PTY manager, the capacity runtime and the renderer's screen oracle; the IPC handlers (`autoSubmit:submit`, `autoSubmit:resolveInterference`) are a few lines in `src/main/index.ts` |
| `src/main/inboxWakeBridge.ts` | main's inbox wakes: wake edges → `requestInboxWake` → one claim → the owner as `CAPACITY_GATED` |
| `src/main/messageBox.ts` | the Human's own composer items on the `term` path (`cth.messageBoxDeliver`): delivered through TermControl, gated by main's hook state |
| `src/renderer/src/components/terminalAutomation.ts` | pure policy — blocks, expiry windows. No DOM, fully unit-tested (`test/terminal-automation.test.cjs`) |
| `src/renderer/src/components/terminalPool.ts` | the pooled xterm per PTY; buffer reads, latches, `isTerminalAutomationSafe`, `hasTerminalDraft` |
| `src/renderer/src/hooks/useHive.ts` | `submitBootPrompt` (boot prompts), effect 3 inbox hint (asks main, submits nothing), effect 4 drain (asks the owner), effect 6 context triggers (enqueue `/compact`) |
| `src/renderer/src/store/store.ts` | the MD queues themselves + agent persistence |
