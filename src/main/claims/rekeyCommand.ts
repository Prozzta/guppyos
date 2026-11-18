/**
 * CLAIMS-REKEY-ENTRYPOINT-108: the one way to run ClaimStore.rekey(). God runs
 * `claims rekey --floor <hive folder>` (resources/claims-cli.cjs); main asks the Human in a Guppy
 * dialog; only the Human's yes reaches rekey(true). Nothing else calls it, and nothing here is
 * automatic: no retry, no default yes, no rekey for a floor other than the one this Guppy runs.
 * The caller is checked against the registry's god at request time, as `term` is.
 */
import { resolve } from 'path';

/** What the alerts and the docs name. One place, so the texts cannot drift from the command. */
export const REKEY_COMMAND = 'claims rekey --floor <hive folder>';
/** The exact command line for one floor (its hive folder), as god types it. */
export function rekeyCommandFor(hiveRoot: string): string {
  return `claims rekey --floor "${hiveRoot}"`;
}
/** How long the Human has to answer the dialog. After it the dialog closes as a no. */
export const REKEY_CONFIRM_MS = 5 * 60_000;

export interface RekeyResult { ok: boolean; keyId?: string; rekeyed: string[]; refused: Array<{ agentId: string; why: string }> }
export interface RekeyQuestion { title: string; message: string; detail: string; ok: string }
export interface RekeyCommandDeps {
  isGod: (agentId: string) => boolean;
  /** The hive folder of the floor this Guppy runs, or null. */
  floorRoot: () => string | null;
  /** That floor's store, or null when the claim ledger is not up. */
  store: () => { rekey: (confirmedByHuman: true) => Promise<RekeyResult> } | null;
  /** The Human's answer. Resolves false when the signal aborts. Never answered by an agent. */
  confirm: (q: RekeyQuestion, signal: AbortSignal) => Promise<boolean>;
  log?: (row: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (t: unknown) => void;
  platform?: NodeJS.Platform;
}
export interface RekeyReply { status: number; body: { ok: boolean; line: string; lines?: string[]; result?: RekeyResult } }

const refuse = (status: number, line: string): RekeyReply => ({ status, body: { ok: false, line: `refused: ${line}` } });
function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => { const r = resolve(p).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

export class RekeyCommand {
  private busy = false;
  constructor(private readonly d: RekeyCommandDeps) {}

  async handle(agentId: string, body: unknown): Promise<RekeyReply> {
    if (!this.d.isGod(agentId)) return refuse(403, 'claims rekey is god-only');
    const floor = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).floor : null;
    if (typeof floor !== 'string' || floor.trim() === '' || floor.length > 1024) return refuse(400, `name the floor: ${REKEY_COMMAND}`);
    const root = this.d.floorRoot();
    const store = root ? this.d.store() : null;
    if (!root || !store) return refuse(409, 'no active hive with a claim ledger');
    if (!sameFolder(floor, root, this.d.platform ?? process.platform)) {
      return refuse(409, `${floor} is not the floor this Guppy runs (${root}). Each floor is rekeyed by its own god, in the Guppy window that runs it.`);
    }
    if (this.busy) return refuse(409, 'a rekey for this floor is already waiting for the Human or running');
    this.busy = true;
    try {
      this.d.log?.({ kind: 'claims-rekey-command', step: 'asked', by: agentId, floor: root });
      const ac = new AbortController();
      let timedOut = false;
      const timer = (this.d.setTimer ?? setTimeout)(() => { timedOut = true; ac.abort(); }, REKEY_CONFIRM_MS);
      (timer as { unref?: () => void } | null)?.unref?.();
      let yes = false;
      try {
        yes = (await this.d.confirm({
          title: 'Rekey the claim ledgers',
          message: `Rekey every claim ledger of this floor?`,
          detail: [
            `Floor: ${root}`,
            `Asked by: ${agentId} (god)`,
            '',
            'Do this only after the claim ledger key was lost or moved away. The current key is used when it loads; a new one is made only when no key file exists.',
            'One rekey line is written on each ledger. Records before that line are accepted on their prev chain only: their MACs can no longer be checked.',
            'A ledger with a broken chain or a forged record is refused and stays read-only.',
          ].join('\n'),
          ok: 'Rekey this floor',
        }, ac.signal)) === true && !ac.signal.aborted;
      } finally {
        (this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(timer);
      }
      if (!yes) {
        this.d.log?.({ kind: 'claims-rekey-command', step: timedOut ? 'unanswered' : 'declined', by: agentId, floor: root });
        return refuse(409, timedOut
          ? `the Human did not answer within ${Math.round(REKEY_CONFIRM_MS / 60_000)} minutes. Nothing was written.`
          : 'the Human did not confirm. Nothing was written.');
      }
      const r = await store.rekey(true);
      this.d.log?.({ kind: 'claims-rekey-command', step: 'ran', by: agentId, floor: root, ok: r.ok, keyId: r.keyId ?? null, rekeyed: r.rekeyed.length, refused: r.refused.length });
      const lines = [
        ...r.rekeyed.map((a) => `rekeyed: ${a}`),
        ...r.refused.map((x) => `refused: ${x.agentId} (${x.why})`),
      ];
      const n = r.rekeyed.length;
      const line = r.ok
        ? `rekey complete: ${n} ledger${n === 1 ? '' : 's'} rekeyed under key ${r.keyId}`
        : n === 0 && r.refused.length === 0
          ? 'refused: this floor has no claim ledger to rekey'
          : `rekey not complete: ${n} rekeyed, ${r.refused.length} refused${r.keyId ? ` (key ${r.keyId})` : ''}. Refused ledgers stay read-only.`;
      return { status: r.ok ? 200 : 409, body: { ok: r.ok, line, lines, result: r } };
    } finally {
      this.busy = false;
    }
  }
}
