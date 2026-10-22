/**
 * READS-QUIET-NOREPLY (1.1.81): which delivered mail may wait for the agent's next real turn
 * instead of starting one.
 *
 * Every wake re-sends the agent's whole conversation (god: up to ~290k per turn), and on
 * 2026-10-02 176 of 348 mail wakes carried only FYI mail (quiet-time on/off, status relays).
 * For an `inject` agent (Claude, Codex, AGY) the mail BODIES never ride the wake: the hooks
 * surface every delivered id on the next UserPromptSubmit / PostToolUse, woken for or not. So a
 * quiet message only has to stay out of the wake coordinator's pending set; it reaches the agent
 * on its next real turn, or after QUIET_MAIL_HOLD_MIN_DEFAULT minutes at most, when the whole
 * held batch is released as one ordinary wake.
 *
 * QUIET = ALL of:
 *   - the recipient's mail mode is `inject` (the others read mail BECAUSE of the wake prompt);
 *   - act `inform` or `agree` (done is how results come back: it always wakes, god c95516);
 *   - no reply required;
 *   - a sender that is not the Human, the breaker, the floor digest or a harness sender;
 *   - the sender did not ask for `"wake": "now"`;
 *   - it does not ANSWER the recipient's own ask (Jim B1): an agree or inform whose in_reply_to is a
 *     message the recipient sent as a request/query/propose or with requires_reply. That is the go
 *     signal an idle agent is waiting for (god's "approved" to Jim was an agree);
 *   - it is not otherwise SOLICITED (QUIET-HOLD-ACT-ONLY, 1.1.98, solicitedQuietMail): on
 *     2026-10-22 the class keyed on the act alone and held for up to 30 min god's answer to a
 *     question, the Human's spec correction to the agent mid-card, the Human's hard-rule and
 *     floor-pause broadcasts, facts added to an open request, and results sent as inform. Each
 *     carried a fresh conversation id and no in_reply_to, so B1 never saw them.
 * Everything else wakes exactly as before. Pure: no clock, no I/O.
 */

export const QUIET_MAIL_HOLD_MIN_DEFAULT = 30;

/** The acts that may be held. */
export const QUIET_ACTS: ReadonlySet<string> = new Set(['inform', 'agree']);

/** Senders whose mail always wakes: the Human, Floor decisions, the circuit breaker, webhooks,
 *  and every harness sender (mailReaders SYSTEM_SENDERS). */
export const ALWAYS_WAKE_SENDERS: ReadonlySet<string> = new Set([
  'human', 'digest', 'breaker', 'webhook', 'system', 'heartbeat', 'scheduler',
  // Jim B2: the Human's spoken message to an agent ("Voice ping from Michael", realtimeActions
  // VOICE_ACTOR) and a worker's terminal failure to god with its Slack reply command (index
  // informGod). test/reads-quiet-181 keeps a census of every harness sender against this set.
  'michael-voice', 'ephemeral-worker',
  // CLAIM-LEDGER W1: a claims-chain-broken or claims-key-missing alert to god (a ledger went read-only).
  'claims'
]);

/** The acts that ask the recipient for an answer (hive.normalize's requires_reply default). */
const ASKING_ACTS: ReadonlySet<string> = new Set(['request', 'query', 'propose']);

/** The ledger fields the class reads (MailEntry has them all). */
export interface MailWakeFacts {
  id: string;
  from: string;
  act?: string;
  requiresReply: boolean;
  /** The sender asked for `"wake": "now"`. */
  wakeNow?: boolean;
  deliveredAt: number;
  /** The id this message answers (MailEntry.inReplyTo). */
  inReplyTo?: string | null;
  // QUIET-HOLD-ACT-ONLY (1.1.98): the thread, card and relay facts solicitedQuietMail reads.
  conversation?: string;
  cardId?: string;
  subject?: string;
  /** Sent to every agent (`to: "broadcast"`, MailEntry.broadcast). */
  broadcast?: boolean;
  /** The subject or body names the Human (MailEntry.humanRelay, HUMAN_RELAY_RE at delivery). */
  humanRelay?: boolean;
}

/** The message an answer points at, as the replier's ledger holds it. */
export interface AskedMessage { from: string; act?: string; requiresReply: boolean }

/**
 * Jim B1: does `e` answer an ask the RECIPIENT made? `lookup(e.from, id)` finds the original in
 * the ledger of the agent that received it, which is the one now answering. Unknown = no.
 */
export function answersOwnAsk(e: MailWakeFacts, recipientId: string, lookup: (holder: string, id: string) => AskedMessage | undefined): boolean {
  if (!e.inReplyTo) return false;
  let orig: AskedMessage | undefined;
  try { orig = lookup(e.from, e.inReplyTo); } catch { orig = undefined; }
  return !!orig && orig.from === recipientId && (orig.requiresReply || ASKING_ACTS.has(String(orig.act ?? '')));
}

/**
 * QUIET-HOLD-ACT-ONLY: an entry as the ledger of the agent that RECEIVED it holds it (the subset the
 * solicited rules read; MailEntry has them all).
 */
export interface LedgerEntryLike {
  id: string;
  senderId?: string;
  from: string;
  act?: string;
  requiresReply: boolean;
  conversation?: string;
  cardId?: string;
  repliedAt?: number | null;
  replyAct?: string | null;
  closedAt?: number | null;
}

/** The received mail of any agent, by id (main: hive.mail.ledger(id).entries; unknown = empty). */
export interface WakeLedgers { entries(agentId: string): readonly LedgerEntryLike[] }

/** The subject or body relays the Human ("the Human's rule", "spec correction from the Human"). */
export const HUMAN_RELAY_RE = /\bhuman\b/i;
/** A broadcast that holds or pauses the floor ("Floor paused by the Human", "hold all pushes"). */
export const HOLD_NOTICE_RE = /\b(?:paused?|hold|halt(?:ed)?|freeze|frozen|stop|resumed?)\b/i;

/** The reply acts that discharge an ask (mailLedger DISCHARGING_REPLY_ACTS). */
const DISCHARGING: ReadonlySet<string> = new Set(['done', 'refuse', 'blocked']);

/** An ask still owed: asking, not closed, not replied or replied only in the interim (mailLedger owesWork). */
function stillOwed(x: LedgerEntryLike): boolean {
  if (!(x.requiresReply || ASKING_ACTS.has(String(x.act ?? '')))) return false;
  if (x.closedAt) return false;
  return !x.repliedAt || (!!x.replyAct && !DISCHARGING.has(x.replyAct));
}

/**
 * QUIET-HOLD-ACT-ONLY (1.1.98): is this otherwise quiet inform/agree SOLICITED, so it wakes the
 * recipient at once? Yes when ANY of:
 *   (a1) it is in_reply_to a message the recipient sent, whatever that message's act was (B1 widened:
 *        god's answer to Sele's conflict note was in_reply_to an INFORM);
 *   (a2) it names the card, or sits in the conversation, of an open ask the recipient is WORKING
 *        (an ask in the recipient's own ledger it still owes): the Human's spec correction to Speck
 *        mid-RAYB-6, the Pixel/Android facts added to McCey's open RAYB-9;
 *   (b)  it relays the Human (humanRelay), or is a broadcast that holds or pauses the floor;
 *   (c)  the recipient has an open ask to the SENDER (in the sender's ledger) and this message does
 *        not name some other card: it is the result, however it was labelled (McCey's "RAYB-9 done"
 *        sent as inform to god). A message naming a card that matches none of them is about other
 *        work and stays quiet.
 * Only an unsolicited status FYI is left to the hold. The ledgers are read, never written; a reader
 * that throws is caught by mailWakeClass and fails open (it wakes).
 */
export function solicitedQuietMail(e: MailWakeFacts, recipientId: string, ledgers: WakeLedgers): boolean {
  if (e.inReplyTo) {
    const orig = ledgers.entries(e.from).find((x) => x.id === e.inReplyTo || (!!x.senderId && x.senderId === e.inReplyTo));
    if (orig && orig.from === recipientId) return true;
  }
  if (e.humanRelay === true) return true;
  if (e.broadcast === true && HOLD_NOTICE_RE.test(String(e.subject ?? ''))) return true;
  const sameThread = (x: LedgerEntryLike) => (!!x.cardId && x.cardId === e.cardId) || (!!x.conversation && x.conversation === e.conversation);
  const toSender = ledgers.entries(e.from).filter((x) => x.from === recipientId && stillOwed(x));
  if (toSender.length && (!e.cardId || toSender.some(sameThread))) return true;
  return ledgers.entries(recipientId).some((x) => stillOwed(x) && sameThread(x));
}

export type MailWakeClass = 'wake' | 'quiet';

/** `isAnswer` (main: solicitedQuietMail over the ledgers) is asked only for an otherwise quiet message. */
export function mailWakeClass(e: MailWakeFacts, mailMode: string, isAnswer?: (e: MailWakeFacts) => boolean): MailWakeClass {
  if (mailMode !== 'inject') return 'wake';
  if (!QUIET_ACTS.has(String(e.act ?? ''))) return 'wake';
  if (e.requiresReply) return 'wake';
  if (ALWAYS_WAKE_SENDERS.has(e.from)) return 'wake';
  if (e.wakeNow === true) return 'wake';
  if (isAnswer) {
    let answer = true;   // a lookup that throws fails open: it wakes
    try { answer = isAnswer(e); } catch { answer = true; }
    if (answer) return 'wake';
  }
  return 'quiet';
}

/** The config value (minutes) as milliseconds: a finite number >= 0, else the default; 0 = off. */
export function quietMailHoldMs(configMin: unknown): number {
  const n = typeof configMin === 'number' && Number.isFinite(configMin) && configMin >= 0 ? configMin : QUIET_MAIL_HOLD_MIN_DEFAULT;
  return Math.round(n * 60_000);
}

/**
 * The quiet ids among `entries` that may still wait at `now`, each with the time its hold ends
 * (deliveredAt + holdMs, so a restart never extends it). An id past its hold, or any id when the
 * hold is off, is absent: it wakes.
 */
export function quietHolds(entries: readonly MailWakeFacts[], mailMode: string, holdMs: number, now: number, isAnswer?: (e: MailWakeFacts) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!(holdMs > 0)) return out;
  for (const e of entries) {
    if (mailWakeClass(e, mailMode, isAnswer) !== 'quiet') continue;
    const until = e.deliveredAt + holdMs;
    if (until > now) out.set(e.id, until);
  }
  return out;
}

/** A sender's `wake` field: only the exact string "now" counts. */
export function normalizeWakeField(v: unknown): { wake?: 'now' } {
  return v === 'now' ? { wake: 'now' } : {};
}
