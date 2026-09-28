/**
 * v1.1.45 unit #5 — each agent's main-produced impact string, from control:snapshot.
 *
 * CRIT-15-PRE: PUSHED, never polled. Each agent's snapshot is read ONCE when something
 * first shows it (the mount-time initial state, which also tells main to serve it); after
 * that main pushes every change on its own channel (`window.cth.onAgentImpact`). There is
 * no timer. One subscription serves every card and row while anything is shown. A push
 * row outranks a mount answer that lands after it. The string is main's; nothing here
 * decides or words a hold.
 */
import { useSyncExternalStore } from 'react';
import type { AgentImpact, AgentImpactPush } from '@shared/deliveryHold';

const values = new Map<string, AgentImpact | null>();
const listeners = new Map<string, Set<() => void>>();
/** Agents whose row a push has carried: a later mount answer is older than it. */
const pushed = new Set<string>();
/** Agents with a mount-time read in flight: one read per genuine first mount, never two. */
const reading = new Set<string>();
let unsubscribePush: (() => void) | null = null;

const sameImpact = (a: AgentImpact | null | undefined, b: AgentImpact | null): boolean =>
  (a ?? null) === b || (!!a && !!b && a.kind === b.kind && a.text === b.text && a.verb === b.verb);

function store(agentId: string, next: AgentImpact | null): void {
  if (sameImpact(values.get(agentId), next) && values.has(agentId)) return;
  values.set(agentId, next);
  for (const l of listeners.get(agentId) ?? []) l();
}

function read(agentId: string): void {
  if (typeof window === 'undefined' || !window.cth?.controlSnapshot) return;
  if (reading.has(agentId)) return;
  reading.add(agentId);
  window.cth.controlSnapshot(agentId)
    .then((s) => {
      reading.delete(agentId);
      if (pushed.has(agentId) || !listeners.has(agentId)) return;
      store(agentId, s?.impact ?? null);
    })
    // Main not ready: say nothing rather than guess. Absence is "no impact known".
    .catch(() => { reading.delete(agentId); });
}

function onPush(push: AgentImpactPush): void {
  for (const row of push?.rows ?? []) {
    if (!listeners.has(row.agentId)) continue;
    pushed.add(row.agentId);
    store(row.agentId, row.impact ?? null);
  }
}

/**
 * IMPACT-LOOP-171: the renderer runaway of 2026-09-27/28 (MEMSPIKE-WHY, "Recurrence ... causal
 * chain"). The hook used to hand useSyncExternalStore a NEW subscribe closure on every render, so
 * React unsubscribed and re-subscribed on every render. The last unsubscribe deleted the cached
 * value, the re-subscribe was "first" again and re-read control:snapshot, and a non-null impact
 * (a capacity hold, the floor-wide delivery pause) then re-rendered the card, and so on: thousands
 * of IPCs a second until the renderer was killed.
 *
 * Two independent guards, either of which alone ends the loop:
 *  1. one subscribe function per agentId for the window's life (`subscribeFor`), so a re-render
 *     never unsubscribes;
 *  2. an unsubscribe never deletes the cached value. A later genuine first mount re-reads (one read
 *     in flight at most), and an answer equal to the cached value notifies nobody.
 */
function subscribe(agentId: string, listener: () => void): () => void {
  let set = listeners.get(agentId);
  const first = !set;
  if (!set) { set = new Set(); listeners.set(agentId, set); }
  set.add(listener);
  if (!unsubscribePush && typeof window !== 'undefined' && window.cth?.onAgentImpact) {
    unsubscribePush = window.cth.onAgentImpact(onPush);
  }
  if (first) read(agentId);
  return () => {
    set!.delete(listener);
    if (set!.size === 0 && listeners.get(agentId) === set) {
      // Nothing shows this agent now. Keep its last value (never delete-and-re-read); forget only
      // that a push outranked the mount answer, since pushes stop reaching us below.
      listeners.delete(agentId);
      pushed.delete(agentId);
    }
    if (listeners.size === 0 && unsubscribePush) { unsubscribePush(); unsubscribePush = null; }
  };
}

type Subscribe = (listener: () => void) => () => void;
const subscribeFns = new Map<string, Subscribe>();
const snapshotFns = new Map<string, () => AgentImpact | null>();

/** THE subscribe function for an agent: the same identity on every render (guard 1). */
function subscribeFor(agentId: string): Subscribe {
  let fn = subscribeFns.get(agentId);
  if (!fn) { fn = (l) => subscribe(agentId, l); subscribeFns.set(agentId, fn); }
  return fn;
}

function snapshotFor(agentId: string): () => AgentImpact | null {
  let fn = snapshotFns.get(agentId);
  if (!fn) { fn = () => values.get(agentId) ?? null; snapshotFns.set(agentId, fn); }
  return fn;
}

const NONE = (): null => null;
const noSubscribe: Subscribe = () => () => {};

/** The agent's impact, or null when nothing is held (or it is not known yet). */
export function useAgentImpact(agentId: string | undefined): AgentImpact | null {
  return useSyncExternalStore(
    agentId ? subscribeFor(agentId) : noSubscribe,
    agentId ? snapshotFor(agentId) : NONE,
    NONE
  );
}
