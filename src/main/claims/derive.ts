import { createHash } from 'node:crypto';
import type { ClaimRec, ClaimState, ClaimsState, EventRec, KeyRegistry, LedgerRec, Status } from '../../shared/claims';

type MutableState = ClaimState;

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function recordOrder(a: LedgerRec, b: LedgerRec): number {
  return compare(a.at, b.at) || compare(a.wt, b.wt) || compare(a.id, b.id);
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(compare); }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function registryHash(registry: KeyRegistry): string {
  return createHash('sha256').update(canonical(registry)).digest('hex');
}

function chainHead(records: LedgerRec[]): string {
  // readLedger supplies verified records in append order; `prev` hashes the previous LINE, not mac.
  return records.at(-1)?.mac ?? '';
}

function canonicalKey(key: string, registry: KeyRegistry): string {
  let current = key;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const alias = registry.keys[current]?.aliasOf;
    if (!alias) break;
    current = alias;
  }
  return current;
}

function cardinality(key: string, registry: KeyRegistry): 'single' | 'multi' | undefined {
  const exact = registry.keys[key];
  if (exact) return exact.cardinality;
  for (const namespace of registry.namespaces) {
    const star = namespace.pattern.indexOf('*');
    const prefix = star < 0 ? namespace.pattern : namespace.pattern.slice(0, star);
    const suffix = star < 0 ? '' : namespace.pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) return namespace.cardinality;
  }
  return undefined;
}

function protectedFromMail(source: ClaimRec, target: ClaimRec): boolean {
  return source.source.startsWith('mail:') && (target.source === 'self' || target.source === 'human' || target.source === 'legacy');
}

function setStatus(state: MutableState | undefined, status: Status, reason: string, supersededBy?: string): void {
  if (!state || state.status === 'purged' || state.status === 'retracted') return;
  if (status === 'superseded?' && state.status === 'superseded') return;
  state.status = status;
  if (supersededBy) state.supersededBy = supersededBy;
  else delete state.supersededBy;
  state.reasons.push(reason);
}

/** Reconstruct the ledger-closed state. No clock, filesystem, usage, embedder, or arrival-order input. */
export function derive(records: LedgerRec[], registry: KeyRegistry, ruleConfig: { r4: boolean }): ClaimsState {
  const ordered = [...records].sort(recordOrder);
  const claims = ordered.filter((record): record is ClaimRec => record.t === 'claim');
  const events = ordered.filter((record): record is EventRec => record.t === 'event');
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const state: Record<string, MutableState> = Object.create(null) as Record<string, MutableState>;

  for (const claim of claims) {
    state[claim.id] = {
      id: claim.id, status: 'live', sightings: 1, firstAt: claim.at, lastAt: claim.at,
      pinned: claim.pin === true, reasons: [],
    };
  }

  const conflicts = new Map<string, { a: string; b: string; rule: 'R5' | 'R2-mail' }>();
  const addConflict = (a: string, b: string, rule: 'R5' | 'R2-mail') => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const [left, right] = [a, b].sort(compare);
    conflicts.set(`${rule}\0${left}\0${right}`, { a: left, b: right, rule });
  };

  // R1 is emitted by the writer as a sighting event, so duplicate claims are never synthesized here.
  for (const event of events) {
    if (event.ev !== 'sighting') continue;
    const targetId = event.targets[0];
    const target = state[targetId];
    if (!target) continue;
    target.sightings += 1;
    if (event.at < target.firstAt) target.firstAt = event.at;
    if (event.at > target.lastAt) target.lastAt = event.at;
  }

  // R2: only registered single-cardinality keys; ordering is bitemporal and independent of input order.
  const keyed = new Map<string, ClaimRec[]>();
  for (const claim of claims) {
    if (!claim.key || cardinality(canonicalKey(claim.key, registry), registry) !== 'single') continue;
    const key = canonicalKey(claim.key, registry);
    const list = keyed.get(key) ?? [];
    list.push(claim);
    keyed.set(key, list);
  }
  for (const list of keyed.values()) {
    list.sort(recordOrder);
    const category = (claim: ClaimRec): 'mail' | 'protected' | 'other' => claim.source.startsWith('mail:') ? 'mail'
      : claim.source === 'self' || claim.source === 'human' || claim.source === 'legacy' ? 'protected' : 'other';
    const latest: Partial<Record<'mail' | 'protected' | 'other', ClaimRec>> = {};
    for (const claim of list) latest[category(claim)] = claim;
    const suffix: Array<Partial<Record<'mail' | 'protected' | 'other', ClaimRec>>> = new Array(list.length);
    let after: Partial<Record<'mail' | 'protected' | 'other', ClaimRec>> = {};
    for (let i = list.length - 1; i >= 0; i--) {
      suffix[i] = after;
      after = { ...after, [category(list[i])]: list[i] };
    }
    for (let i = 0; i < list.length; i++) {
      const older = list[i];
      const candidates = suffix[i];
      const ownClass = category(older);
      const eligible = ownClass === 'protected' ? [candidates.protected, candidates.other]
        : ownClass === 'mail' ? [candidates.mail, candidates.protected, candidates.other]
          : [candidates.protected, candidates.mail, candidates.other];
      const newer = eligible.filter((item): item is ClaimRec => !!item).sort(recordOrder).at(-1);
      if (newer) setStatus(state[older.id], 'superseded', `R2 by ${newer.id}`, newer.id);
    }
    const newestProtected = latest.protected;
    const newestMail = latest.mail;
    const newestOther = latest.other;
    if (newestProtected && newestMail
      && recordOrder(newestMail, newestProtected) > 0
      && (!newestOther || (recordOrder(newestProtected, newestOther) > 0 && recordOrder(newestMail, newestOther) > 0))) {
      addConflict(newestProtected.id, newestMail.id, 'R2-mail');
    }
  }

  // R3 explicit supersedes/retracts. Defend against poisoned mail records even though W1 rejects them.
  for (const source of claims) {
    for (const targetId of source.supersedes ?? []) {
      const target = byId.get(targetId);
      if (target && !protectedFromMail(source, target)) setStatus(state[targetId], 'superseded', `R3 by ${source.id}`, source.id);
    }
    for (const targetId of source.retracts ?? []) {
      const target = byId.get(targetId);
      if (target && !protectedFromMail(source, target)) setStatus(state[targetId], 'retracted', `R3 retracted by ${source.id}`);
    }
  }

  // Reverts make the referenced event inert; event records remain in the ledger and in its hash chain.
  const reverted = new Set(events.filter((event) => event.ev === 'revert').flatMap((event) => event.targets));
  const answeredPairs = new Set<string>();
  const pairKey = (a: string, b: string): string => [a, b].sort(compare).join('\0');
  for (const event of events) {
    if (reverted.has(event.id) || event.ev === 'revert') continue;
    const [first, second] = event.targets;
    if (event.ev === 'purge') {
      for (const targetId of event.targets) {
        const target = state[targetId];
        if (target) { target.status = 'purged'; delete target.supersededBy; target.reasons.push(`R8 purge ${event.id}`); }
      }
    } else if (event.ev === 'soft-supersede' && first && second) {
      // A proposal can mark only an otherwise-live claim. Never weaken an explicit R2/R3/R4
      // supersede decision; soft newest-wins is advisory, not authoritative.
      if (state[first]?.status !== 'superseded') setStatus(state[first], 'superseded?', `soft-supersede by ${second}`, second);
    } else if (event.ev === 'reconcile-answer') {
      if (event.targets.length >= 2) {
        const [loser, winner] = event.targets;
        answeredPairs.add(pairKey(loser, winner));
        if (event.answer === 'supersedes') setStatus(state[loser], 'superseded', `reconcile-answer by ${winner}`, winner);
      }
      // `retract` is represented only by a ClaimRec.retracts per C3. keep-both just clears the pair.
    } else if (event.ev === 'dismiss' && event.targets.length >= 2) {
      answeredPairs.add(pairKey(event.targets[0], event.targets[1]));
    } else if (event.ev === 'accept') {
      if (event.targets.length >= 2) {
        const [loser, winner] = event.targets;
        answeredPairs.add(pairKey(loser, winner));
        if (state[loser]?.status === 'superseded?') setStatus(state[loser], 'superseded', `accepted soft-supersede by ${winner}`, winner);
      } else {
        const accepted = state[first];
        if (accepted?.status === 'superseded?') setStatus(accepted, 'superseded', 'accepted soft-supersede', accepted.supersededBy);
      }
    } else if (event.ev === 'inferred-supersede' && ruleConfig.r4 && first && second) {
      setStatus(state[first], 'superseded', `${event.rule ?? 'R4'} by ${second}`, second);
    } else if (event.ev === 'pin' || event.ev === 'unpin') {
      for (const targetId of event.targets) if (state[targetId]) state[targetId].pinned = event.ev === 'pin';
    }
  }

  const canonicalClaims: Record<string, ClaimState> = Object.create(null) as Record<string, ClaimState>;
  for (const id of Object.keys(state).sort(compare)) {
    const value = state[id];
    canonicalClaims[id] = { ...value, reasons: unique(value.reasons) };
  }
  const canonicalConflicts = [...conflicts.values()].filter((conflict) => !answeredPairs.has(pairKey(conflict.a, conflict.b)))
    .sort((a, b) => compare(a.rule, b.rule) || compare(a.a, b.a) || compare(a.b, b.b));
  return { v: 1, agent: claims[0]?.agent ?? ordered[0]?.agent ?? '', registryHash: registryHash(registry), ledgerHead: chainHead(records), claims: canonicalClaims, conflicts: canonicalConflicts };
}
