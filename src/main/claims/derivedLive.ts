/**
 * CLAIMS-90 M5: the derived writer in the running app. Config `derivedClaims` (absent = on) turns it
 * off; it also waits while the claim ledger level is off. `derivedClaimsRepo` names the git repo for
 * lastsha, tags and done-mail shas (absent: those are skipped; the packaged CHANGELOG still feeds the
 * release facts).
 *
 *   start   one full backfill a little after the claim store opens (derivedWriter.runDerivedBackfill)
 *   cards   tasks.json changed (TaskLedgerGuard.onChange): the decisions and card fields, debounced
 *   timer   every PASS_MS: the cards again, the done mails the MailLedger recorded since the last pass
 *           and the releases
 *
 * It never touches the delivery path (wake/mail confirm): it only reads the MailLedger files that
 * delivery wrote (hive/state/mail). Runs never overlap; a failure is logged and the next pass tries again.
 */
import { cardFieldFacts, cardRecordFacts, decisionFacts, doneMailFacts, parseChangelog, releaseFacts, type MailLike } from './derivedFacts';
import { DerivedGit } from './derivedGit';
import { readCards, readDoneMails, runDerivedBackfill, syncDerived, type DerivedWriterDeps } from './derivedWriter';

export const DERIVED_START_DELAY_MS = 20_000;
export const DERIVED_CARDS_DEBOUNCE_MS = 5_000;
export const DERIVED_PASS_MS = 10 * 60_000;

export interface DerivedLiveDeps {
  hiveRoot: () => string | null;
  writer: () => DerivedWriterDeps | null;
  /** config.derivedClaims !== false, and the ledger level is not off. */
  enabled: () => boolean;
  repo: () => string | null;
  changelog: () => string | null;
  log: (row: Record<string, unknown>) => void;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
}

export class DerivedLive {
  private chain: Promise<unknown> = Promise.resolve();
  private seenMail = new Set<string>();
  private root: string | null = null;
  private git: DerivedGit | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  constructor(private readonly d: DerivedLiveDeps) {}

  /** Once per app run (the claim store reopens on a new hive root; the passes follow hiveRoot()). */
  start(): void {
    if (this.timers.length) return;
    const st = this.d.setTimeout ?? setTimeout;
    const si = this.d.setInterval ?? setInterval;
    const t1 = st(() => { void this.run('start', () => this.full()); }, DERIVED_START_DELAY_MS);
    const t2 = si(() => { void this.run('pass', () => this.pass()); }, DERIVED_PASS_MS);
    for (const t of [t1, t2]) (t as { unref?: () => void }).unref?.();
    this.timers.push(t1, t2);
  }

  stop(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; if (this.debounce) clearTimeout(this.debounce); }

  /** tasks.json changed. */
  cardsChanged(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = (this.d.setTimeout ?? setTimeout)(() => { this.debounce = null; void this.run('cards', () => this.cards()); }, DERIVED_CARDS_DEBOUNCE_MS);
  }

  /** Serialized; resolves when this run is over. */
  run(step: string, fn: () => Promise<unknown>): Promise<unknown> {
    const next = this.chain.then(async () => {
      if (!this.d.enabled()) return;
      try { await fn(); } catch (e) { this.d.log({ kind: 'claims-derived-failed', step, error: String(e).slice(0, 160) }); }
    });
    this.chain = next;
    return next;
  }

  private ctx(): { root: string; w: DerivedWriterDeps; git: DerivedGit | null } | null {
    const root = this.d.hiveRoot();
    const w = this.d.writer();
    if (!root || !w) return null;
    if (root !== this.root) { this.root = root; this.seenMail = new Set(); this.git = null; }
    const repo = this.d.repo();
    if (repo && this.git?.repo !== repo) this.git = new DerivedGit(repo);
    if (!repo) this.git = null;
    return { root, w, git: this.git };
  }

  private async full(): Promise<void> {
    const c = this.ctx(); if (!c) return;
    const git = c.git && await c.git.ok() ? c.git : null;
    // Mark every recorded done mail seen first: the backfill reads them all (and any that land meanwhile); a
    // mail read twice is idempotent, a mail marked but never read would be lost.
    this.newDoneMails(c.root);
    await runDerivedBackfill(c.w, { hiveRoot: c.root, git, releases: await this.releaseSource(git), ...(git ? { prefetch: (s) => git.prefetch(s) } : {}) });
  }

  private async cards(): Promise<void> {
    const c = this.ctx(); if (!c) return;
    const cards = readCards(c.root);
    const git = c.git && await c.git.ok() ? c.git : null;
    await syncDerived(c.w, decisionFacts(cards));
    await syncDerived(c.w, cardRecordFacts(cards));
    await syncDerived(c.w, await cardFieldFacts(cards, git));
  }

  private async pass(): Promise<void> {
    await this.cards();
    const c = this.ctx(); if (!c) return;
    const git = c.git && await c.git.ok() ? c.git : null;
    const rel = await this.releaseSource(git);
    await syncDerived(c.w, releaseFacts(parseChangelog(rel.changelog), rel.tags));
    const mails = this.newDoneMails(c.root);
    if (git && mails.length) {
      const ids = readCards(c.root).map((x) => x.id).filter((id): id is string => typeof id === 'string');
      const done = await doneMailFacts(mails, ids, git);
      for (const s of done.skips) this.d.log({ kind: 'claims-derived-done-skip', mail: s.mail.slice(0, 120), reason: s.reason, ...(s.cards ? { cards: s.cards } : {}) });
      await syncDerived(c.w, done.facts);
    }
  }

  private async releaseSource(git: DerivedGit | null): Promise<{ changelog: string | null; tags: Awaited<ReturnType<DerivedGit['tags']>> }> {
    return { changelog: this.d.changelog(), tags: git ? await git.tags() : [] };
  }

  /** The done mails the MailLedger recorded since the last pass (each remembered by agent/id). */
  private newDoneMails(root: string): MailLike[] {
    return readDoneMails(root, this.seenMail);
  }
}
