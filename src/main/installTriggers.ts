/**
 * ARMED-TRIGGERS-LOST-ON-RESTART (A9): a card armed for an install fires to its assignee.
 *
 * The durable arm is the card itself: `waitingFor: "install"` + `fixVersion: "x.y.z"` (PROTOCOL).
 * When the running app reaches that version (installWait = 'installed'), the card's assignee is
 * sent ONE inform, so a post-install step no longer depends on anyone's session context
 * surviving the restart. God's SHIPPED_INSTALLED digest item is unchanged; this is the
 * assignee's half.
 *
 * Once per (card, fixVersion), recorded in hive/state/install-triggers.json. Delivery is
 * AT-LEAST-ONCE (god b92c29): the record is written after the send, so a crash (or a failed
 * write) between the two sends it again on the next start - a duplicate, never a silent loss.
 * A failed record write is logged (install-trigger-record-failed) and remembered in memory, so
 * the same process does not repeat it. A new fixVersion arms the card again. An assignee who is
 * not registered (or archived), or has no inbox, is skipped and NOT recorded: the inform goes out
 * once they are back. A send that throws is logged (install-trigger-send-failed) and not
 * recorded either.
 *
 * The record file is read ONCE per hive root (at process start, or on a hive-home change), so a
 * hand edit or delete of it (e.g. to re-fire a card) takes effect at the next start.
 *
 * A card assigned to god fires to god as well: god gets this inform beside the SHIPPED_INSTALLED
 * digest item. That is intended (Jim NIT 2): the inform names the step, the digest the decision.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicJson';
import { installWait } from '../shared/boardStale';
import { firstOccurrenceById } from '../shared/taskLedger';

export const INSTALL_TRIGGERS_FILE = 'install-triggers.json';
/** Cards in these states can still act on their post-install step. */
const ARMABLE = new Set(['todo', 'doing', 'blocked']);

export interface InstallTriggerFired { at: number; to: string; running: string }

export interface InstallTriggerHost {
  registry(): { agents: Record<string, { archived?: boolean } | undefined> };
  send(msg: { to: string; act: 'inform'; card: string; subject: string; body: string; requires_reply: false }, from: string): unknown;
  appendLog(row: Record<string, unknown>): void;
}

export const installTriggerKey = (cardId: string, fixVersion: string): string => `${cardId}@${fixVersion}`;

export class InstallTriggers {
  private root: string | null = null;
  private fired: Record<string, InstallTriggerFired> = {};

  constructor(private readonly host: InstallTriggerHost) {}

  /** The record is read once per hive root (a process start or a home change), not per pass. */
  private load(root: string): void {
    if (this.root === root) return;
    this.root = root;
    this.fired = {};
    try {
      const v = JSON.parse(readFileSync(join(root, 'state', INSTALL_TRIGGERS_FILE), 'utf8')) as { fired?: unknown };
      if (v && typeof v.fired === 'object' && v.fired !== null) this.fired = { ...(v.fired as Record<string, InstallTriggerFired>) };
    } catch { /* none yet, or unreadable: at-least-once means it may fire again */ }
  }

  /** Send the informs due now. Returns the card ids sent to. */
  run(root: string, tasks: unknown, runningVersion: string | null | undefined, now: number): string[] {
    this.load(root);
    const raw = (tasks as { tasks?: unknown[] })?.tasks;
    const list = firstOccurrenceById(Array.isArray(raw) ? raw : [], (c) => (c as { id?: string })?.id ?? null) as Array<Record<string, unknown>>;
    let agents: Record<string, { archived?: boolean } | undefined> = {};
    const sent: string[] = [];
    let regRead = false;
    for (const card of list) {
      if (!card || typeof card.id !== 'string' || !ARMABLE.has(String(card.status))) continue;
      if (installWait(card, runningVersion) !== 'installed') continue;
      const to = typeof card.assignee === 'string' && card.assignee !== 'unassigned' ? card.assignee : '';
      if (!to) continue;
      const fix = String(card.fixVersion).trim();
      const key = installTriggerKey(card.id, fix);
      if (this.fired[key]) continue;
      if (!regRead) { regRead = true; try { agents = this.host.registry().agents ?? {}; } catch { agents = {}; } }
      const a = agents[to];
      if (!a || a.archived) continue;
      // The router delivers only into an existing inbox; an undeliverable send must not count as fired.
      if (!existsSync(join(root, 'agents', to, 'inbox'))) continue;
      const running = String(runningVersion);
      const title = typeof card.title === 'string' ? card.title : '';
      try {
        this.host.send({
          to, act: 'inform', card: card.id, requires_reply: false,
          subject: `app-start ${running}: ${card.id} fix ${fix} is installed - run its post-install step`,
          body: `${card.id}${title ? ` ("${title}")` : ''} is armed with waitingFor "install" and fixVersion ${fix}, and the running app is ${running}. Do its post-install step now, then clear the arm (patch waitingFor and fixVersion to null) or close the card. This inform is sent once per card and fixVersion (install-trigger ${key}); a crash between its send and its record can repeat it once.`
        }, 'system');
      } catch (e) {
        try { this.host.appendLog({ kind: 'install-trigger-send-failed', cardId: card.id, to, fixVersion: fix, error: String(e).slice(0, 300) }); } catch { /* noop */ }
        continue;
      }
      this.fired[key] = { at: now, to, running };
      sent.push(card.id);
      try { this.host.appendLog({ kind: 'install-trigger', cardId: card.id, to, fixVersion: fix, running }); } catch { /* noop */ }
      try {
        mkdirSync(join(root, 'state'), { recursive: true });
        atomicWriteJson(join(root, 'state', INSTALL_TRIGGERS_FILE), { v: 1, fired: this.fired });
      } catch (e) {
        try { this.host.appendLog({ kind: 'install-trigger-record-failed', cardId: card.id, to, fixVersion: fix, error: String(e).slice(0, 300) }); } catch { /* noop */ }
      }
    }
    return sent;
  }
}
