/**
 * WAKE-CODEX-MODAL-PROMPT-BLOCKS-108: which agents have a Codex popup (a question with numbered
 * choices) on their screen right now, as the two screen readings saw it:
 *
 *   - the startup reading (automaticSubmit observeStartup), taken with no request behind it after
 *     each output burst of an un-latched incarnation: a popup, or a screen without one;
 *   - the screen gate (`MODAL:codex-popup:<text>` on a refused request, or an admission).
 *
 * 2026-11-27: Dwight restarted onto Codex's "GPT-5.6 Terra retires" menu. The startup reading had
 * the menu in its tail and reported only `no-marker`; liveness said IDLE/quiescent, then
 * UNKNOWN/awaiting-wake; the gate refused each wake with the popup named in a log row nobody is
 * sent. The only alerts wait five minutes and go to the Human's banner. This watch is what the
 * floor digest (a decision for god, naming the popup) and liveness read instead.
 *
 * It only remembers. It never types, answers a popup, wakes anyone or reads a screen itself.
 * Pure: the caller supplies `now`; rows go to the injected log.
 */

/** A popup is a decision once it has stayed up this long (one answered at once is not). */
export const CODEX_POPUP_SETTLE_MS = 20_000;

export type CodexPopupSource = 'startup' | 'gate';

export interface CodexPopupSighting {
  agentId: string;
  /** The PTY incarnation the popup was read on (null = not known). */
  incarnation: number | null;
  /** The popup in one bounded line (codexPopupText). */
  text: string;
  /** When this popup was first read on this incarnation. */
  since: number;
  /** When it was last read. */
  seenAt: number;
  source: CodexPopupSource;
}

/** What is true NOW, asked at read time: a sighting of another incarnation, or one older than the
 *  agent's newest hook (a hook means Codex is running a session again), is over. */
export interface CodexPopupLive {
  incarnation: (agentId: string) => number | null | undefined;
  lastHookAt: (agentId: string) => number;
}

export class CodexPopupWatch {
  private readonly byAgent = new Map<string, CodexPopupSighting>();

  constructor(private readonly log: (row: Record<string, unknown>) => void = () => undefined) {}

  /**
   * One reading. `text` = the popup on screen, or null = the reading saw none. Returns 'raised' for
   * a new popup (another text or incarnation is a new one), 'cleared' when one ended, else null.
   */
  note(agentId: string, incarnation: number | null, text: string | null, source: CodexPopupSource, now: number): 'raised' | 'cleared' | null {
    if (!agentId) return null;
    const prev = this.byAgent.get(agentId);
    if (text === null) {
      if (!prev) return null;
      this.end(prev, source, now);
      return 'cleared';
    }
    if (prev && prev.incarnation === incarnation && prev.text === text) {
      prev.seenAt = now;
      return null;
    }
    this.byAgent.set(agentId, { agentId, incarnation, text, since: now, seenAt: now, source });
    try { this.log({ kind: 'codex-popup-seen', agentId, incarnation, popup: text, source }); } catch { /* logging only */ }
    return 'raised';
  }

  /** The agent's terminal is gone or replaced: its popup went with it. */
  forget(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  private end(s: CodexPopupSighting, why: string, now: number): void {
    this.byAgent.delete(s.agentId);
    try { this.log({ kind: 'codex-popup-cleared', agentId: s.agentId, incarnation: s.incarnation, popup: s.text, why, upMs: now - s.since }); } catch { /* logging only */ }
  }

  /** The popup on this agent's screen, if one is up (settled or not). */
  current(agentId: string, now: number, live?: CodexPopupLive): CodexPopupSighting | null {
    const s = this.byAgent.get(agentId);
    if (!s) return null;
    if (live) {
      let inc: number | null | undefined;
      let hookAt = 0;
      try { inc = live.incarnation(agentId); hookAt = live.lastHookAt(agentId); } catch { return { ...s }; }
      if (inc === undefined || (s.incarnation !== null && inc !== s.incarnation)) { this.end(s, 'incarnation', now); return null; }
      if (hookAt > s.seenAt) { this.end(s, 'hook', now); return null; }
    }
    return { ...s };
  }

  /** Every popup that has been up for the settle time, oldest first. */
  popups(now: number, live?: CodexPopupLive): CodexPopupSighting[] {
    const out: CodexPopupSighting[] = [];
    for (const agentId of [...this.byAgent.keys()]) {
      const s = this.current(agentId, now, live);
      if (s && now - s.since >= CODEX_POPUP_SETTLE_MS) out.push(s);
    }
    return out.sort((a, b) => a.since - b.since || a.agentId.localeCompare(b.agentId));
  }
}
