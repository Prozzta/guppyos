// The people of a stations scene: who holds which station, who walks where,
// who sits. Ported from the bridge viewer's crew behaviour (spawn at the
// entrance, goTo, walkZones, the tick's seat/wander logic), with stations
// handed out by the manifest-driven SeatAllocator. Idle errands and coffee are
// not ported here (the viewer's errand picker has an open loop bug); idle
// agents wander instead. Pure: the Pixi scene only draws what this reports.

import { footBox, footHits, route, wanderTarget, cellCentre, type Station, type StationMap } from './stationMap';
import { SeatAllocator, type SeatChange, type SeatRules } from './seatAllocator';
import type { Facing } from './manifest';

/** Walking speed in map pixels per millisecond (the viewer's). */
export const WALK_SPEED = 0.045;

/** States that keep (or take) a seat and sit at it. */
export const atDesk = (s: string): boolean => s === 'working' || s === 'blocked' || s === 'error' || s === 'thinking' || s === 'waiting' || s === 'compacting' || s === 'looping';

export interface CrewAgent {
  id: string;
  status: string;
  orchestrator?: boolean;
  presetId?: string;
}

export interface Walker {
  id: string;
  x: number;
  y: number;
  dir: Facing;
  moving: boolean;
  path: Array<[number, number]>;
  /** The station this agent holds (from the allocator). */
  seat: Station | null;
  lastSeat: Station | null;
  seated: boolean;
  /** A route to the seat was tried (the next stop sits down). */
  tried: boolean;
  /** Arrived at the end of the current path this tick. */
  arrived: boolean;
  /** ms until the next wander stop. */
  idle: number;
  /** ms before the first step (arrivals are staggered). */
  wait: number;
  status: string;
}

export class Crew {
  readonly SM: StationMap;
  readonly seats: SeatAllocator;
  private readonly byName = new Map<string, Station>();
  private readonly people = new Map<string, Walker>();
  private readonly rand: () => number;
  /** The last allocator changes (for tests and the scene's logs). */
  lastChanges: SeatChange[] = [];

  constructor(SM: StationMap, rules: SeatRules, rand: () => number = Math.random) {
    this.SM = SM;
    this.rand = rand;
    for (const s of SM.seatOrder) this.byName.set(s.name, s);
    this.seats = new SeatAllocator({ ...rules, order: rules.order.filter((n) => this.byName.has(n)) });
  }

  walkers(): Walker[] { return [...this.people.values()]; }
  get(id: string): Walker | undefined { return this.people.get(id); }

  private entry(): [number, number] {
    const SM = this.SM;
    return SM.entrance ? [SM.entrance[0], SM.entrance[1]] : SM.start ? cellCentre(SM.grid, SM.start) : [0, 0];
  }

  /** Bring the floor in line with the roster: arrivals, departures, status changes. */
  sync(agents: CrewAgent[]): void {
    const changes: SeatChange[] = [];
    const ids = new Set(agents.map((a) => a.id));
    for (const id of [...this.people.keys()]) if (!ids.has(id)) { changes.push(...this.seats.leave(id)); this.people.delete(id); }
    let arrivals = 0;
    for (const a of agents) {
      let p = this.people.get(a.id);
      if (!p) {
        const [x, y] = this.entry();
        p = { id: a.id, x, y, dir: 'down', moving: false, path: [], seat: null, lastSeat: null, seated: false, tried: false, arrived: false, idle: 0, wait: arrivals++ * 400, status: a.status };
        this.people.set(a.id, p);
        changes.push(...this.seats.join({ id: a.id, orchestrator: a.orchestrator, presetId: a.presetId }));
      } else if (p.status !== a.status) {
        const wasDesk = atDesk(p.status);
        p.status = a.status;
        if (wasDesk && !atDesk(a.status)) this.standUp(p);
        if (!wasDesk && atDesk(a.status)) { p.tried = false; p.path = []; }
      }
    }
    for (const c of changes) this.apply(c);
    this.lastChanges = changes;
  }

  /** A station moved: a seated agent stands up and walks to the new one. */
  private apply(c: SeatChange): void {
    const p = this.people.get(c.agentId);
    if (!p) return;
    const to = c.to ? this.byName.get(c.to) ?? null : null;
    if (p.seat && p.seat !== to) { p.lastSeat = p.seat; }
    p.seat = to;
    p.seated = false; p.tried = false; p.path = [];
  }

  private standUp(p: Walker): void {
    if (p.seated) p.lastSeat = p.seat;
    p.seated = false; p.tried = false; p.path = []; p.idle = 0;
  }

  /** Where p may cross solid pixels: the seat it heads for, and a seat its feet are still in (leaving it). */
  walkZones(p: Walker): Array<[number, number, number, number]> {
    const Z: Array<[number, number, number, number]> = [];
    const fb = footBox(p.x, p.y), stuck = footHits(this.SM, p.x, p.y) > 0;
    const touch = (rects: Array<[number, number, number, number]>) => rects.some(([a, b, c, d]) => fb[0] < c && fb[2] > a && fb[1] < d && fb[3] > b);
    const taken = (s: Station) => this.walkers().some((q) => q !== p && q.seat === s);
    for (const [s, rects] of this.SM.seatZones) {
      const mine = s === p.seat && atDesk(p.status);
      if (mine || ((s === p.lastSeat || s === p.seat || (stuck && !taken(s))) && touch(rects))) Z.push(...rects);
    }
    return Z;
  }

  goTo(p: Walker, tx: number, ty: number, exact: boolean): boolean {
    const path = route(this.SM, p.x, p.y, tx, ty, this.walkZones(p), exact);
    if (!path) return false;
    p.path = path;
    return true;
  }

  tick(dt: number): void {
    for (const p of this.people.values()) {
      if (p.wait > 0) { p.wait -= dt; continue; }
      if (!p.path.length) {
        p.moving = false;
        p.arrived = false;
        if (p.seat && atDesk(p.status) && !p.seated) {
          if (!p.tried) { p.tried = true; if (!this.goTo(p, p.seat.x, p.seat.y, true)) p.idle = 2000; }
          else if (Math.hypot(p.x - p.seat.x, p.y - p.seat.y) < this.SM.grid.g * 2) { p.seated = true; p.lastSeat = p.seat; p.dir = p.seat.facing; }
          else if ((p.idle -= dt) <= 0) { p.tried = false; p.idle = 2000; } // could not get there: try again in a while
        } else if (!p.seated) {
          if ((p.idle -= dt) <= 0) {
            const t = wanderTarget(this.SM, this.rand);
            if (t) this.goTo(p, t[0], t[1], true);
            p.idle = 1500 + this.rand() * 3000;
          }
        }
        continue;
      }
      p.seated = false;
      const [tx, ty] = p.path[0], dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy), step = WALK_SPEED * dt;
      p.moving = true;
      p.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (d <= step) { p.x = tx; p.y = ty; p.path.shift(); if (!p.path.length) p.arrived = true; }
      else { p.x += dx / d * step; p.y += dy / d * step; }
    }
  }
}
