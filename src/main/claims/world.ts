import type { ClaimRec, ClaimsState, LedgerRec, UsageRec, WorldFlag, WorldInputs, WorldView } from '../../shared/claims';

function later(a: string | undefined, b: string): string { return !a || b > a ? b : a; }

function expired(claim: ClaimRec, world: WorldInputs): boolean {
  if (!claim.ttl) return false;
  if (claim.ttl.startsWith('task:')) {
    const status = world.taskStatus(claim.ttl.slice('task:'.length));
    return status === 'done' || status === 'cancelled';
  }
  const until = claim.ttl.startsWith('until:') ? claim.ttl.slice('until:'.length) : null;
  if (!until) return false;
  const untilMs = Date.parse(until);
  const nowMs = Date.parse(world.now);
  return Number.isFinite(untilMs) && Number.isFinite(nowMs) && untilMs <= nowMs;
}

function staleRef(type: string, value: string, world: WorldInputs): boolean {
  if (type === 'file') return !world.fileExists(value);
  if (type === 'commit') return !world.commitExists(value);
  if (type === 'task') return world.taskStatus(value) === null;
  return false;
}

/** Compute world-dependent flags and usage ranking signals at view time; nothing is persisted in ClaimsState. */
export function worldView(state: ClaimsState, records: LedgerRec[], usage: UsageRec[], world: WorldInputs): WorldView {
  const claimsById = new Map(records.filter((record): record is ClaimRec => record.t === 'claim').map((claim) => [claim.id, claim]));
  const flags: Record<string, WorldFlag[]> = Object.create(null) as Record<string, WorldFlag[]>;
  const counters: WorldView['counters'] = Object.create(null) as WorldView['counters'];

  for (const id of Object.keys(state.claims).sort()) {
    const claim = claimsById.get(id);
    const claimFlags: WorldFlag[] = [];
    if (claim && expired(claim, world)) claimFlags.push('expired');
    if (claim) {
      for (const ref of claim.refs ?? []) {
        if (staleRef(ref.type, ref.value, world)) claimFlags.push('stale-ref');
        if (ref.type === 'file' && world.fileChangedSince(ref.value, state.claims[id].lastAt)) claimFlags.push('changed-since');
      }
    }
    if (claimFlags.length) flags[id] = [...new Set(claimFlags)].sort();
    counters[id] = { helped: 0, hurt: 0 };
  }

  for (const item of usage) {
    const counter = counters[item.claim];
    if (!counter) continue;
    counter.lastSeen = later(counter.lastSeen, item.at);
    const outcome = item.op === 'helped' || item.op === 'hurt'
      ? item.op
      : item.card ? world.cardOutcomes[item.card] : undefined;
    if (outcome === 'helped') counter.helped += 1;
    else if (outcome === 'hurt') counter.hurt += 1;
  }

  return { flags, counters };
}
