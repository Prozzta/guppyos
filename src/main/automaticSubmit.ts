/**
 * L0-FUSION — THE ONE MAIN-OWNED PROGRAMMATIC SUBMIT TRANSACTION.
 *
 * Design of record: research `notes/andy-l0-fusion-design.md` rev 13, sections 1-8.
 *
 *   ADMIT -> READY -> STAGE -> GAP -> (COMMIT | ABORT | INTERFERED)
 *
 * WHY ONE OWNER. Every programmatic stage-then-Enter path — capacity-gated queue
 * delivery, worker wake, user-released send-now, boot/seed/orientation prompts —
 * types text and then, a TUI-imposed gap later, presses Enter. Two owners of that
 * sequence can interleave their text and Enter on one prompt; an owner that lives
 * outside main cannot put its final check next to its Enter, because an IPC reply
 * sits between them. So there is one owner, it lives where the PTY is, and every
 * such path serializes through it per PTY. Raw human keystrokes do NOT come through
 * here: they stay immediate, on the declared-HUMAN ingress, unordered relative to
 * this owner. That is not a second ordering authority — it is the absence of one,
 * and it is exactly why INTERFERED exists.
 *
 * THE THREE TERMINAL BRANCHES ARE NOT INTERCHANGEABLE (section 6):
 *   COMMIT      the final check passed and the Enter went out in the same turn.
 *   ABORT       capacity refused LATE, NOBODY TYPED, and the automatic text was erased
 *               AND the erase positively verified on the rendered screen. Retryable.
 *   INTERFERED  a human wrote to this PTY after our text was staged (or we can no
 *               longer prove they did not). NO Enter. NO clear. NO overwrite. NO retry.
 *               The item is held, the human's text is preserved, and further automatic
 *               delivery to this PTY is inhibited until a HUMAN resolves it.
 * A pre-STAGE human write is NEITHER: nothing was typed, so nothing can be interfered
 * with — it is a side-effect-free refusal, and the next drain simply tries again.
 *
 * NO ELECTRON, NO PTY, NO CLOCK OF ITS OWN. Every effect is injected (the pattern
 * `workerWake.ts` already uses), so each state, each guard and each prohibition is
 * provable main-only, and a mutant of any of them can be killed by name.
 */
import { ADMISSION_REASON, type AdmissionDecision, type AdmissionVerdict, type WorkClass } from './capacityAdmission';
import type { PromptBlock } from '../shared/promptState';
import { CODEX_EMPTY_COMPOSER_ROW, classifyCodexComposer, codexPastStartup, codexPopup, codexPopupText, type CodexScreenFacts } from '../shared/codexScreen';

export type { PromptBlock };

// ─── Admission classes: a bypass is DECLARED, never INHERITED (section 3 / 19) ─────────

/**
 * Who is asking, and therefore which admission policy applies. All three share the ONE
 * submission owner for ordering, final revalidation and commit; they differ only in
 * what is asked at ADMIT/READY.
 *
 *   CAPACITY_GATED  an automatic start nobody asked for in this moment: queue drain,
 *                   worker wake. Full gate — capacity, provenance eligibility, provider
 *                   abort capability. The only class that can reach ABORT.
 *   USER_RELEASED   a person pressed "send now". Not an automatic start, so capacity is
 *                   not asked — and therefore no late capacity refusal exists for it.
 *   BOOT_SEQUENCE   remote-control / seed / orientation prompts a spawn requires.
 *
 * The two bypass classes are NOT refused for unproven provenance or an unmeasured
 * provider, because ABORT is unreachable for them by construction (nothing revalidates
 * capacity) and a person or the spawn itself asked for the write. They still serialize
 * here, still get the final revalidation immediately before Enter, and still go
 * INTERFERED on a post-STAGE human write wherever the generation can see one.
 */
export type AdmissionClass = 'CAPACITY_GATED' | 'USER_RELEASED' | 'BOOT_SEQUENCE';

export const ADMISSION_CLASSES: readonly AdmissionClass[] = ['CAPACITY_GATED', 'USER_RELEASED', 'BOOT_SEQUENCE'];

/** Which classes ask provider capacity at all. Total, so a new class cannot be added
 *  without deciding. Only a class that asks capacity can be refused LATE by it, so only
 *  such a class can ever reach ABORT. */
export const ASKS_CAPACITY: Readonly<Record<AdmissionClass, boolean>> = {
  CAPACITY_GATED: true,
  USER_RELEASED: false,
  BOOT_SEQUENCE: false
};

/**
 * What can stand between a submission and the prompt, as main can know it.
 *
 *   ABORT_CAPABILITY_UNVERIFIED  the provider has no MEASURED clear/erase (section 8)
 *   PROVENANCE_INELIGIBLE        the input-provenance mirror says human input cannot be
 *                                proven visible on this terminal right now
 *   PROMPT_UNKNOWN               the renderer has not mirrored the prompt's state at all
 *   PROMPT_PICKER                a user-opened picker owns the input line
 *   PROMPT_DRAFT                 a human draft is sitting on the prompt
 *   PROMPT_SETTLING              the TUI is repainting after a human clear/dismiss
 *   HUMAN_INPUT_RECENT           main itself took a HUMAN write on this PTY moments ago
 *
 * The first three are SUPPORT UNPROVEN. The last four are POSITIVE EVIDENCE that the
 * prompt is a human's right now.
 *
 * WHY HUMAN_INPUT_RECENT EXISTS WHEN PROMPT_DRAFT DOES. The draft arrives by a mirror; the
 * keystroke that started it arrives by the write ingress, one IPC message EARLIER. A
 * submission admitted between those two messages sees a generation that already counts
 * the keystroke (so the pre-STAGE comparison is quiet) and a mirror that still says the
 * prompt is free. Main's own record of when it last took a human write has no such
 * window: it is set in the same operation as the write.
 */
export type GateCondition =
  | 'ABORT_CAPABILITY_UNVERIFIED'
  | 'PROVENANCE_INELIGIBLE'
  | 'PROMPT_UNKNOWN'
  | 'PROMPT_PICKER'
  | 'PROMPT_DRAFT'
  | 'PROMPT_SETTLING'
  | 'HUMAN_INPUT_RECENT';

export const GATE_CONDITIONS: readonly GateCondition[] = [
  'ABORT_CAPABILITY_UNVERIFIED', 'PROVENANCE_INELIGIBLE', 'PROMPT_UNKNOWN',
  'PROMPT_PICKER', 'PROMPT_DRAFT', 'PROMPT_SETTLING', 'HUMAN_INPUT_RECENT'
];

export type GateAction = 'REFUSE' | 'PROCEED';

/**
 * THE ONE POLICY POINT: class x condition -> refuse | proceed. Total in both
 * dimensions; every guard in this file that depends on the class reads it from HERE, so
 * changing an answer is a one-cell edit, and each cell has its own test.
 *
 * HUMAN RULING, 2026-09-20 (card L0-S5-BOOT-GATE, option A), verbatim: "A: automatic
 * delivery gets the full gate with no exceptions. Boot prompts and send-now still go
 * through the one owner, still revalidate before Enter, and still stop on human
 * interference. They are not refused up front just because the provider is unmeasured."
 *
 * So the three SUPPORT-UNPROVEN rows refuse CAPACITY_GATED and nothing else. The four
 * HUMAN-OWNS-THE-LINE rows refuse EVERY class: they are not "unmeasured", they are evidence that a
 * human owns the line, and typing a boot prompt into an open picker loses the prompt
 * and feeds the picker garbage exactly as a queued message would. A refusal types
 * nothing, so the caller simply asks again.
 */
export const READY_GATE_POLICY: Readonly<Record<AdmissionClass, Readonly<Record<GateCondition, GateAction>>>> = {
  CAPACITY_GATED: {
    ABORT_CAPABILITY_UNVERIFIED: 'REFUSE',
    PROVENANCE_INELIGIBLE: 'REFUSE',
    PROMPT_UNKNOWN: 'REFUSE',
    PROMPT_PICKER: 'REFUSE',
    PROMPT_DRAFT: 'REFUSE',
    PROMPT_SETTLING: 'REFUSE',
    HUMAN_INPUT_RECENT: 'REFUSE'
  },
  USER_RELEASED: {
    ABORT_CAPABILITY_UNVERIFIED: 'PROCEED',
    PROVENANCE_INELIGIBLE: 'PROCEED',
    PROMPT_UNKNOWN: 'PROCEED',
    PROMPT_PICKER: 'REFUSE',
    PROMPT_DRAFT: 'REFUSE',
    PROMPT_SETTLING: 'REFUSE',
    HUMAN_INPUT_RECENT: 'REFUSE'
  },
  BOOT_SEQUENCE: {
    ABORT_CAPABILITY_UNVERIFIED: 'PROCEED',
    PROVENANCE_INELIGIBLE: 'PROCEED',
    PROMPT_UNKNOWN: 'PROCEED',
    PROMPT_PICKER: 'REFUSE',
    PROMPT_DRAFT: 'REFUSE',
    PROMPT_SETTLING: 'REFUSE',
    HUMAN_INPUT_RECENT: 'REFUSE'
  }
};

export function gateRefuses(cls: AdmissionClass, condition: GateCondition): boolean {
  return READY_GATE_POLICY[cls][condition] === 'REFUSE';
}

type PromptCondition = 'PROMPT_UNKNOWN' | 'PROMPT_PICKER' | 'PROMPT_DRAFT' | 'PROMPT_SETTLING';

function promptCondition(block: PromptBlock | undefined): PromptCondition | null {
  if (block === undefined) return 'PROMPT_UNKNOWN';
  if (block === 'picker') return 'PROMPT_PICKER';
  if (block === 'draft') return 'PROMPT_DRAFT';
  if (block === 'settling') return 'PROMPT_SETTLING';
  return null; // null = free; 'exited' is answered by the incarnation, not by policy
}

// ─── UNKNOWN is one decision, made by name (section 3) ────────────────────────────────

/**
 * The EVIDENCE conditions behind an UNKNOWN verdict (Dwight section 19: different
 * evidence, whatever action each is given).
 *
 *   NO_POOL                the agent maps to no capacity pool at all. There is no
 *                          capacity-control surface for it. This is OUTSIDE CAPACITY GATING
 *                          - it is NOT "available", and nothing may label it as such.
 *   NO_STATE               a pool is known for the agent and nothing has been observed.
 *   STALE_AFTER_HEALTHY    the pool's reading went stale, and that reading was an
 *                          all-clear. "Stale, last known healthy" - NOT available.
 *   STALE_AFTER_UNHEALTHY  the pool's reading went stale, and that reading was NOT an
 *                          all-clear: a window at zero, a missing number, an unidentified
 *                          window.
 *   INDETERMINATE          observed and unresolvable for a reason that is NOT staleness:
 *                          two readings conflict, a retention cap was breached, the pool
 *                          was restored across a restart and not yet confirmed.
 *
 * WHAT IS NOT HERE, because the tracker never calls it unknown: a pool that went quiet
 * after a provider REFUSAL. A limit epoch outranks staleness, so that pool stays LIMITED
 * (verdict REFUSE) until its known reset boundary passes, and then becomes RECOVERING.
 */
export type UnknownEvidence =
  | 'NO_POOL' | 'NO_STATE' | 'STALE_AFTER_HEALTHY' | 'STALE_AFTER_UNHEALTHY' | 'INDETERMINATE';
export type AdmissionAction = 'PROCEED' | 'HOLD';
export type UnknownPolicy = Readonly<Record<UnknownEvidence, AdmissionAction>>;

/**
 * THE UNKNOWN MAPPING, RATIFIED. One named value; every guard reads it through
 * `resolveAdmission`, so changing an answer is a one-line edit here.
 *
 * HUMAN RULING, 2026-09-20 (card L0-UNKNOWN, REVISED AFTER MEASUREMENT - OPTION (ii)),
 * verbatim: "The measured evidence shows that the previous Option B would create an
 * idle-floor self-deadlock, so revise the stale mapping. POLICY
 * 1. NO POOL CONFIGURED -> PROCEED. State remains 'outside capacity gating'. Never label
 *    this AVAILABLE.
 * 2. FRESH HEALTHY OBSERVATION -> PROCEED.
 * 3. STALE, LAST KNOWN HEALTHY -> PROCEED. Important: do NOT relabel it AVAILABLE; preserve
 *    the state explicitly as 'stale, last known healthy'; final revalidation before Enter
 *    remains mandatory. Rationale: silence after a healthy reading is weak evidence of
 *    exhaustion because provider activity both consumes allowance and produces the next
 *    observation.
 * 4. FRESH NON-HEALTHY OBSERVATION -> HOLD according to the existing capacity policy.
 * 5. STALE, LAST KNOWN NON-HEALTHY -> HOLD while the previously known restriction/reset
 *    remains applicable.
 * 6. KNOWN RESET TIME PASSES -> do NOT mark AVAILABLE. Transition to RECOVERING (or
 *    equivalent explicit post-reset state). Automatic delivery may then PROCEED as the
 *    activity that re-establishes fresh capacity evidence, subject to the normal final
 *    revalidation and all human-interference gates. This is not an inference that capacity
 *    is healthy. It is a controlled post-reset re-probe.
 * STATE INVARIANT: Reset passage must never manufacture AVAILABLE. [...] Do not build a
 * poll as part of this ruling. Do not change the freshness window merely to mask the
 * problem."
 *
 * It supersedes the first L0-UNKNOWN ruling (option B, pinned at 297091d6), which held
 * every stale pool and which measurement showed would self-deadlock an idle floor.
 *
 * WHICH RULES ARE THIS TABLE, AND WHICH ARE NOT. Rules 1 and 3 are cells below. Rules 2, 4,
 * 5 and 6 are NOT unknowns and never reach this table: a fresh healthy pool is verdict
 * ALLOW; a fresh or stale LIMITED / RESERVE_ONLY pool is verdict REFUSE (a limit epoch
 * outranks staleness in the tracker, so "stale, last known limited" is still LIMITED);
 * and a passed reset boundary is the tracker's existing RECOVERING, which admission
 * answers with its existing SINGLE-TURN grant - one delivery, as the re-probe, never
 * AVAILABLE. Nothing here re-implements any of that; the tests prove it end to end.
 *
 * CELLS THE REVISED RULING DOES NOT NAME keep the PREVIOUS ruling's answer, HOLD, and are
 * reported rather than decided here: NO_STATE, INDETERMINATE, and STALE_AFTER_UNHEALTHY
 * (the ruling's rule 5 names it; what it does not name is an exit for it - see the stage
 * report).
 *
 * HOLD IS A HOLD, NOT A DROP AND NOT AN INTERFERENCE. Nothing is typed, the item stays
 * queued, nothing is inhibited, and the caller simply asks again. THERE IS NO TIMEOUT. It
 * ends when an accepted observation gives the pool a resolvable state.
 *
 * THIS IS CAPACITY-STATE UNKNOWN ONLY. Provider abort-capability UNKNOWN and provenance
 * UNKNOWN never pass through here and must never inherit a proceed from it. And only
 * classes that ask capacity at all (`ASKS_CAPACITY`) ever reach it: send-now and boot
 * prompts do not consult this mapping anywhere.
 */
export const UNKNOWN_POLICY: UnknownPolicy = {
  NO_POOL: 'PROCEED',
  NO_STATE: 'HOLD',
  STALE_AFTER_HEALTHY: 'PROCEED',
  STALE_AFTER_UNHEALTHY: 'HOLD',
  INDETERMINATE: 'HOLD'
};

function unknownEvidenceOf(reason: string): UnknownEvidence | null {
  if (reason === ADMISSION_REASON.NO_POOL) return 'NO_POOL';
  if (reason === ADMISSION_REASON.NO_STATE) return 'NO_STATE';
  if (reason === ADMISSION_REASON.STALE_AFTER_HEALTHY) return 'STALE_AFTER_HEALTHY';
  if (reason === ADMISSION_REASON.STALE_AFTER_UNHEALTHY) return 'STALE_AFTER_UNHEALTHY';
  if (reason === ADMISSION_REASON.UNKNOWN) return 'INDETERMINATE';
  return null;
}

export interface ResolvedAdmission { action: AdmissionAction; basis: string }

/**
 * THE ONE TYPED EXHAUSTIVE RESOLVER. Applied at ADMIT, at pre-STAGE revalidation and at
 * final COMMIT revalidation. The tri-state verdict and its reason reach here intact; no
 * authoritative path may first collapse them to a boolean, and no caller may keep a
 * private `!== 'REFUSE'`. An UNKNOWN whose reason this does not recognise HOLDS: an
 * unclassified unknown is a missing fact, and a missing fact is never permission.
 */
export function resolveAdmission(
  decision: { verdict: AdmissionVerdict; reason: string },
  policy: UnknownPolicy
): ResolvedAdmission {
  switch (decision.verdict) {
    case 'ALLOW':
      return { action: 'PROCEED', basis: decision.reason };
    case 'REFUSE':
      return { action: 'HOLD', basis: decision.reason };
    case 'UNKNOWN_NOT_INFERRED_SAFE': {
      const evidence = unknownEvidenceOf(decision.reason);
      if (!evidence) return { action: 'HOLD', basis: `UNCLASSIFIED_UNKNOWN:${decision.reason}` };
      return { action: policy[evidence], basis: `UNKNOWN:${evidence}` };
    }
    default: {
      const unreachable: never = decision.verdict;
      return { action: 'HOLD', basis: `UNRECOGNISED_VERDICT:${String(unreachable)}` };
    }
  }
}

/**
 * What capacity says about an agent, KEPT DISTINCT for anything that displays or reports
 * it. The ruling's STATE INVARIANT: "The UI/state must preserve distinctions such as:
 * outside capacity gating; healthy/fresh; stale, last known healthy; stale, last known
 * limited; recovering after reset; indeterminate." So this is never a boolean, NO_POOL is
 * never a flavour of healthy, and neither a stale all-clear nor a passed reset is ever
 * reported as FRESH_HEALTHY.
 *
 *   NO_POOL                outside capacity gating
 *   FRESH_HEALTHY          healthy / fresh
 *   STALE_AFTER_HEALTHY    stale, last known healthy          (proceeds; NOT healthy)
 *   FRESH_NOT_HEALTHY      a fresh limit or spent window      (held)
 *   STALE_AFTER_LIMITED    stale, last known limited          (held: the epoch outranks staleness)
 *   STALE_AFTER_UNHEALTHY  stale, last known not an all-clear (held)
 *   RECOVERING             recovering after reset             (one re-probe; NOT healthy)
 *   NO_STATE / INDETERMINATE / UNCLASSIFIED                   (held)
 *
 * THE TWO UNNAMED CASES of the revised ruling, as the human then ruled them ("1a, 2a"):
 *   POST_RESET_PROBE       a spent window (no refusal) whose KNOWN reset has passed: a
 *                          SEPARATE state - one probe turn; NOT healthy, NOT RECOVERING
 *   POST_RESET_PROBE_SPENT the one probe has been used                (held until fresh evidence)
 *   LIMITED_NO_KNOWN_RESET limited, no known reset            (held - nothing will lift it;
 *                          shown as itself so a person can release the mail with send-now)
 */
export type CapacityEvidence =
  | 'NO_POOL' | 'FRESH_HEALTHY' | 'STALE_AFTER_HEALTHY' | 'FRESH_NOT_HEALTHY' | 'STALE_AFTER_LIMITED'
  | 'STALE_AFTER_UNHEALTHY' | 'RECOVERING' | 'NO_STATE' | 'INDETERMINATE' | 'UNCLASSIFIED'
  | 'POST_RESET_PROBE' | 'POST_RESET_PROBE_SPENT' | 'LIMITED_NO_KNOWN_RESET';

/** The tracker's own answer to "can this hold end by itself?" - see `resetOutlook`. */
export type ResetOutlook = 'NO_KNOWN_RESET' | 'SPENT_RESET_PASSED' | 'RESET_KNOWN' | null;

export interface CapacityGate {
  evidence: CapacityEvidence;
  /** Would automatic delivery be held right now? Derived through the ONE resolver. */
  holds: boolean;
  basis: string;
}

/**
 * The gate for a probe of the admission seam, through the same resolver and the same
 * policy every guard uses - so what a snapshot SAYS and what the owner DOES cannot drift.
 * `freshness` is the pool's own published freshness (null when there is no pool) and
 * `outlook` the tracker's own `resetOutlook`; both only ever choose BETWEEN labels of a
 * pool that is ALREADY held, and neither can change `holds`.
 */
export function capacityGateOf(
  decision: { verdict: AdmissionVerdict; reason: string },
  freshness: 'FRESH' | 'STALE' | null = null,
  policy: UnknownPolicy = UNKNOWN_POLICY,
  outlook: ResetOutlook = null
): CapacityGate {
  const resolved = resolveAdmission(decision, policy);
  const recovering = decision.reason === ADMISSION_REASON.RECOVERING_GRANT
    || decision.reason === ADMISSION_REASON.RECOVERING_SPENT;
  let evidence: CapacityEvidence;
  if (recovering) evidence = 'RECOVERING';
  // "1a": its OWN state. Never FRESH_HEALTHY (an ALLOW here is one probe, not an all-clear)
  // and never RECOVERING (there is no limit epoch behind it).
  else if (decision.reason === ADMISSION_REASON.POST_RESET_PROBE_GRANT) evidence = 'POST_RESET_PROBE';
  else if (decision.reason === ADMISSION_REASON.POST_RESET_PROBE_SPENT) evidence = 'POST_RESET_PROBE_SPENT';
  else if (decision.verdict === 'ALLOW') evidence = 'FRESH_HEALTHY';
  else if (decision.verdict === 'REFUSE') evidence = freshness === 'STALE' ? 'STALE_AFTER_LIMITED' : 'FRESH_NOT_HEALTHY';
  else evidence = unknownEvidenceOf(decision.reason) ?? 'UNCLASSIFIED';
  const holds = resolved.action === 'HOLD';
  // A more specific NAME for a hold that is already a hold. Never for anything that
  // proceeds: an outlook must not be able to relabel a pool that delivery is flowing to.
  if (holds && outlook === 'NO_KNOWN_RESET' && (evidence === 'FRESH_NOT_HEALTHY' || evidence === 'STALE_AFTER_LIMITED')
    && decision.reason === ADMISSION_REASON.LIMITED) evidence = 'LIMITED_NO_KNOWN_RESET';
  return { evidence, holds, basis: resolved.basis };
}

// ─── Effects ──────────────────────────────────────────────────────────────────────────

export interface OwnerWriteResult { ok: boolean; error?: string }

/** Provider abort capability (section 8). MEASURED or UNKNOWN — there is no third value,
 *  and UNKNOWN disables CAPACITY_GATED staging BEFORE anything is staged. */
export type AbortCapability =
  | { kind: 'VERIFIED'; clearControl: string; settleMs: number }
  | { kind: 'UNKNOWN' };

/** Provenance eligibility as `shared/inputProvenance.ts` answers it. Restated
 *  structurally so this module imports no renderer-facing type it does not need. */
export type ProvenanceEligibility = { eligible: true } | { eligible: false; reason: string; detail?: string };

/** What the rendered screen says about our staged text. The ONLY erase oracle
 *  (section 5.1): the prompt row at `baseY + cursorY`, and the whole screen. */
export interface ScreenReading {
  onPromptRow: boolean;
  screenCount: number;
  /** When requested, the renderer proved that the current logical composer ends in the
   * exact automatic text. It is not a generic "needle seen" answer. */
  promptTailMatches?: boolean;
  /** WAKE-SCREEN-GUARD: the Codex screen facts, when main asked for them. */
  codex?: CodexScreenFacts;
}

/**
 * WAKE-SCREEN-GUARD (1.1.76): does the Codex screen gate apply to this PTY? ENFORCE for a
 * Codex PTY (god's ruling: fail-closed for Codex only), OFF for every other provider, whose
 * behaviour is unchanged. It applies to EVERY admission class: typing into a trust or update
 * screen is the same harm whether a wake, a boot prompt or "send now" asked for it.
 */
export type ScreenGuardMode = 'ENFORCE' | 'OFF';

/** One Codex screen reading, as main receives it. */
export interface GuardReading {
  facts: CodexScreenFacts;
  /** Asked only after a stage write: the composer ends in the exact staged text. */
  promptTailMatches?: boolean;
  /** Stamped by MAIN in the same turn as the request was sent, never by the renderer: the
   *  incarnation, and the output generation whose bytes the reading covers. */
  incarnation: unknown;
  outputGeneration: number;
}

export type ScreenGuardPhase = 'STAGE' | 'COMMIT' | 'REENTER';

/** One screen-gate evaluation, for the diagnostic row. Never screen contents. */
export interface ScreenGuardRecord {
  requestId: string;
  agentId: string;
  ptyId: string;
  admissionClass: AdmissionClass;
  phase: ScreenGuardPhase;
  ok: boolean;
  /** `startup:<reason>`, `<class>:<reason>`, `no-reading`, `incarnation`, or `ok:<reason>`. */
  reason: string;
  incarnation: unknown;
  /** The generation the reading covers, and the live one when it was judged. */
  observedGeneration: number | null;
  currentGeneration: number | null;
  latched: boolean;
  /** DWIGHT-HELD-INTERFERED fix 4: on a COMMIT refusal, what the reading saw (its cursor row and
   *  footer, each row already bounded to CODEX_ROW_MAX), so "is our text still staged?" can be
   *  answered from the log. */
  screen?: GuardScreenFacts;
  /** DWIGHT-INPUT-DEAD-179 F2: on a `startup:` refusal, what condition 1 was decided on. */
  startupScreen?: StartupScreenFacts;
}

/** DWIGHT-HELD-INTERFERED fix 4: the part of a guard reading the log keeps. CODEX-MODEL-SWITCH-
 *  PROMPT P2: and, when Codex shows a popup, what it asks (bounded), so the log names it. */
export interface GuardScreenFacts { cursorRow: string; footer: string[]; popup?: string }

function screenFacts(f: CodexScreenFacts): GuardScreenFacts {
  const popup = codexPopup(f);
  return { cursorRow: f.cursorRow, footer: [...f.footer], ...(popup ? { popup: codexPopupText(popup) } : {}) };
}

/** DWIGHT-INPUT-DEAD-179 F2: the longest row a startup record keeps. */
export const STARTUP_ROW_MAX = 160;
/** DWIGHT-INPUT-DEAD-179 F2: what a startup (condition 1) verdict was decided on, small. The
 *  10-01 and 10-02 holds could only be explained from screen text the Human pasted. The rows ABOVE
 *  the cursor (the conversation) are never kept: the cursor row and the footer under it only. */
export interface StartupScreenFacts { header: CodexScreenFacts['header']; startingAfterHeader: boolean; cursorRow: string; footer: string[] }

function startupScreenFacts(f: CodexScreenFacts): StartupScreenFacts {
  const cut = (row: string): string => (row.length > STARTUP_ROW_MAX ? `${row.slice(0, STARTUP_ROW_MAX - 1)}…` : row);
  return {
    header: f.header, startingAfterHeader: f.startingAfterHeader, cursorRow: cut(f.cursorRow),
    footer: f.footer.map(cut)
  };
}

/** DWIGHT-INPUT-DEAD-179 F2: one startup reading taken with no request behind it (StartupProbe),
 *  reported once per incarnation and verdict reason. */
export interface StartupReadingRecord {
  ptyId: string;
  incarnation: unknown;
  open: boolean;
  /** codexPastStartup's reason (`no-marker`, `status-line`, `header-model`, ...). */
  reason: string;
  outputGeneration: number;
  screen: StartupScreenFacts;
}

/** DWIGHT-HELD-INTERFERED fix 4: one INTERFERED hold, with the last screen facts the owner saw
 *  on that PTY (and how old they are). Diagnostics only. */
export interface InterferedRecord {
  requestId: string;
  agentId: string;
  ptyId: string;
  admissionClass: AdmissionClass;
  reason: InterferenceReason;
  detail?: string;
  /** The last guard reading's facts on this PTY, or null when none was taken (not Codex). */
  screen: GuardScreenFacts | null;
  screenAgeMs: number | null;
  /** The last needle reading (our text on the prompt row, and how often on screen). */
  needle: { onPromptRow: boolean; screenCount: number; ageMs: number } | null;
}

/**
 * DWIGHT-HELD-INTERFERED fix 1: what a fresh look at a held automatic wake found.
 *   RELEASED  the prompt row is the plain empty composer and our text is nowhere on screen, with
 *             no human key since the hold: nothing of ours or a person's is on the prompt. The
 *             hold ends as "let it retry" (not delivered, re-offered through every gate).
 *   ERASED    our text WAS on the prompt row, so the verified erase ran (and was verified).
 *   HELD      anything else; `why` says what.
 *   NONE      no such hold (any more).
 */
export type HeldRecheck =
  | { kind: 'NONE' }
  | { kind: 'RELEASED'; screen: GuardScreenFacts }
  | { kind: 'ERASED'; screen: GuardScreenFacts }
  | { kind: 'HELD'; why: string; screen: GuardScreenFacts | null };

/** WAKE-SCREEN-GUARD: the pause between post-echo readings after a stage write. */
export const SCREEN_COMMIT_RETRY_MS = 250;
/** DWIGHT-HELD-INTERFERED fix 3: the poll while waiting for quiet output before a STAGE reading,
 *  and how long that wait may last; past it the request is refused (nothing typed) and asked
 *  again by the next beat. */
export const STAGE_QUIET_POLL_MS = 100;
export const STAGE_QUIET_BUDGET_MS = 5_000;
/** WSG LIVENESS (rc/1.1.76 ISO, Creed's echo-lag repro): a post-stage reading that is merely
 *  SLOW (no reading, the echo not painted yet, the screen still changing) is re-read until this
 *  long after the stage write. On a loaded machine the echo can land seconds late; 3 readings
 *  250 ms apart held a healthy agent for a person. Past the budget the staged text is ERASED
 *  (verified) and re-offered, never Entered unverified. */
export const SCREEN_COMMIT_SLOW_BUDGET_MS = 10_000;
/** WSG LIVENESS: how long EACH of the screen abort's readings (our text positively seen before
 *  the clear, gone after it) may keep re-reading. A late echo also delays the clear's echo. */
export const SCREEN_ABORT_VERIFY_BUDGET_MS = 15_000;

/** WSG LIVENESS: a failed post-stage reading that says the TERMINAL changed under us (another
 *  incarnation, or Codex starting / resuming / reconfiguring), not that it is slow. */
export function foreignScreenReason(reason: string): boolean {
  // P2: a Codex popup took the screen (our text went into it unechoed, or nowhere): not a slow echo.
  return reason === 'incarnation' || reason.startsWith('startup:') || reason.startsWith('MODAL:');
}

/** WSG-FOLLOWUPS: after a verified erase, the FRAGMENT of our own text still on the Codex
 *  composer row (a half erase), or null. Positive evidence only: the empty composer, an empty
 *  row, or text that is not a piece of ours is not residue. */
export function codexEraseResidue(facts: CodexScreenFacts, text: string): string | null {
  const row = facts.cursorRow.trim();
  if (!row.startsWith('›') || row === CODEX_EMPTY_COMPOSER_ROW) return null;
  const rest = row.slice(1).trim();
  // Jim N-F1: Ctrl-U kills BACKWARD from the cursor, so a real residue is the START of our text,
  // and a 1-2 character row (a human's keystroke, a placeholder mid-redraw) proves nothing.
  return rest.length >= CODEX_RESIDUE_MIN_CHARS && text.startsWith(rest) ? rest : null;
}
/** Jim N-F1: the shortest composer row that counts as a fragment of our text. */
export const CODEX_RESIDUE_MIN_CHARS = 3;

/** The claim capacity is re-asked under. Mirrors `capacityRuntime.DeliveryClaim`. */
export interface OwnerClaim {
  decision: AdmissionDecision;
  agentId: string;
  workClass: WorkClass;
  target: string | null;
}

export interface OwnerDeps {
  /** MAIN resolves the PTY (section 7): a caller never names one. Null = no terminal. */
  resolvePty: (agentId: string) => string | null;
  /** Identity of the LIVE incarnation behind a PTY id, or undefined when it is gone. A
   *  same-id respawn returns a DIFFERENT value: a generation is scoped to one incarnation
   *  and a judgement about a dead terminal must not transfer to its replacement. */
  incarnation: (ptyId: string) => unknown;
  /** The per-live-PTY HUMAN-origin generation (section 4). Opaque; equality only. */
  humanGeneration: (ptyId: string) => number | undefined;
  /** The owner's own write. Never advances the human generation. */
  write: (ptyId: string, data: string) => OwnerWriteResult;
  /** 'READY' to type, 'WAIT' and ask again, 'GONE' if the PTY died. Main answers this. */
  terminalReady: (ptyId: string, agentId: string, waitedMs: number) => 'READY' | 'WAIT' | 'GONE';
  /** Provenance eligibility from the live mirror. Evaluated fresh on every guard. */
  eligibility: (ptyId: string) => ProvenanceEligibility;
  /** The prompt's state as the renderer mirrors it into main: picker latch, human
   *  draft, settle. Re-read before STAGE and inside the critical section (section 5.3:
   *  a latch consulted once is a latch that can open afterwards). `undefined` = never
   *  mirrored. NEVER an interference or erase oracle: it only says whose the line is. */
  promptBlock: (ptyId: string) => PromptBlock | undefined;
  /** When main last took a declared-HUMAN write on this PTY, set in the same operation
   *  as the write. Undefined = never. */
  lastHumanInputAt: (ptyId: string) => number | undefined;
  abortCapability: (agentId: string) => AbortCapability;
  /** Read the rendered screen for `needle`. Resolves null when nothing can answer. */
  readScreen: (ptyId: string, needle: string, expectedTail?: string) => Promise<ScreenReading | null>;
  capacity: {
    admit: (agentId: string, workClass: WorkClass) => AdmissionDecision;
    /** Admission's own question re-asked NOW for this claim, tri-state intact. A
     *  structurally dead claim (wrong target, moved pool, new epoch, lost grant) answers
     *  REFUSE with its reason; a RECOVERING pool whose one turn THIS claim holds answers
     *  ALLOW. */
    revalidate: (claim: OwnerClaim) => { verdict: AdmissionVerdict; reason: string };
    confirmLaunch: (decision: AdmissionDecision) => void;
    cancelGrant: (decision: AdmissionDecision) => void;
    /** POSSIBLY LAUNCHED, awaiting a person (INTERFERED). Must not expire on a timer;
     *  ends only by `confirmLaunch` or `cancelGrant`. Idempotent. */
    holdGrant: (decision: AdmissionDecision) => void;
  };
  unknownPolicy?: UnknownPolicy;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** Told of every settled outcome. Diagnostics and UI; never a decision input. */
  onOutcome?: (record: OutcomeRecord) => void;
  /** START-FIXES-163 (3): told of every automatic Enter write, ok or failed, with the
   *  gap it waited after staging. Diagnostics only; never a decision input. */
  onEnterWrite?: (record: EnterWriteRecord) => void;
  /** CODEX-WAKE-161 F1: the gap between the staged text and its Enter on this PTY, when the
   *  provider needs longer than GAP_MS (see providerAutomation.automaticEnterGapMs). Absent or
   *  null = GAP_MS. */
  enterGapMs?: (ptyId: string, textLength: number) => number | null;
  /** CODEX-WAKE-161 F3: after the Enter, read the composer and require our text GONE from
   *  it before settling COMMITTED (a TUI that turned the Enter into a newline leaves it
   *  there). Absent / false = the write-level COMMITTED as before. */
  verifySubmit?: (ptyId: string) => boolean;
  /** WAKE-SCREEN-GUARD: whether the Codex screen gate applies. Absent = OFF. */
  screenGuard?: (ptyId: string) => ScreenGuardMode;
  /** WAKE-SCREEN-GUARD: a FRESH Codex screen reading, stamped by main. Null = no reading. */
  readGuardScreen?: (ptyId: string, expectedTail?: string) => Promise<GuardReading | null>;
  /** WAKE-SCREEN-GUARD: the live output generation (undefined = no live session). */
  outputGeneration?: (ptyId: string) => number | undefined;
  /** WAKE-SCREEN-GUARD: the cwd the PTY was spawned in (Codex's status line shows it). */
  spawnCwd?: (ptyId: string) => string | undefined;
  /** WAKE-SCREEN-GUARD (Jim B2): the user's home, for the status line's `~\rel` cwd form. */
  homeDir?: () => string | undefined;
  /** WAKE-SCREEN-GUARD: told of every screen-gate evaluation. Diagnostics only. */
  onScreenGuard?: (record: ScreenGuardRecord) => void;
  /** DWIGHT-INPUT-DEAD-179 F2: told of a startup reading, once per incarnation and reason.
   *  Diagnostics only. */
  onStartupReading?: (record: StartupReadingRecord) => void;
  /** DWIGHT-INPUT-DEAD-179 F4: Codex wrote `thread_settings_applied` to this PTY's rollout after
   *  its LIVE incarnation was spawned. Absent, throwing or false = no proof. */
  threadConfigured?: (ptyId: string) => boolean;
  /** DWIGHT-HELD-INTERFERED fix 3: how long this PTY's output must have been quiet before the
   *  STAGE reading (see providerAutomation.automaticStageQuietMs). Absent / null / 0 = no wait. */
  stageQuietMs?: (ptyId: string) => number | null | undefined;
  /** DWIGHT-HELD-INTERFERED fix 4: told of every INTERFERED hold. Diagnostics only. */
  onInterfered?: (record: InterferedRecord) => void;
  /** GOD-STARTUP-WAITS-ENTER G1: may a BOOT_SEQUENCE prompt be typed into this PTY yet? `false` =
   *  the provider's own "session is up" proof for the LIVE incarnation (Claude's SessionStart,
   *  then a settle) has not arrived: refused, nothing typed, the caller asks again. `undefined`
   *  = this provider has no such proof (the plain terminal-ready rule applies). */
  bootReady?: (ptyId: string, agentId: string) => boolean | undefined;
  /** GOD-STARTUP-WAITS-ENTER G2: has the provider reported a submitted prompt (Claude's
   *  UserPromptSubmit) for this PTY's live incarnation at or after `enterAt`? `undefined` = this
   *  provider has no such report, and a boot Enter is not verified. */
  bootSubmitted?: (ptyId: string, agentId: string, enterAt: number) => boolean | undefined;
}

// ─── Requests and outcomes ────────────────────────────────────────────────────────────

export interface SubmitRequest {
  /** Idempotency key (section 7). Binds immutably to everything below. */
  requestId: string;
  agentId: string;
  admissionClass: AdmissionClass;
  text: string;
  /** How long the owner keeps holding the PTY after a COMMIT. Default SETTLE_MS. */
  settleMs?: number;
  /** CODEX-FALSEACTIVE-153: the text of an EARLIER automatic submit that was entered but
   *  never became a provider turn, so it may still sit unsent in the composer. Before
   *  anything is staged the screen must show it is NOT there: still
   *  there is INTERFERED (held for a person, never typed after it); no reading is REFUSED
   *  (nothing typed, asked again later). Absent = no such check. */
  priorText?: string;
}

export type RefusalReason =
  | 'NO_PTY'
  | 'PTY_INHIBITED'
  | 'CAPACITY_HOLD'
  | 'PROVIDER_ABORT_UNVERIFIED'
  | 'PROVENANCE_INELIGIBLE'
  | 'TERMINAL_NOT_READY'
  | 'PTY_GONE'
  | 'PTY_REPLACED'
  | 'PROMPT_UNKNOWN'
  | 'PROMPT_PICKER'
  | 'PROMPT_DRAFT'
  | 'PROMPT_SETTLING'
  | 'HUMAN_INPUT_RECENT'
  | 'HUMAN_INPUT_BEFORE_STAGE'
  | 'STAGE_WRITE_FAILED'
  | 'PRIOR_TEXT_UNVERIFIED'
  /** WAKE-SCREEN-GUARD: a Codex screen that is not proven to be the post-handoff composer. */
  | 'SCREEN_NOT_READY'
  /** WAKE-SCREEN-GUARD: Codex output arrived after the screen reading that admitted this. */
  | 'SCREEN_CHANGED';

export type InterferenceReason =
  | 'HUMAN_INPUT_AFTER_STAGE'
  | 'PICKER_LATCHED_AFTER_STAGE'
  | 'PROMPT_UNKNOWN_AFTER_STAGE'
  | 'PROVENANCE_LOST_AFTER_STAGE'
  | 'ABORT_CAPABILITY_UNVERIFIED'
  | 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE'
  | 'CLEAR_WRITE_FAILED'
  | 'ERASE_NOT_VERIFIED'
  | 'ERASE_LEFT_RESIDUE'
  | 'ENTER_WRITE_FAILED'
  | 'PRIOR_TEXT_ON_PROMPT'
  | 'PRIOR_TEXT_UNREADABLE'
  /** CODEX-WAKE-161 F3: our text was still in the composer after the Enter AND after one
   *  more Enter of our own: the TUI is not taking it. Held for a person, visibly. */
  | 'SUBMIT_NOT_ACCEPTED'
  /** WAKE-SCREEN-GUARD: after our stage write, no reading proved the screen still the Codex
   *  composer holding exactly our text with no output since. No Enter: held for a person. */
  | 'SCREEN_NOT_VERIFIED_AFTER_STAGE'
  /** CODEX-MODEL-SWITCH-PROMPT P3: a Codex popup was on screen when the erase would have run.
   *  The app never types into a popup (not the erase, not Esc): held for a person, visibly. */
  | 'CODEX_POPUP_OPEN'
  /** GOD-STARTUP-WAITS-ENTER G2: a boot prompt's Enter (and at most one more of our own) brought
   *  no UserPromptSubmit from the provider: the prompt sits typed but unsent. Held for a person,
   *  visibly; never a third Enter, and none at all after a person's key. */
  | 'BOOT_NOT_SUBMITTED';

export type SubmitOutcome =
  /** The Enter went out. The one outcome a caller may acknowledge a queue item on. */
  | { kind: 'COMMITTED' }
  /** Nothing was typed. Side-effect-free: no residue, nothing inhibited. Retry freely. */
  | { kind: 'REFUSED'; reason: RefusalReason; detail?: string }
  /** Typed, then verifiably erased after a late capacity refusal. Retryable. */
  | { kind: 'ABORTED'; detail: string }
  /** Held. NOT retryable by automation. The PTY is inhibited until a human resolves it. */
  | { kind: 'INTERFERED'; reason: InterferenceReason; detail?: string }
  /** The staged text died with its terminal; nothing of ours remains anywhere. */
  | { kind: 'FAILED'; reason: 'PTY_REPLACED_AFTER_STAGE' | 'PTY_GONE_AFTER_STAGE' }
  /** The id was presented with different arguments than it is bound to. */
  | { kind: 'REJECTED'; reason: 'ID_BINDING_MISMATCH' }
  /** A PERSON resolved an INTERFERED hold with "already handled - drop": they dealt with
   *  this content themselves. Recorded against the id, so it is never typed again. */
  | { kind: 'HUMAN_HANDLED' };

export interface OutcomeRecord {
  requestId: string;
  agentId: string;
  ptyId: string | null;
  admissionClass: AdmissionClass;
  outcome: SubmitOutcome;
  at: number;
}

/** START-FIXES-163 (3): one automatic Enter write, for the boot-submit rows. */
export interface EnterWriteRecord {
  requestId: string;
  agentId: string;
  ptyId: string;
  admissionClass: AdmissionClass;
  ok: boolean;
  error?: string;
  /** What the owner waited between staging and this Enter (0 for a re-Enter). */
  gapMs: number;
  /** True for a re-Enter on our own untouched prior draft (no STAGE). */
  reentry: boolean;
}

export interface Inhibition { requestId: string; reason: InterferenceReason; at: number; incarnation: unknown }

/**
 * HOW A PERSON RESOLVES AN INTERFERED HOLD (human ruling, option B). There are exactly two
 * answers and no default, because the single "resolved" they replace could not tell them
 * apart - and NOTHING HERE INFERS WHICH HAPPENED: an empty prompt is not proof that the
 * staged message was submitted.
 *
 *   SEND_AGAIN       "I dealt with the interference; the message has NOT been handled."
 *                    The hold is released, the possibly-launched grant is RETURNED, the id
 *                    is released, and the item is re-admitted through this same owner with
 *                    every gate. Nothing is typed by resolving.
 *   ALREADY_HANDLED  "I handled / submitted this content myself."
 *                    The hold is released, the grant is CONFIRMED as a launch (spent), and
 *                    the id is recorded HUMAN_HANDLED so it can never be typed again.
 *                    Nothing is typed, no Enter, no retry.
 */
export type InterferenceResolution = 'SEND_AGAIN' | 'ALREADY_HANDLED';
export const INTERFERENCE_RESOLUTIONS: readonly InterferenceResolution[] = ['SEND_AGAIN', 'ALREADY_HANDLED'];

/** What the owner keeps for a hold: the public facts, plus whose grant is in suspense. */
interface HeldInterference extends Inhibition {
  agentId: string;
  admissionClass: AdmissionClass;
  binding: Binding;
  decision: AdmissionDecision | null;
  /** DWIGHT-HELD-INTERFERED fix 1: the staged text and the human generation at STAGE, so a later
   *  look can find our text and know whether a person has touched the terminal since. */
  text: string;
  humanStage: number;
}

/** The irreducible TUI interval between a paste and its Enter. */
export const GAP_MS = 140;
/** Default hold after a COMMIT before the next submission may type. */
export const SETTLE_MS = 250;
export const READY_POLL_MS = 100;
export const READY_TIMEOUT_MS = 30_000;
export const SCREEN_ORACLE_TIMEOUT_MS = 2_000;
/** How long a settled outcome stays replayable — long enough to cover a lost reply or a
 *  renderer reload, short enough that the map stays bounded. */
export const OUTCOME_REPLAY_TTL_MS = 5 * 60_000;
/** PRIOR TEXT (CODEX-FALSEACTIVE-153): an unreadable screen refuses, and the claim that carries
 *  the prior text is asked again - but that claim is every later wake of the agent, so an
 *  unreadable screen would block its new mail forever (Jim, WAKE-CONFIRM-AUDIT-153 note 2).
 *  After this many consecutive unreadable checks, or this long since the first, the owner
 *  holds it for a person instead (INTERFERED PRIOR_TEXT_UNREADABLE: visible, resolvable). */
export const PRIOR_TEXT_UNREADABLE_MAX = 5;
export const PRIOR_TEXT_UNREADABLE_HOLD_MS = 10 * 60_000;
/** CODEX-WAKE-161 F3: how often, and for how long, the composer is re-read after an Enter
 *  for our text to leave it. A TUI redraws its cleared composer within a frame or two; the
 *  window only has to outlast the renderer's parse of that redraw. */
export const SUBMIT_VERIFY_POLL_MS = 250;
/** CODEX-WAKE-162: 2.5 s (was 1.5 s): under load a TUI's redraw can lag the Enter. */
export const SUBMIT_VERIFY_WINDOW_MS = 2_500;
/** WSG LIVENESS (rc/1.1.76 final gate): how long a Codex Enter that produced NO output yet
 *  (still queued in a slow TUI) is waited for before settling COMMITTED, unconfirmed. */
export const SUBMIT_SLOW_BUDGET_MS = 10_000;
/** CODEX-WAKE-162: 'gone' must be read this many times in a row before COMMITTED (one
 *  mid-redraw frame is not proof). */
export const SUBMIT_GONE_READS = 2;
/** GOD-STARTUP-WAITS-ENTER G2: how long a boot prompt's Enter waits for the provider's own
 *  "prompt submitted" report (Claude UserPromptSubmit) before it is judged unsent. The hook
 *  arrives well under a second after a real submit; 5 s is the hang guard, not a bet. */
export const BOOT_SUBMIT_CONFIRM_MS = 5_000;
/** A human write this recent means the line is theirs, whatever the mirror says yet.
 *  Longer than the renderer's own ECHO_GRACE (1000 ms), inside which even the renderer
 *  does not trust the screen to overrule a keystroke. */
export const HUMAN_QUIET_MS = 1_500;
/** A needle shorter than this matches too easily to be evidence of anything. */
export const MIN_NEEDLE = 4;
const MAX_NEEDLE = 16;

/** What the owner actually writes for `text`. Bracketed paste only for MULTI-LINE text:
 *  some TUIs (agy) treat the markers as literal input, so single-line stays raw (#24). */
export function payloadFor(text: string): string {
  return text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
}

/** The slice of our own text the screen oracle looks for: the head of the first
 *  non-empty line, short enough to survive a narrow prompt. Null = nothing usable, in
 *  which case an erase can never be positively verified and ABORT resolves INTERFERED. */
export function needleFor(text: string): string | null {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const needle = first.slice(0, MAX_NEEDLE).trimEnd();
  return needle.length >= MIN_NEEDLE ? needle : null;
}

/**
 * The needles that find an UNSENT earlier text on the prompt row: its TAIL, not its head.
 * The cursor sits right after text typed into a composer, and a long nudge wraps, so only
 * its end is on the cursor's row; once submitted, the transcript echoes the whole text
 * ABOVE an empty composer and the cursor's row holds none of it. Two lengths, so a row
 * boundary inside the longer tail still leaves the short one whole on the cursor's row.
 * (Residual: a boundary inside the last few characters is not seen.)
 */
export function priorTextNeedles(text: string): string[] {
  const t = text.trimEnd();
  if (t.length < MIN_NEEDLE) return [];
  return [...new Set([t.slice(-MAX_NEEDLE).trimStart(), t.slice(-MIN_NEEDLE)])].filter((n) => n.length >= MIN_NEEDLE);
}

function payloadIdentity(text: string): string {
  // Not cryptographic — it only has to tell "the same request again" from "a different
  // request under the same id". Length + FNV-1a over the text.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length}:${h.toString(16)}`;
}

/** Everything the COMMIT critical section and ABORT need about one staged submission. */
interface Staged {
  req: SubmitRequest;
  ptyId: string;
  incarnation: unknown;
  /** Null for the bypass classes: capacity was never asked, so none is re-asked. */
  decision: AdmissionDecision | null;
  humanStage: number;
  /** WAKE-SCREEN-GUARD: the output generation of the reading that cleared this Enter.
   *  Set = the Enter needs the live generation to still equal it. */
  screenGen?: number;
}

type CommitVerdict =
  | { kind: 'ENTERED'; ok: boolean; error?: string }
  | { kind: 'LATE_REFUSAL'; basis: string }
  | { kind: 'INTERFERED'; reason: InterferenceReason; detail?: string }
  | { kind: 'FAILED'; reason: 'PTY_REPLACED_AFTER_STAGE' | 'PTY_GONE_AFTER_STAGE' }
  /** WAKE-SCREEN-GUARD: output arrived after the reading that cleared this Enter. Nothing
   *  was written. */
  | { kind: 'SCREEN_CHANGED' };

function safeWrite(deps: OwnerDeps, ptyId: string, data: string): OwnerWriteResult {
  try {
    const r = deps.write(ptyId, data);
    return r && r.ok === true ? { ok: true } : { ok: false, error: r?.error ?? 'write refused' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The guards shared by the COMMIT section and the pre-destructive ABORT check: is the
 * line still exactly as we left it, as far as main can know? Synchronous, pure reads.
 */
function postStageGuard(s: Staged, deps: OwnerDeps): CommitVerdict | null {
  const live = deps.incarnation(s.ptyId);
  if (live === undefined) return { kind: 'FAILED', reason: 'PTY_GONE_AFTER_STAGE' };
  if (live !== s.incarnation) return { kind: 'FAILED', reason: 'PTY_REPLACED_AFTER_STAGE' };
  // ONLY A POST-STAGE CHANGE IS INTERFERENCE, and this is the post-STAGE baseline.
  if (deps.humanGeneration(s.ptyId) !== s.humanStage) {
    return { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' };
  }
  const cls = s.req.admissionClass;
  // A draft or a settle after STAGE can only come from a human action, which the
  // generation above already caught. The picker latch and an unmirrored prompt are the
  // two prompt facts the generation cannot stand in for.
  const block = deps.promptBlock(s.ptyId);
  if (block === 'picker') return { kind: 'INTERFERED', reason: 'PICKER_LATCHED_AFTER_STAGE' };
  if (block === undefined && gateRefuses(cls, 'PROMPT_UNKNOWN')) {
    return { kind: 'INTERFERED', reason: 'PROMPT_UNKNOWN_AFTER_STAGE' };
  }
  if (gateRefuses(cls, 'PROVENANCE_INELIGIBLE')) {
    // RUNTIME AND RE-ENTRANT: a TUI that turned mouse tracking on inside the gap has
    // opened an input path the generation cannot see, so "nobody typed" is no longer
    // provable. Not provable is not safe to Enter and not safe to erase.
    const e = deps.eligibility(s.ptyId);
    if (!e.eligible) return { kind: 'INTERFERED', reason: 'PROVENANCE_LOST_AFTER_STAGE', detail: e.reason };
  }
  return null;
}

/**
 * THE COMMIT CRITICAL SECTION (section 2).
 *
 * ONE NON-YIELDING main check -> terminal write -> in-turn settle. BETWEEN THE FINAL
 * CHECK AND THE RECORDED OUTCOME THERE MAY BE: no `await`, no `.then`, no timer, no
 * microtask, no IPC send or reply, no async function boundary, no dynamic import, and no
 * call into anything that can yield. That list is CONSERVATIVE, NOT THE DEFINITION
 * (section 18): a construct that is not on it is not thereby permitted — it is judged
 * against the invariant, and the list grows.
 *
 * A registered test reads this function's source for the listed constructs, and a
 * behavioural test injects an AVAILABLE->LIMITED observation that lands in the first
 * yield after the check: with the section intact the record reads `enter:AVAILABLE`
 * or `abort:LIMITED`, never `enter:LIMITED`.
 */
export function commitSection(s: Staged, deps: OwnerDeps): CommitVerdict {
  const blocked = postStageGuard(s, deps);
  if (blocked) return blocked;
  if (s.decision) {
    const claim: OwnerClaim = {
      decision: s.decision, agentId: s.req.agentId, workClass: s.decision.workClass, target: s.ptyId
    };
    const now = resolveAdmission(deps.capacity.revalidate(claim), deps.unknownPolicy ?? UNKNOWN_POLICY);
    if (now.action !== 'PROCEED') return { kind: 'LATE_REFUSAL', basis: now.basis };
  }
  // WAKE-SCREEN-GUARD: the Codex screen that cleared this Enter is still the screen: no byte
  // of output since that reading. Synchronous, next to the write.
  if (s.screenGen !== undefined && deps.outputGeneration?.(s.ptyId) !== s.screenGen) return { kind: 'SCREEN_CHANGED' };
  const entered = safeWrite(deps, s.ptyId, '\r');
  if (s.decision) {
    if (entered.ok) deps.capacity.confirmLaunch(s.decision);
    // The Enter did not go out, but our payload is still on a live prompt where a person
    // can press it: the evidence has run out, so the grant is HELD as possibly launched
    // (never returned here) and the INTERFERED hold that follows carries it to a human.
    else deps.capacity.holdGrant(s.decision);
  }
  return { kind: 'ENTERED', ok: entered.ok, error: entered.error };
}

interface Binding { agentId: string; admissionClass: AdmissionClass; payload: string }
interface Known { binding: Binding; promise: Promise<SubmitOutcome>; settled: { at: number | null } }

export class AutomaticSubmitOwner {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly known = new Map<string, Known>();
  private readonly inhibited = new Map<string, HeldInterference>();
  /** PRIOR TEXT: consecutive unreadable checks per PTY (see PRIOR_TEXT_UNREADABLE_MAX). */
  private readonly priorUnreadable = new Map<string, { count: number; since: number }>();
  /** The last text this owner staged and Entered on each live PTY. A later retry may press
   * Enter again only when the renderer proves that exact text still occupies the composer
   * AND no human generation advanced since we staged it. */
  private readonly ownDrafts = new Map<string, { text: string; humanStage: number; incarnation: unknown }>();
  /** WAKE-SCREEN-GUARD condition 1: the Codex incarnation on each PTY that has been proven
   *  past its startup phase (trust, login and update all precede the handoff, so within one
   *  process that phase never comes back). A new incarnation starts un-latched. Never a
   *  substitute for the fresh reading every request needs. */
  private readonly postHandoff = new Map<string, unknown>();
  /** DWIGHT-HELD-INTERFERED fix 4: the last guard facts and needle reading seen on each PTY. */
  private readonly lastScreen = new Map<string, { facts: GuardScreenFacts; at: number }>();
  private readonly lastNeedle = new Map<string, { onPromptRow: boolean; screenCount: number; at: number }>();

  constructor(private readonly deps: OwnerDeps) {}

  /** WAKE-SCREEN-GUARD R2-4: a Codex SessionStart whose per-incarnation token main has
   *  matched to THIS live incarnation. An extra way to latch condition 1; never required. */
  latchPostHandoff(ptyId: string, incarnation: unknown): boolean {
    if (incarnation === undefined || this.deps.incarnation(ptyId) !== incarnation) return false;
    this.postHandoff.set(ptyId, incarnation);
    return true;
  }

  /** WAKE-SCREEN-GUARD: is this PTY's LIVE incarnation latched past startup? */
  postHandoffLatched(ptyId: string): boolean {
    const live = this.deps.incarnation(ptyId);
    return live !== undefined && this.postHandoff.get(ptyId) === live;
  }

  /** WSG-CODEX-STARTUP-NO-MARKER: would a startup reading of this PTY be useful (the screen gate
   *  applies and its live incarnation is not latched yet)? */
  startupProbeWanted(ptyId: string): boolean {
    return this.guardMode(ptyId) === 'ENFORCE' && this.deps.incarnation(ptyId) !== undefined && !this.postHandoffLatched(ptyId);
  }

  /**
   * WSG-CODEX-STARTUP-NO-MARKER fix 1(a): a Codex screen reading with NO request behind it,
   * taken while the session header is on screen (right after spawn, and after each output
   * burst while un-latched). It can only ADD the condition-1 latch, by the same rule as
   * screenGate (codexPastStartup on a reading of this incarnation that covers real output). It
   * types nothing and refuses nothing; every request still needs its own fresh reading.
   * Without it, Codex erasing its header on a resize (ESC[3J + a capped replay) before the
   * first request leaves the latch waiting on a turn that only a delivery could start.
   */
  async observeStartup(ptyId: string): Promise<boolean> {
    const deps = this.deps;
    if (!this.startupProbeWanted(ptyId)) return this.postHandoffLatched(ptyId);
    const incarnation = deps.incarnation(ptyId);
    const r = await this.readGuard(ptyId);
    if (!r || r.incarnation !== incarnation || deps.incarnation(ptyId) !== incarnation) return false;
    const past = codexPastStartup(r.facts, deps.spawnCwd?.(ptyId), deps.homeDir?.());
    this.reportStartupReading(ptyId, incarnation, past, r);
    if (past.open && r.outputGeneration > 0) { this.postHandoff.set(ptyId, incarnation); return true; }
    if (this.threadProof(ptyId, r)) {
      this.postHandoff.set(ptyId, incarnation);
      this.reportStartupReading(ptyId, incarnation, { open: true, reason: 'thread-settings' }, r);
      return true;
    }
    return false;
  }

  /**
   * DWIGHT-INPUT-DEAD-179 F4: a proof of condition 1 that needs no screen marker. Codex wrote
   * `thread_settings_applied` to its rollout AFTER this incarnation was spawned, so its chat is
   * configured: that happens inside App::run, after the onboarding screens (trust, login). Only
   * the LATCH is taken from it; every request still needs its own fresh reading, which refuses
   * a popup, a `loading` header or a resume line whatever the latch says. A reading that covers
   * no output (N1) proves nothing either way.
   */
  private threadProof(ptyId: string, r: GuardReading): boolean {
    if (r.outputGeneration <= 0) return false;
    try { return this.deps.threadConfigured?.(ptyId) === true; } catch { return false; }
  }

  /** DWIGHT-INPUT-DEAD-179 F2: which startup verdict reasons were already reported, per PTY, for
   *  its current incarnation (a new incarnation starts a new set; at most one row per reason). */
  private readonly startupReported = new Map<string, { incarnation: unknown; reasons: Set<string> }>();

  private reportStartupReading(ptyId: string, incarnation: unknown, past: { open: boolean; reason: string }, r: GuardReading): void {
    try {
      let seen = this.startupReported.get(ptyId);
      if (!seen || seen.incarnation !== incarnation) {
        seen = { incarnation, reasons: new Set() };
        this.startupReported.set(ptyId, seen);
      }
      if (seen.reasons.has(past.reason)) return;
      seen.reasons.add(past.reason);
      this.deps.onStartupReading?.({
        ptyId, incarnation, open: past.open, reason: past.reason, outputGeneration: r.outputGeneration,
        screen: startupScreenFacts(r.facts)
      });
    } catch { /* diagnostics never decide */ }
  }

  /**
   * Submit one programmatic message. Resolves with what HAPPENED; never rejects.
   *
   * IDEMPOTENT ON `requestId` (section 7). The same id with the same binding returns the
   * same outcome — in flight or settled — and types nothing twice: a replay after COMMIT
   * writes no second Enter. The same id with ANY different argument is REJECTED; it does
   * not get the prior success for a different request.
   *
   * WHAT IS REMEMBERED, AND WHAT IS NOT. COMMITTED and INTERFERED are FACTS ABOUT THE
   * PROMPT: the message went out, or it is sitting there held. Those are recorded, so a
   * caller that lost the reply or was reloaded learns what happened instead of typing it
   * again. REFUSED, ABORTED and FAILED left NOTHING of ours on any live prompt; they are
   * "not delivered, ask again", so the id is released the moment they settle and the SAME
   * id may be retried. That is what lets a caller use one stable id per message — a
   * message is delivered AT MOST ONCE, however many times it is asked.
   */
  submit(req: SubmitRequest): Promise<SubmitOutcome> {
    this.sweep();
    const binding: Binding = {
      agentId: req.agentId, admissionClass: req.admissionClass, payload: payloadIdentity(req.text)
    };
    const prior = this.known.get(req.requestId);
    if (prior) {
      const same = prior.binding.agentId === binding.agentId
        && prior.binding.admissionClass === binding.admissionClass
        && prior.binding.payload === binding.payload;
      return same ? prior.promise : Promise.resolve({ kind: 'REJECTED', reason: 'ID_BINDING_MISMATCH' });
    }
    const ptyId = this.deps.resolvePty(req.agentId);
    const settled = { at: null as number | null };
    const promise = this.enqueue(req, ptyId).then((outcome) => {
      settled.at = this.deps.now();
      if (outcome.kind !== 'COMMITTED' && outcome.kind !== 'INTERFERED'
        && this.known.get(req.requestId)?.promise === promise) {
        this.known.delete(req.requestId);
      }
      try {
        this.deps.onOutcome?.({
          requestId: req.requestId, agentId: req.agentId, ptyId,
          admissionClass: req.admissionClass, outcome, at: settled.at
        });
      } catch { /* diagnostics never decide */ }
      return outcome;
    });
    this.known.set(req.requestId, { binding, promise, settled });
    return promise;
  }

  /** Is automatic delivery to this PTY inhibited by an unresolved INTERFERED? */
  inhibition(ptyId: string): Inhibition | null {
    const held = this.inhibited.get(ptyId);
    if (!held) return null;
    // Scoped to the incarnation it was raised on: the staged text and the human's text
    // both died with that process, and the replacement has a clean prompt.
    if (this.deps.incarnation(ptyId) !== held.incarnation) {
      this.inhibited.delete(ptyId);
      // Nobody can now say whether a person pressed Enter on our payload before the
      // terminal died. Where the evidence runs out we fail toward ALREADY LAUNCHED: the
      // grant is spent, not handed back. The ID is released - the text died unsent as far
      // as the queue can tell, and re-delivery goes through every gate on the new process.
      if (held.decision) this.deps.capacity.confirmLaunch(held.decision);
      if (this.known.get(held.requestId)?.binding === held.binding) this.known.delete(held.requestId);
      return null;
    }
    return { requestId: held.requestId, reason: held.reason, at: held.at, incarnation: held.incarnation };
  }

  /** A HUMAN says the held prompt is dealt with, AND SAYS HOW (`InterferenceResolution`).
   *  The only way a person's hold ends while its terminal lives — there is no timer, because
   *  a timer is automation deciding that a human's text no longer matters. (An AUTOMATIC wake's
   *  hold may also end by `recheckHeld`, on positive screen evidence only: DWIGHT-HELD-INTERFERED.)
   *  There is no default resolution: an answer that is not one of the two is refused and the
   *  hold stays. Writes nothing to any terminal, whichever answer it is. */
  resolveInterference(ptyId: string, how: InterferenceResolution): boolean {
    if (!INTERFERENCE_RESOLUTIONS.includes(how)) return false;
    if (!this.inhibition(ptyId)) return false; // also retires a hold whose terminal died
    const held = this.inhibited.get(ptyId)!;
    this.inhibited.delete(ptyId);
    const mine = this.known.get(held.requestId)?.binding === held.binding;
    if (how === 'SEND_AGAIN') {
      // Not launched, on a person's word: the turn goes back, and the id is released so
      // re-admitting the same message does not replay the hold it was just released from.
      if (held.decision) this.deps.capacity.cancelGrant(held.decision);
      if (mine) this.known.delete(held.requestId);
    } else {
      // Launched by the person: the turn is spent, and the id answers HUMAN_HANDLED from
      // now on - so a copy of the item that is asked for again is never typed.
      if (held.decision) this.deps.capacity.confirmLaunch(held.decision);
      const at = this.deps.now();
      const outcome: SubmitOutcome = { kind: 'HUMAN_HANDLED' };
      this.known.set(held.requestId, { binding: held.binding, promise: Promise.resolve(outcome), settled: { at } });
      try {
        this.deps.onOutcome?.({ requestId: held.requestId, agentId: held.agentId, ptyId, admissionClass: held.admissionClass, outcome, at });
      } catch { /* diagnostics never decide */ }
    }
    return true;
  }

  private sweep(): void {
    const now = this.deps.now();
    for (const [id, k] of this.known) {
      if (k.settled.at !== null && now - k.settled.at > OUTCOME_REPLAY_TTL_MS) this.known.delete(id);
    }
  }

  /** ONE chain per PTY: every class, every caller. This is the single ordering authority
   *  for programmatic text+Enter, and the PTY is held against other programmatic writers
   *  from before STAGE until the post-COMMIT settle has elapsed. */
  private enqueue(req: SubmitRequest, ptyId: string | null): Promise<SubmitOutcome> {
    if (!ptyId) return Promise.resolve({ kind: 'REFUSED', reason: 'NO_PTY' });
    const prev = this.chains.get(ptyId) ?? Promise.resolve();
    const result = prev.then(async (): Promise<SubmitOutcome> => {
      try {
        return await this.run(req, ptyId);
      } catch (e) {
        // A bug in here must not wedge the chain or reject into a caller that was
        // promised a value. Nothing is claimed about what was typed.
        return { kind: 'REFUSED', reason: 'STAGE_WRITE_FAILED', detail: `owner error: ${String(e)}` };
      }
    });
    // The NEXT submission waits for this one AND for its post-COMMIT settle; the caller
    // does not — its outcome is a fact the moment the Enter result is recorded.
    const tail: Promise<void> = result.then((outcome) =>
      outcome.kind === 'COMMITTED' ? this.sleep(req.settleMs ?? SETTLE_MS) : undefined);
    this.chains.set(ptyId, tail);
    void tail.then(() => { if (this.chains.get(ptyId) === tail) this.chains.delete(ptyId); });
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { this.deps.setTimer(r, ms); });
  }

  private refuse(decision: AdmissionDecision | null, reason: RefusalReason, detail?: string): SubmitOutcome {
    if (decision) this.deps.capacity.cancelGrant(decision);
    return detail === undefined ? { kind: 'REFUSED', reason } : { kind: 'REFUSED', reason, detail };
  }

  private async run(req: SubmitRequest, ptyId: string): Promise<SubmitOutcome> {
    const deps = this.deps;
    const cls = req.admissionClass;
    const policy = deps.unknownPolicy ?? UNKNOWN_POLICY;

    // ── ADMIT ────────────────────────────────────────────────────────────────────────
    if (this.inhibition(ptyId)) return this.refuse(null, 'PTY_INHIBITED');
    const incarnation = deps.incarnation(ptyId);
    if (incarnation === undefined) return this.refuse(null, 'PTY_GONE');
    let decision: AdmissionDecision | null = null;
    if (ASKS_CAPACITY[cls]) {
      decision = deps.capacity.admit(req.agentId, 'ORDINARY_TURN');
      const admitted = resolveAdmission(decision, policy);
      if (admitted.action !== 'PROCEED') return this.refuse(decision, 'CAPACITY_HOLD', admitted.basis);
    }
    const humanAdmit = deps.humanGeneration(ptyId);

    // ── READY: fail closed BEFORE anything is staged ─────────────────────────────────
    // Nothing is ever typed that cannot be un-typed (section 8). Capability UNKNOWN is
    // not capacity UNKNOWN and takes no proceed mapping from it.
    if (gateRefuses(cls, 'ABORT_CAPABILITY_UNVERIFIED') && deps.abortCapability(req.agentId).kind !== 'VERIFIED') {
      return this.refuse(decision, 'PROVIDER_ABORT_UNVERIFIED');
    }
    if (gateRefuses(cls, 'PROVENANCE_INELIGIBLE')) {
      const e = deps.eligibility(ptyId);
      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);
    }
    const started = deps.now();
    for (;;) {
      const waited = deps.now() - started;
      const ready = deps.terminalReady(ptyId, req.agentId, waited);
      if (ready === 'READY') break;
      if (ready === 'GONE') return this.refuse(decision, 'PTY_GONE');
      if (waited >= READY_TIMEOUT_MS) return this.refuse(decision, 'TERMINAL_NOT_READY');
      await this.sleep(READY_POLL_MS);
    }
    // GOD-STARTUP-WAITS-ENTER G1: "has output and 400 ms passed" is not proof that Claude reads
    // its prompt yet. On 2026-10-02 the orientation and its Enter were written 0.57 s after the
    // first output, 1.5 s BEFORE Claude's SessionStart; both sat in the input buffer, arrived as
    // one paste, and the Enter became a newline. A boot prompt waits for the provider's own proof.
    if (cls === 'BOOT_SEQUENCE') {
      let up: boolean | undefined;
      try { up = deps.bootReady?.(ptyId, req.agentId); } catch { up = false; }
      if (up === false) return this.refuse(decision, 'TERMINAL_NOT_READY', 'boot:session-not-started');
    }

    // ── PRIOR TEXT (CODEX-FALSEACTIVE-153): an earlier nudge that never became a turn may
    // still be on the prompt. Typed after it, both would go out as one prompt. Read before
    // the STAGE guards below, which must not be separated from the write by this yield.
    if (req.priorText !== undefined) {
      const needles = priorTextNeedles(req.priorText);
      if (needles.length === 0) return this.refuse(decision, 'PRIOR_TEXT_UNVERIFIED', 'no usable needle');
      for (const needle of needles) {
        const seen = await this.readScreen(ptyId, needle, req.priorText);
        if (!seen) {
          const now = deps.now();
          const u = this.priorUnreadable.get(ptyId) ?? { count: 0, since: now };
          u.count += 1;
          this.priorUnreadable.set(ptyId, u);
          if (u.count >= PRIOR_TEXT_UNREADABLE_MAX || now - u.since >= PRIOR_TEXT_UNREADABLE_HOLD_MS) {
            this.priorUnreadable.delete(ptyId);
            return this.interfere({ req, ptyId, incarnation, decision, humanStage: deps.humanGeneration(ptyId) ?? 0 }, 'PRIOR_TEXT_UNREADABLE', `${u.count} unreadable checks over ${Math.round((now - u.since) / 1000)} s`);
          }
          return this.refuse(decision, 'PRIOR_TEXT_UNVERIFIED', 'no screen reading');
        }
        this.priorUnreadable.delete(ptyId);
        // CODEX-WAKE-161 F2: the cursor's row is not the whole composer. An Enter that became a
        // NEWLINE leaves our text on the row ABOVE an empty cursor row - exactly the shape a
        // real submit leaves in the transcript - so the cursor-row needle alone read "absent"
        // and a second copy was typed under the first. The renderer's composer read (from the
        // prompt marker down to the cursor) tells them apart: after a real submit the cursor
        // row IS the new, empty prompt, so our text is not in that composer.
        if (seen.onPromptRow || seen.promptTailMatches === true) {
          const own = this.ownDrafts.get(ptyId);
          // WAKE-SELF-TEXT-HOLD: our previous Enter may have reached the PTY while the
          // provider left the line unsent. This is safe to re-enter only with all three
          // proofs: the renderer's whole composer tail matches our exact text, the owner
          // remembers staging that text in this incarnation, and no human key arrived.
          if (seen.promptTailMatches === true && own?.text === req.priorText
            && own.incarnation === incarnation && own.humanStage === deps.humanGeneration(ptyId)) {
            // WAKE-SCREEN-GUARD: a Codex re-Enter needs its own fresh reading of our draft.
            let reenterGen: number | undefined;
            if (this.guardMode(ptyId) === 'ENFORCE') {
              const g = await this.screenGate(req, ptyId, incarnation, 'REENTER', req.priorText);
              if (!g.ok) return this.refuse(decision, 'SCREEN_NOT_READY', g.reason);
              reenterGen = g.gen;
            }
            const retried = this.reenterOwnDraft(req, ptyId, incarnation, decision, own.humanStage, reenterGen);
            if (retried.kind === 'COMMITTED') this.ownDrafts.delete(ptyId);
            // F3 for this Enter too: the draft being re-entered is the prior text.
            if (retried.kind === 'COMMITTED' && deps.verifySubmit?.(ptyId)) {
              return this.verifySubmitted({ req: { ...req, text: req.priorText }, ptyId, incarnation, decision: null, humanStage: own.humanStage });
            }
            return retried;
          }
          return this.interfere({ req, ptyId, incarnation, decision, humanStage: deps.humanGeneration(ptyId) ?? 0 }, 'PRIOR_TEXT_ON_PROMPT', undefined);
        }
      }
    }

    // ── WAKE-SCREEN-GUARD: a FRESH Codex screen reading for THIS request ────────────────
    // Condition 1 (past startup, latched per incarnation) and condition 2 (the empty
    // composer). Its output generation is re-checked below, in the STAGE section.
    const guard = this.guardMode(ptyId);
    let screenGen: number | undefined;
    if (guard === 'ENFORCE') {
      // A human-owned prompt is refused for what it is, before any screen IPC (it is checked
      // again in the STAGE section below, next to the write).
      const early = promptCondition(deps.promptBlock(ptyId));
      if (early && gateRefuses(cls, early)) return this.refuse(decision, early);
      // DWIGHT-HELD-INTERFERED fix 3: the reading is taken only once the PTY has been quiet (a
      // Codex Stop precedes the turn's last frames). Not quiet in time = nothing typed, asked again.
      // AUTOMATIC starts only (Jim S1): a person's "send now" to a working Codex is never quiet and
      // must not be delayed or refused for it; a boot prompt has its own latched-composer gate.
      const quietMs = cls === 'CAPACITY_GATED' ? deps.stageQuietMs?.(ptyId) ?? 0 : 0;
      if (quietMs > 0 && !(await this.outputQuiet(ptyId, quietMs))) return this.refuse(decision, 'SCREEN_NOT_READY', 'output-not-quiet');
      const g = await this.screenGate(req, ptyId, incarnation, 'STAGE');
      if (!g.ok) return this.refuse(decision, 'SCREEN_NOT_READY', g.reason);
      screenGen = g.gen;
    }

    // ── STAGE: every guard re-read IMMEDIATELY before the write, no yield between ────
    // The wait above yielded, so nothing read before it is evidence about now.
    if (deps.incarnation(ptyId) !== incarnation) return this.refuse(decision, 'PTY_REPLACED');
    if (this.inhibition(ptyId)) return this.refuse(decision, 'PTY_INHIBITED');
    const prompt = promptCondition(deps.promptBlock(ptyId));
    if (prompt && gateRefuses(cls, prompt)) return this.refuse(decision, prompt);
    const lastHuman = deps.lastHumanInputAt(ptyId);
    if (lastHuman !== undefined && deps.now() - lastHuman < HUMAN_QUIET_MS && gateRefuses(cls, 'HUMAN_INPUT_RECENT')) {
      return this.refuse(decision, 'HUMAN_INPUT_RECENT');
    }
    if (gateRefuses(cls, 'PROVENANCE_INELIGIBLE')) {
      const e = deps.eligibility(ptyId);
      if (!e.eligible) return this.refuse(decision, 'PROVENANCE_INELIGIBLE', e.reason);
    }
    if (decision) {
      const claim: OwnerClaim = { decision, agentId: req.agentId, workClass: decision.workClass, target: ptyId };
      const again = resolveAdmission(deps.capacity.revalidate(claim), policy);
      if (again.action !== 'PROCEED') return this.refuse(decision, 'CAPACITY_HOLD', again.basis);
    }
    // PRE-STAGE BASELINE. A human write since ADMIT is NOT interference — nothing of ours
    // is on the line yet. Side-effect-free refusal and re-admission: no residue, nothing
    // held, nothing inhibited (section 4).
    if (deps.humanGeneration(ptyId) !== humanAdmit) return this.refuse(decision, 'HUMAN_INPUT_BEFORE_STAGE');
    // WAKE-SCREEN-GUARD: no Codex output since the reading that admitted this request.
    if (guard === 'ENFORCE' && deps.outputGeneration?.(ptyId) !== screenGen) {
      return this.refuse(decision, 'SCREEN_CHANGED', 'output after the screen reading');
    }
    const wrote = safeWrite(deps, ptyId, payloadFor(req.text));
    if (!wrote.ok) return this.refuse(decision, 'STAGE_WRITE_FAILED', wrote.error);
    // POST-STAGE BASELINE, captured only after the payload write SUCCEEDED and in the same
    // turn: from here on a human write lands on a line that already holds our text.
    const humanStage = deps.humanGeneration(ptyId);
    if (humanStage === undefined) {
      if (decision) deps.capacity.cancelGrant(decision);
      return { kind: 'FAILED', reason: 'PTY_GONE_AFTER_STAGE' };
    }
    const staged: Staged = { req, ptyId, incarnation, decision, humanStage };

    // ── GAP ──────────────────────────────────────────────────────────────────────────
    // CODEX-WAKE-161 F1: a provider may need a longer gap (Codex: an Enter inside its paste-burst
    // window after a fast burst is taken as a newline).
    // CODEX-WAKE-162: the gap may scale with the payload's length.
    // START-FIXES-163 (3): the same gap, recorded for the Enter-write diagnostics row.
    // KEEP EQUAL to the sleep below: that line is pinned verbatim (codex-wake-162 and the
    // mutant census), so the expression is repeated; enterGapMs is pure, so they agree.
    const gapMs = deps.enterGapMs?.(ptyId, req.text.length) ?? GAP_MS;
    await this.sleep(deps.enterGapMs?.(ptyId, req.text.length) ?? GAP_MS);

    // ── COMMIT | ABORT | INTERFERED ──────────────────────────────────────────────────
    // WAKE-SCREEN-GUARD: for Codex, a SECOND fresh reading, after the echo of our stage
    // write, must show the composer holding exactly our text; the Enter then needs no
    // output since that reading. Never proven = no Enter.
    // WSG LIVENESS: a SLOW screen is re-read until SCREEN_COMMIT_SLOW_BUDGET_MS after the stage
    // write; then, or at once for a FOREIGN one, the staged text is erased through the VERIFIED
    // abort (ABORTED: released and re-offered). Only an erase that cannot be proven is held.
    const slowDeadline = deps.now() + SCREEN_COMMIT_SLOW_BUDGET_MS;
    let verdict: CommitVerdict;
    /** G2: when the Enter went out (a provider report from before it is not about this prompt). */
    let enterAt = deps.now();
    for (;;) {
      if (guard === 'ENFORCE') {
        const g = await this.screenGate(req, ptyId, incarnation, 'COMMIT', req.text);
        if (!g.ok) {
          // A human key or a dead terminal explains a changed screen better than the screen does.
          const blocked = postStageGuard(staged, deps);
          if (blocked) { verdict = blocked; break; }
          if (foreignScreenReason(g.reason)) return this.abort(staged, `screen-foreign:${g.reason}`);
          if (deps.now() >= slowDeadline) return this.abort(staged, `screen-not-verified:${g.reason}`, SCREEN_ABORT_VERIFY_BUDGET_MS);
          await this.sleep(SCREEN_COMMIT_RETRY_MS);
          continue;
        }
        staged.screenGen = g.gen;
      }
      enterAt = deps.now();
      verdict = await Promise.resolve(commitSection(staged, deps));
      if (verdict.kind !== 'SCREEN_CHANGED') break;
      if (deps.now() >= slowDeadline) return this.abort(staged, 'screen-not-verified:output after every reading', SCREEN_ABORT_VERIFY_BUDGET_MS);
      await this.sleep(SCREEN_COMMIT_RETRY_MS);
    }
    if (verdict.kind === 'ENTERED') this.reportEnterWrite(staged, verdict.ok, verdict.ok ? undefined : verdict.error, gapMs, false);
    switch (verdict.kind) {
      case 'ENTERED':
        if (verdict.ok) {
          this.ownDrafts.set(ptyId, { text: req.text, humanStage: staged.humanStage, incarnation: staged.incarnation });
          // GOD-STARTUP-WAITS-ENTER G2: a boot prompt is COMMITTED only on the provider's report.
          if (cls === 'BOOT_SEQUENCE' && this.bootVerifiable(ptyId, req.agentId)) return this.verifyBootSubmitted(staged, enterAt);
          if (deps.verifySubmit?.(ptyId)) return this.verifySubmitted(staged);
          return { kind: 'COMMITTED' };
        }
        // The Enter did not go out and our text is still on a live prompt: residue we
        // cannot account for. Held, not retried (the grant was HELD in-section).
        return this.interfere(staged, 'ENTER_WRITE_FAILED', verdict.error);
      case 'FAILED':
        if (decision) deps.capacity.cancelGrant(decision);
        return { kind: 'FAILED', reason: verdict.reason };
      case 'INTERFERED':
        return this.interfere(staged, verdict.reason, verdict.detail);
      case 'LATE_REFUSAL':
        return this.abort(staged, verdict.basis);
      case 'SCREEN_CHANGED':
        // Not reached (postStageGuard never answers it); held, like the loop's own exit.
        return this.interfere(staged, 'SCREEN_NOT_VERIFIED_AFTER_STAGE', 'output after the reading');
    }
  }

  private guardMode(ptyId: string): ScreenGuardMode {
    try { return this.deps.screenGuard?.(ptyId) === 'ENFORCE' ? 'ENFORCE' : 'OFF'; } catch { return 'ENFORCE'; }
  }

  /**
   * WAKE-SCREEN-GUARD: one FRESH Codex screen reading, judged. STAGE needs the empty
   * composer; COMMIT and REENTER need the composer holding exactly `expectedTail` (our own
   * text). Both need condition 1 for this incarnation, from this reading or an earlier one,
   * and a reading stamped with this incarnation. Returns the generation the reading covers.
   */
  private async screenGate(req: SubmitRequest, ptyId: string, incarnation: unknown, phase: ScreenGuardPhase, expectedTail?: string): Promise<{ ok: true; gen: number } | { ok: false; reason: string }> {
    const deps = this.deps;
    const r = await this.readGuard(ptyId, expectedTail);
    let verdict: { ok: true; gen: number } | { ok: false; reason: string };
    if (!r) verdict = { ok: false, reason: 'no-reading' };
    else if (r.incarnation !== incarnation || deps.incarnation(ptyId) !== incarnation) verdict = { ok: false, reason: 'incarnation' };
    else {
      const past = codexPastStartup(r.facts, deps.spawnCwd?.(ptyId), deps.homeDir?.());
      // Jim N1: only a reading that covers real PTY output can latch (a blank terminal has none).
      if (past.open && r.outputGeneration > 0) this.postHandoff.set(ptyId, incarnation);
      // DWIGHT-INPUT-DEAD-179 F4: Codex's own "chat configured" record, for a screen with no marker.
      else if (this.postHandoff.get(ptyId) !== incarnation && this.threadProof(ptyId, r)) this.postHandoff.set(ptyId, incarnation);
      const comp = classifyCodexComposer(r.facts, expectedTail === undefined ? undefined : r.promptTailMatches);
      const want = phase === 'STAGE' ? 'READY' : 'READY_OWN_DRAFT';
      // CODEX-MODEL-SWITCH-PROMPT P2: a Codex popup (rate limits, trust, update...) is named first,
      // so the Human reads what Codex is asking. A refusal either way; MODAL is never admitted.
      if (comp.cls === 'MODAL') verdict = { ok: false, reason: `${comp.cls}:${comp.reason}` };
      // A LOADING header or a resume line is refused even when latched (the live widget
      // also shows `loading` while it reconfigures).
      else if (!past.open && (past.reason === 'header-loading' || past.reason === 'session-starting')) verdict = { ok: false, reason: `startup:${past.reason}` };
      // WSG-178 W1 (Jim): NO admission class passes condition 1 without the latch. A person's "send
      // now" too: the pre-trust startup draft's cursor row IS the empty composer, and in a terminal
      // of about 8 rows its header loses the model row (startup_draft_layout.rs:50-59), so
      // `no-marker` + READY is NOT proof of the post-handoff composer.
      else if (this.postHandoff.get(ptyId) !== incarnation) verdict = { ok: false, reason: `startup:${past.reason}` };
      else if (comp.cls !== want) verdict = { ok: false, reason: `${comp.cls}:${comp.reason}` };
      else verdict = { ok: true, gen: r.outputGeneration };
    }
    try {
      const current = deps.outputGeneration?.(ptyId);
      deps.onScreenGuard?.({
        requestId: req.requestId, agentId: req.agentId, ptyId, admissionClass: req.admissionClass, phase,
        ok: verdict.ok, reason: verdict.ok ? 'ok' : verdict.reason, incarnation,
        observedGeneration: r ? r.outputGeneration : null, currentGeneration: current ?? null,
        latched: this.postHandoff.get(ptyId) === incarnation,
        ...(phase === 'COMMIT' && !verdict.ok && r ? { screen: screenFacts(r.facts) } : {}),
        ...(!verdict.ok && r && verdict.reason.startsWith('startup:') ? { startupScreen: startupScreenFacts(r.facts) } : {})
      });
    } catch { /* diagnostics never decide */ }
    return verdict;
  }

  /** A guard reading, or null: absent dependency, no answer in time, or malformed. */
  private readGuard(ptyId: string, expectedTail?: string): Promise<GuardReading | null> {
    const read = this.deps.readGuardScreen;
    if (!read) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: GuardReading | null) => { if (!done) { done = true; resolve(v); } };
      const limit = SCREEN_ORACLE_TIMEOUT_MS;
      this.deps.setTimer(() => finish(null), limit);
      let p: Promise<GuardReading | null>;
      try { p = read(ptyId, expectedTail); } catch { finish(null); return; }
      p.then(
        (v) => {
          const ok = v && v.facts && typeof v.outputGeneration === 'number'
            && (v.promptTailMatches === undefined || typeof v.promptTailMatches === 'boolean') ? v : null;
          if (ok && !done) { try { this.lastScreen.set(ptyId, { facts: screenFacts(ok.facts), at: this.deps.now() }); } catch { /* diagnostics */ } }
          finish(ok);
        },
        () => finish(null)
      );
    });
  }

  /** START-FIXES-163 (3): one diagnostics record per automatic Enter write. Never throws
   *  into the submit path. */
  private reportEnterWrite(s: Staged, ok: boolean, error: string | undefined, gapMs: number, reentry: boolean): void {
    try {
      this.deps.onEnterWrite?.({
        requestId: s.req.requestId, agentId: s.req.agentId, ptyId: s.ptyId,
        admissionClass: s.req.admissionClass, ok, ...(error === undefined ? {} : { error }), gapMs, reentry
      });
    } catch { /* diagnostics must never change an outcome */ }
  }

  /** INTERFERED: write NOTHING. Hold, flag, inhibit - and keep the grant IN SUSPENSE.
   *  Our payload is on a live prompt where a person may press Enter on it, so the turn is
   *  possibly launched: it is neither returned nor confirmed here. A human's resolution
   *  (or the terminal's death) settles it. EVERY INTERFERED comes through here, so there
   *  is no INTERFERED that returns a grant. */
  private interfere(s: Staged, reason: InterferenceReason, detail: string | undefined): SubmitOutcome {
    if (s.decision) this.deps.capacity.holdGrant(s.decision);
    const now = this.deps.now();
    this.inhibited.set(s.ptyId, {
      requestId: s.req.requestId, reason, at: now, incarnation: s.incarnation,
      agentId: s.req.agentId, admissionClass: s.req.admissionClass,
      binding: this.known.get(s.req.requestId)?.binding ?? { agentId: s.req.agentId, admissionClass: s.req.admissionClass, payload: '' },
      decision: s.decision, text: s.req.text, humanStage: s.humanStage
    });
    try {
      const sc = this.lastScreen.get(s.ptyId);
      const nd = this.lastNeedle.get(s.ptyId);
      this.deps.onInterfered?.({
        requestId: s.req.requestId, agentId: s.req.agentId, ptyId: s.ptyId, admissionClass: s.req.admissionClass,
        reason, ...(detail === undefined ? {} : { detail }),
        screen: sc ? sc.facts : null, screenAgeMs: sc ? now - sc.at : null,
        needle: nd ? { onPromptRow: nd.onPromptRow, screenCount: nd.screenCount, ageMs: now - nd.at } : null
      });
    } catch { /* diagnostics never decide */ }
    return detail === undefined ? { kind: 'INTERFERED', reason } : { kind: 'INTERFERED', reason, detail };
  }

  /** DWIGHT-HELD-INTERFERED fix 3: true once no PTY output has arrived for `quietMs` (counted
   *  from now at the earliest), false if that has not happened within STAGE_QUIET_BUDGET_MS. */
  private async outputQuiet(ptyId: string, quietMs: number): Promise<boolean> {
    const deps = this.deps;
    const start = deps.now();
    let last = deps.outputGeneration?.(ptyId);
    let quietSince = start;
    for (;;) {
      if (deps.now() - quietSince >= quietMs) return true;
      if (deps.now() - start >= STAGE_QUIET_BUDGET_MS) return false;
      await this.sleep(STAGE_QUIET_POLL_MS);
      const gen = deps.outputGeneration?.(ptyId);
      if (gen !== last) { last = gen; quietSince = deps.now(); }
    }
  }

  /**
   * DWIGHT-HELD-INTERFERED-2028 fix 1: take a FRESH look at a held INTERFERED automatic wake (main
   * calls this about once a minute while the wake coordinator holds that claim). It runs in the
   * PTY's own submit chain, so it never overlaps a submission. Sound by the same rules as every
   * automatic write (ZT-175, WSG): nothing is typed unless our own text is POSITIVELY on the
   * prompt row, and then only the verified erase; a release needs positive evidence that nothing
   * of ours or a person's is on the prompt:
   *   - an automatic (CAPACITY_GATED) hold on a screen-guarded (Codex) PTY, same incarnation;
   *   - NO human key since our STAGE (a person who touched it rules it; nor can anyone have pressed
   *     Enter on our text, so "not delivered" is a fact, not a guess);
   *   - a guard reading AND a needle reading of the same output generation (none since);
   *   - our text on the prompt row: the verified erase (abort) runs; ABORTED = ERASED;
   *   - else our text on screen 0 times, condition 1 latched, the plain empty composer: RELEASED.
   * Anything else stays HELD. Either release hands the grant back and frees the id, exactly as a
   * person's SEND_AGAIN; the caller then resolves the coordinator's hold the same way.
   */
  recheckHeld(ptyId: string, requestId: string): Promise<HeldRecheck> {
    const queued = this.chains.get(ptyId) ?? Promise.resolve();
    const result = queued.then(() => this.recheckHeldNow(ptyId, requestId))
      .catch((e): HeldRecheck => ({ kind: 'HELD', why: `owner error: ${String(e)}`, screen: null }));
    const tail: Promise<void> = result.then(() => undefined);
    this.chains.set(ptyId, tail);
    void tail.then(() => { if (this.chains.get(ptyId) === tail) this.chains.delete(ptyId); });
    return result;
  }

  private async recheckHeldNow(ptyId: string, requestId: string): Promise<HeldRecheck> {
    const deps = this.deps;
    const held = this.inhibition(ptyId) ? this.inhibited.get(ptyId) : undefined;   // retires a dead terminal's hold
    if (!held || held.requestId !== requestId) return { kind: 'NONE' };
    const stay = (why: string, screen: GuardScreenFacts | null = null): HeldRecheck => ({ kind: 'HELD', why, screen });
    if (held.admissionClass !== 'CAPACITY_GATED') return stay('not-automatic');
    if (this.guardMode(ptyId) !== 'ENFORCE') return stay('no-screen-guard');
    if (deps.humanGeneration(ptyId) !== held.humanStage) return stay('human-input-since-hold');
    const needle = needleFor(held.text);
    if (!needle) return stay('no-needle');
    const g = await this.readGuard(ptyId);
    const seen = await this.readScreen(ptyId, needle);
    // The readings yielded: everything they are judged against is read again now.
    if (!this.inhibition(ptyId) || this.inhibited.get(ptyId) !== held) return { kind: 'NONE' };
    if (deps.humanGeneration(ptyId) !== held.humanStage) return stay('human-input-since-hold');
    if (!g || !seen || g.incarnation !== held.incarnation) return stay('no-reading');
    const screen = screenFacts(g.facts);
    if (deps.outputGeneration?.(ptyId) !== g.outputGeneration) return stay('screen-changed', screen);
    // CODEX-MODEL-SWITCH-PROMPT P3: a Codex popup is NEVER answered by the app: no key at all, not
    // the erase, not Esc. It stays held, and the notice tells the Human what Codex is asking.
    const modal = classifyCodexComposer(g.facts);
    if (modal.cls === 'MODAL') return stay(`${modal.cls}:${modal.reason}`, screen);
    if (seen.onPromptRow && seen.screenCount >= 1) {
      // Our own text is on the prompt: the verified erase can run now (it needed to see it first).
      this.inhibited.delete(ptyId);
      const s: Staged = {
        req: { requestId, agentId: held.agentId, admissionClass: held.admissionClass, text: held.text },
        ptyId, incarnation: held.incarnation, decision: held.decision, humanStage: held.humanStage
      };
      const out = await this.abort(s, 'held-recheck:own-text-on-prompt', SCREEN_ABORT_VERIFY_BUDGET_MS);
      if (out.kind === 'ABORTED') { this.releaseHeldId(held); return { kind: 'ERASED', screen }; }
      if (out.kind === 'INTERFERED') {
        const again = this.inhibited.get(ptyId);
        if (again) again.at = held.at;                 // still the same hold, for its notice
        return stay(`erase:${out.reason}`, screen);
      }
      this.releaseHeldId(held);                        // FAILED: the terminal went away
      return { kind: 'NONE' };
    }
    if (seen.screenCount > 0) return stay('own-text-on-screen', screen);
    const past = codexPastStartup(g.facts, deps.spawnCwd?.(ptyId), deps.homeDir?.());
    if (this.postHandoff.get(ptyId) !== held.incarnation || (!past.open && (past.reason === 'header-loading' || past.reason === 'session-starting'))) {
      return stay(`startup:${past.reason}`, screen);
    }
    const comp = classifyCodexComposer(g.facts);
    if (comp.cls !== 'READY') return stay(`${comp.cls}:${comp.reason}`, screen);
    this.inhibited.delete(ptyId);
    if (held.decision) deps.capacity.cancelGrant(held.decision);
    this.releaseHeldId(held);
    return { kind: 'RELEASED', screen };
  }

  /** The held id is free again (not delivered): a re-admission of it is a new attempt. */
  private releaseHeldId(held: HeldInterference): void {
    if (this.known.get(held.requestId)?.binding === held.binding) this.known.delete(held.requestId);
  }

  /** Re-press Enter on a composer that is positively our untouched prior write. This is
   * deliberately not STAGE: typing a second nudge would fuse it with the first. */
  private reenterOwnDraft(req: SubmitRequest, ptyId: string, incarnation: unknown, decision: AdmissionDecision | null, humanStage: number, screenGen?: number): SubmitOutcome {
    const deps = this.deps;
    // The original COMMITTED already owns this message's capacity grant. The retry has
    // no new work to admit; release its speculative grant before handing the one extra
    // Enter to the SAME non-yielding critical section as every other automatic Enter.
    if (decision) deps.capacity.cancelGrant(decision);
    const staged: Staged = { req, ptyId, incarnation, decision: null, humanStage, ...(screenGen === undefined ? {} : { screenGen }) };
    const verdict = commitSection(staged, deps);
    if (verdict.kind === 'ENTERED') this.reportEnterWrite(staged, verdict.ok, verdict.ok ? undefined : verdict.error, 0, true);
    switch (verdict.kind) {
      case 'ENTERED':
        return verdict.ok ? { kind: 'COMMITTED' }
          : this.interfere(staged, 'ENTER_WRITE_FAILED', verdict.error);
      case 'FAILED':
        return { kind: 'FAILED', reason: verdict.reason };
      case 'INTERFERED':
        return this.interfere(staged, verdict.reason, verdict.detail);
      case 'LATE_REFUSAL':
        // No decision reaches this path, so a late admission result is impossible.
        return this.interfere(staged, 'PROVENANCE_LOST_AFTER_STAGE', verdict.basis);
      case 'SCREEN_CHANGED':
        // Nothing was written: our untouched draft is still there, and the next beat asks again.
        return { kind: 'REFUSED', reason: 'SCREEN_CHANGED', detail: 'output after the re-Enter reading' };
    }
  }

  /**
   * CODEX-WAKE-161 F3: a POSITIVE commit. The Enter went out (the grant is already confirmed
   * as a launch); now the composer must show our text gone. Polled, because the TUI's redraw
   * reaches the renderer a frame or two later.
   *
   *   gone                    COMMITTED.
   *   no reading / no needle  COMMITTED: nothing here can prove otherwise, and the wake
   *                           coordinator's provider confirmation still judges the turn.
   *   still there             ONE more Enter of our own (the same critical section and the
   *                           same proofs as every automatic Enter: same incarnation, no
   *                           human key since STAGE), then the same wait. Still there after
   *                           that is INTERFERED SUBMIT_NOT_ACCEPTED: visible, held for a
   *                           person, never typed over.
   */
  /** GOD-STARTUP-WAITS-ENTER G2: does this PTY's provider report submitted prompts? */
  private bootVerifiable(ptyId: string, agentId: string): boolean {
    try { return this.deps.bootSubmitted?.(ptyId, agentId, this.deps.now()) !== undefined; } catch { return false; }
  }

  /** G2: wait (bounded) for the provider's report of a prompt submitted at or after `since`. */
  private async bootConfirmed(s: Staged, since: number): Promise<boolean> {
    const until = this.deps.now() + BOOT_SUBMIT_CONFIRM_MS;
    for (;;) {
      let ok: boolean | undefined;
      try { ok = this.deps.bootSubmitted?.(s.ptyId, s.req.agentId, since); } catch { ok = undefined; }
      if (ok === true) return true;
      if (this.deps.now() >= until) return false;
      await this.sleep(SUBMIT_VERIFY_POLL_MS);
    }
  }

  /**
   * GOD-STARTUP-WAITS-ENTER G2: a boot prompt's Enter is COMMITTED only when the provider reports
   * the prompt submitted (Claude: UserPromptSubmit of the live incarnation). Not reported in time:
   *  - a person typed since our stage write: held (INTERFERED), and NO Enter of ours: the prompt
   *    may be theirs now;
   *  - else, only if our exact text is still the composer's tail (the own-draft proof, as for a
   *    Codex re-Enter), ONE more Enter, and the report is waited for again;
   *  - still nothing, or no proof it is our draft: held, BOOT_NOT_SUBMITTED, for a person. Never
   *    a third Enter.
   */
  private async verifyBootSubmitted(s: Staged, enterAt: number): Promise<SubmitOutcome> {
    if (await this.bootConfirmed(s, enterAt)) return { kind: 'COMMITTED' };
    if (this.deps.incarnation(s.ptyId) !== s.incarnation) return this.interfere(s, 'BOOT_NOT_SUBMITTED', 'the terminal was replaced');
    if (this.deps.humanGeneration(s.ptyId) !== s.humanStage) return this.interfere(s, 'BOOT_NOT_SUBMITTED', 'a person typed after our Enter');
    const needle = needleFor(s.req.text);
    const seen = needle ? await this.readScreen(s.ptyId, needle, s.req.text) : null;
    if (!seen || seen.promptTailMatches !== true) return this.interfere(s, 'BOOT_NOT_SUBMITTED', 'not reported submitted, and the prompt is not provably our draft');
    // The read yielded: a person's key in between still wins (commitSection re-checks it too).
    const again: Staged = { ...s, decision: null };
    const at = this.deps.now();
    const verdict = commitSection(again, this.deps);
    if (verdict.kind === 'ENTERED') this.reportEnterWrite(again, verdict.ok, verdict.ok ? undefined : verdict.error, 0, true);
    if (verdict.kind === 'FAILED') return { kind: 'FAILED', reason: verdict.reason };
    if (verdict.kind === 'INTERFERED') return this.interfere(again, verdict.reason, verdict.detail);
    if (verdict.kind === 'SCREEN_CHANGED') return this.interfere(again, 'BOOT_NOT_SUBMITTED', 'output after the reading');
    if (verdict.kind !== 'ENTERED' || !verdict.ok) return this.interfere(again, 'ENTER_WRITE_FAILED', verdict.kind === 'ENTERED' ? verdict.error : verdict.basis);
    if (await this.bootConfirmed(again, at)) return { kind: 'COMMITTED' };
    return this.interfere(again, 'BOOT_NOT_SUBMITTED', 'not reported submitted after two Enters');
  }

  private async verifySubmitted(s: Staged): Promise<SubmitOutcome> {
    const needle = needleFor(s.req.text);
    if (!needle) return { kind: 'COMMITTED' };
    // WSG LIVENESS (rc/1.1.76 final gate): for Codex, an Enter is PROVEN LOST only when the TUI
    // produced output after it (it processed something) and our text then stayed put for a
    // whole window. With NO output since the Enter it is merely slow: still queued in the TUI's
    // input, where nothing we write can recall it (a second Enter or a Ctrl-U lands BEHIND it),
    // so it is waited for, up to SUBMIT_SLOW_BUDGET_MS; still no output then = null (COMMITTED,
    // unconfirmed: the wake coordinator's provider confirmation judges the turn, exactly as for
    // a missing reading). Other providers keep the plain window.
    const slowAware = this.guardMode(s.ptyId) === 'ENFORCE';
    const cleared = async (st: Staged): Promise<boolean | null> => {
      const started = this.deps.now();
      // The generation AT the Enter: commitSection wrote it only while output still equalled the
      // reading's (screenGen), so that is exact; anything after it is the TUI processing input.
      const enterGen = st.screenGen ?? this.deps.outputGeneration?.(s.ptyId);
      let lastGen = enterGen;
      let quietSince = started;
      let gone = 0;
      for (;;) {
        await this.sleep(SUBMIT_VERIFY_POLL_MS);
        const seen = await this.readScreen(s.ptyId, needle, s.req.text);
        if (!seen) return null;
        const gen = this.deps.outputGeneration?.(s.ptyId);
        if (gen !== lastGen) { lastGen = gen; quietSince = this.deps.now(); }
        if (!seen.onPromptRow && seen.promptTailMatches !== true) {
          if (++gone >= SUBMIT_GONE_READS) return true;
        } else gone = 0;
        const now = this.deps.now();
        // At the window's end a last reading of 'gone' stands (it was not contradicted).
        if (!slowAware) { if (now - started >= SUBMIT_VERIFY_WINDOW_MS) return gone > 0; continue; }
        if (now - started < SUBMIT_VERIFY_WINDOW_MS) continue;
        if (gone > 0) return true;
        const processed = enterGen === undefined || lastGen !== enterGen;
        if (processed && now - quietSince >= SUBMIT_VERIFY_WINDOW_MS) return false;   // PROVEN lost
        if (now - started >= SUBMIT_SLOW_BUDGET_MS) return processed ? false : null;
      }
    };
    const first = await cleared(s);
    if (first !== false) return { kind: 'COMMITTED' };
    // The grant went out with the first Enter; this one carries none.
    const again: Staged = { ...s, decision: null };
    // WAKE-SCREEN-GUARD: a Codex second Enter needs a fresh reading of our text, too.
    if (this.guardMode(s.ptyId) === 'ENFORCE') {
      const g = await this.screenGate(s.req, s.ptyId, s.incarnation, 'COMMIT', s.req.text);
      if (!g.ok) return this.interfere(again, 'SCREEN_NOT_VERIFIED_AFTER_STAGE', g.reason);
      again.screenGen = g.gen;
    }
    const verdict = commitSection(again, this.deps);
    if (verdict.kind === 'SCREEN_CHANGED') return this.interfere(again, 'SCREEN_NOT_VERIFIED_AFTER_STAGE', 'output after the reading');
    if (verdict.kind === 'FAILED') return { kind: 'FAILED', reason: verdict.reason };
    if (verdict.kind === 'INTERFERED') return this.interfere(again, verdict.reason, verdict.detail);
    if (verdict.kind !== 'ENTERED' || !verdict.ok) return this.interfere(again, 'ENTER_WRITE_FAILED', verdict.kind === 'ENTERED' ? verdict.error : verdict.basis);
    const second = await cleared(again);
    if (second !== false) return { kind: 'COMMITTED' };
    // WSG LIVENESS: two Enters PROVEN lost on Codex (the TUI processed both and our text
    // stayed): erase it through the VERIFIED abort and release it for a re-offer. The abort's
    // differential check is what keeps this single-delivery: text that moved into the
    // transcript (a late submit) is not "fewer on screen", so it is held, never re-offered.
    if (slowAware) return this.abort(again, 'submit-not-accepted', SCREEN_ABORT_VERIFY_BUDGET_MS);
    return this.interfere(again, 'SUBMIT_NOT_ACCEPTED', 'our text stayed in the composer after two Enters');
  }

  private readScreen(ptyId: string, needle: string, expectedTail?: string): Promise<ScreenReading | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: ScreenReading | null) => { if (!done) { done = true; resolve(v); } };
      this.deps.setTimer(() => finish(null), SCREEN_ORACLE_TIMEOUT_MS);
      this.deps.readScreen(ptyId, needle, expectedTail).then(
        (v) => {
          const ok = v && typeof v.onPromptRow === 'boolean' && typeof v.screenCount === 'number'
            && (v.promptTailMatches === undefined || typeof v.promptTailMatches === 'boolean') ? v : null;
          if (ok && !done) this.lastNeedle.set(ptyId, { onPromptRow: ok.onPromptRow, screenCount: ok.screenCount, at: this.deps.now() });
          finish(ok);
        },
        () => finish(null)
      );
    });
  }

  /**
   * ABORT (section 5): the NO-INTERFERENCE late refusal. Destructive, so it gets its own
   * FRESH comparison immediately before the clear — never the commit check's — and the
   * erase is POSITIVELY verified before the item is released for retry. Anything short
   * of positive verification is INTERFERED: an erase that was merely issued is not an
   * erase that happened, and one uncertain erase is held, never settled CANCELLED.
   *
   * The verification is DIFFERENTIAL. The oracle is first required to SEE our text on
   * the prompt row; only then is its later absence evidence. A TUI that shows a paste
   * as a placeholder, or a needle that wrapped, fails the first reading and is held —
   * otherwise "not found afterwards" would verify on a screen that never showed it.
   */
  private async abort(s: Staged, basis: string, verifyBudgetMs = 0): Promise<SubmitOutcome> {
    const deps = this.deps;
    const cap = deps.abortCapability(s.req.agentId);
    if (cap.kind !== 'VERIFIED') return this.interfere(s, 'ABORT_CAPABILITY_UNVERIFIED', undefined);
    const needle = needleFor(s.req.text);
    if (!needle) return this.interfere(s, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', 'no usable needle');
    // WSG LIVENESS: a slow screen abort (verifyBudgetMs > 0) may re-read until our text is
    // POSITIVELY seen; a missing or empty reading is never evidence. A human key still wins.
    const seenBy = deps.now() + verifyBudgetMs;
    let before = await this.readScreen(s.ptyId, needle);
    while ((!before || !before.onPromptRow || before.screenCount < 1) && deps.now() < seenBy) {
      const waiting = postStageGuard(s, deps);
      if (waiting?.kind === 'FAILED') { if (s.decision) deps.capacity.cancelGrant(s.decision); return { kind: 'FAILED', reason: waiting.reason }; }
      if (waiting?.kind === 'INTERFERED') return this.interfere(s, waiting.reason, waiting.detail);
      await this.sleep(SCREEN_COMMIT_RETRY_MS);
      before = await this.readScreen(s.ptyId, needle);
    }
    if (!before || !before.onPromptRow || before.screenCount < 1) {
      return this.interfere(s, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', before ? 'not on the prompt row' : 'no screen reading');
    }
    // CODEX-MODEL-SWITCH-PROMPT P3: never a key into a Codex popup, not even the erase: one more
    // guard reading, and a popup on it holds the item for the Human with nothing written.
    if (this.guardMode(s.ptyId) === 'ENFORCE') {
      const g = await this.readGuard(s.ptyId);
      const popup = g && g.incarnation === s.incarnation ? codexPopup(g.facts) : null;
      if (popup) return this.interfere(s, 'CODEX_POPUP_OPEN', codexPopupText(popup));
    }
    // FRESH, and adjacent to the destructive write: no yield between this and the clear.
    const blocked = postStageGuard(s, deps);
    if (blocked) {
      if (blocked.kind === 'FAILED') { if (s.decision) deps.capacity.cancelGrant(s.decision); return { kind: 'FAILED', reason: blocked.reason }; }
      if (blocked.kind === 'INTERFERED') return this.interfere(s, blocked.reason, blocked.detail);
    }
    const cleared = safeWrite(deps, s.ptyId, cap.clearControl);
    if (!cleared.ok) return this.interfere(s, 'CLEAR_WRITE_FAILED', cleared.error);
    await this.sleep(cap.settleMs);
    const goneBy = deps.now() + verifyBudgetMs;
    let after = await this.readScreen(s.ptyId, needle);
    // BOTH halves, neither traded for the other: gone from the prompt row AND fewer on
    // the screen than before — so the text neither remains sendable nor merely moved.
    // WSG LIVENESS: a slow abort re-reads (bounded) until both halves hold; never assumes them.
    while ((!after || after.onPromptRow || after.screenCount >= before.screenCount) && deps.now() < goneBy) {
      await this.sleep(SCREEN_COMMIT_RETRY_MS);
      after = await this.readScreen(s.ptyId, needle);
    }
    if (!after || after.onPromptRow || after.screenCount >= before.screenCount) {
      return this.interfere(s, 'ERASE_NOT_VERIFIED', after ? `row=${after.onPromptRow} count=${after.screenCount}/${before.screenCount}` : 'no screen reading');
    }
    // WSG-FOLLOWUPS: a HALF erase (the needle gone, a fragment of our text left in the Codex
    // composer) would be refused at the re-offer's STAGE for ever, silently. POSITIVE evidence
    // of our own residue holds it instead, visibly; nothing more is written.
    if (this.guardMode(s.ptyId) === 'ENFORCE') {
      // Jim N-F1: a human key during the erase's verification is reported as such, not as residue.
      const blocked = postStageGuard(s, deps);
      if (blocked?.kind === 'FAILED') { if (s.decision) deps.capacity.cancelGrant(s.decision); return { kind: 'FAILED', reason: blocked.reason }; }
      if (blocked?.kind === 'INTERFERED') return this.interfere(s, blocked.reason, blocked.detail);
      const residueNow = async (): Promise<string | null> => {
        const r = await this.readGuard(s.ptyId);
        return r && r.incarnation === s.incarnation ? codexEraseResidue(r.facts, s.req.text) : null;
      };
      // ...and on TWO readings, so a frame caught mid-redraw is not taken for residue.
      if (await residueNow() !== null) {
        await this.sleep(SCREEN_COMMIT_RETRY_MS);
        const residue = await residueNow();
        if (residue !== null) return this.interfere(s, 'ERASE_LEFT_RESIDUE', `${residue.length} chars of our text left`);
      }
    }
    if (s.decision) deps.capacity.cancelGrant(s.decision);
    return { kind: 'ABORTED', detail: basis };
  }
}
