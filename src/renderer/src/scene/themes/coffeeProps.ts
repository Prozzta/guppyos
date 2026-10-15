// What the stations floor shows of the crew's coffee (COFFEE-NEVER-186). The crew model
// (crew.ts) has run coffee since 1.1.85, but the floor drew only the people, so a coffee run
// looked like a wander stop. The bridge viewer's draw half, as data: a mug in the hand
// while one is carried, a mug parked at a station, and a short line while brewing (a refill
// when they brought their own mug) and when the sip starts. Pure: it reads the crew and
// returns props; the scene draws them, the tests check them.

import type { Crew, Walker } from './crew';
import type { Facing } from './manifest';

/** The viewer's bubble lines (bridge-viewer.html LINES). */
export const COFFEE_LINES = {
  coffee: ['mmm, fresh one ☕', 'the good beans today', 'just one more cup', 'replicator never gets it right…'],
  brewing: ['brewing a fresh one ☕'],
  refill: ['a quick refill ☕'],
} as const;

/** How long the sip line shows after the sip starts, ms (the viewer's 3000). */
export const SIP_LINE_MS = 3000;

export type CoffeeProp =
  /** A mug in the hand of a standing or walking agent, at its feet position. */
  | { kind: 'cup'; id: string; x: number; y: number; dir: Facing }
  /** A mug parked at a station: `full` while it still steams. */
  | { kind: 'mug'; owner: string; x: number; y: number; full: boolean }
  /** A line over an agent's head. */
  | { kind: 'say'; id: string; text: string };

/** A stable pick, so a line does not change from frame to frame. */
function pick(lines: readonly string[], key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return lines[Math.abs(h) % lines.length];
}

/** The coffee props for the crew as it stands now. */
export function coffeeProps(crew: Pick<Crew, 'walkers' | 'mugAt' | 'events' | 't'>): CoffeeProp[] {
  const out: CoffeeProp[] = [];
  const sipAt = new Map<string, number>();
  for (const e of crew.events) if (e.kind === 'sip') sipAt.set(e.id, e.at);
  for (const p of crew.walkers() as Walker[]) {
    if (p.mug) {
      const [x, y] = crew.mugAt(p.mug);
      out.push({ kind: 'mug', owner: p.id, x, y, full: crew.t < p.mug.full });
    }
    // Seated, a mug in hand is parked at once (crew.sitDown); a sitter holds none.
    if (p.cup && !p.seated) out.push({ kind: 'cup', id: p.id, x: p.x, y: p.y, dir: p.dir });
    if (p.coffee?.phase === 'brewing') {
      out.push({ kind: 'say', id: p.id, text: pick(p.cup ? COFFEE_LINES.refill : COFFEE_LINES.brewing, p.id) });
      continue;
    }
    const at = sipAt.get(p.id);
    const sipping = p.coffee?.phase === 'sipping' || (p.homeSit && p.sip > 0);
    if (at !== undefined && sipping && crew.t - at < SIP_LINE_MS) {
      out.push({ kind: 'say', id: p.id, text: pick(COFFEE_LINES.coffee, `${p.id}@${at}`) });
    }
  }
  return out;
}
