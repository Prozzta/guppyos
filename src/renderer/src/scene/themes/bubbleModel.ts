import { activityStatus, heavyText, type HeavyActivity } from '@shared/activityView';
import type { LivenessV1 } from '@shared/livenessV1';

/** The small, renderer-independent part of an agent needed by a thought cloud. */
export interface BubbleAgent {
  status: string;
  action?: string;
  lastPrompt?: string;
  carrying?: string;
  isGod?: boolean;
}

export interface BubbleThought {
  status: string;
  text: string;
  tool?: string;
}

/** A transient line supplied by Crew or another themed prop system. */
export interface BubbleSay {
  /** Stable within the producer's event stream; lets a cursor ignore a replay. */
  key: string;
  id: string;
  text: string;
  ttl?: number;
}

/** A replay-safe cursor for bounded event arrays such as Crew.events. */
export interface BubbleSayCursor {
  seen: Set<string>;
  order: string[];
}

const MAX_CURSOR_KEYS = 128;

export function createSayCursor(): BubbleSayCursor {
  return { seen: new Set(), order: [] };
}

/** Feed a possibly replayed event array exactly once per stable event key. */
export function consumeSays(
  events: readonly BubbleSay[],
  cursor: BubbleSayCursor,
  say: (id: string, text: string, options?: { ttl?: number }) => void
): void {
  for (const event of events) {
    if (cursor.seen.has(event.key)) continue;
    cursor.seen.add(event.key);
    cursor.order.push(event.key);
    if (cursor.order.length > MAX_CURSOR_KEYS) cursor.seen.delete(cursor.order.shift()!);
    say(event.id, event.text, event.ttl === undefined ? undefined : { ttl: event.ttl });
  }
}

function firstWords(prompt: string | undefined, maxWords = 6, maxChars = 42): string {
  if (!prompt) return '';
  const words = prompt.trim().split(/\s+/);
  let out = words.slice(0, maxWords).join(' ');
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
  else if (words.length > maxWords) out += '…';
  return out;
}

function liveActivity(agent: BubbleAgent, fallback = ''): string {
  return agent.action?.trim() || firstWords(agent.lastPrompt) || fallback;
}

/** The status and cloud text the floor should show, projected through liveness first.
 *  IDLE-MEANS-IDLE (1.1.87): then through the agent's place in the heavy-job lock, as the office
 *  floor does: when the lock changes the status, the cloud says the lock's line. */
export function activityThought(agent: BubbleAgent, liveness?: LivenessV1, heavy?: HeavyActivity | null): BubbleThought | null {
  const status = activityStatus(agent.status, liveness, heavy);
  if (status !== activityStatus(agent.status, liveness)) agent = { ...agent, action: heavyText(heavy) ?? agent.action };
  switch (status) {
    case 'working':
    case 'thinking': return { status, text: liveActivity(agent), tool: agent.carrying };
    case 'waiting': return { status, text: liveActivity(agent, 'waiting'), tool: agent.carrying };
    case 'blocked': return { status, text: liveActivity(agent, 'needs you') };
    case 'compacting': return { status, text: liveActivity(agent, 'compacting context') };
    case 'looping': return { status, text: liveActivity(agent, 'looping — breaker armed') };
    case 'idle': return { status, text: liveActivity(agent, agent.isGod ? 'running the floor' : 'idle'), tool: agent.carrying };
    default: return null;
  }
}
