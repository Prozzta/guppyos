import { Container } from 'pixi.js';
import { MessageEnvelope, type MessageAct } from '../office/MessageEnvelope';
import { ThoughtBubble } from '../office/ThoughtBubble';
import { consumeSays as consumeSayEvents, type BubbleSay, type BubbleSayCursor } from './bubbleModel';

export type BubbleAnchor = { id: string; x: number; y: number };
export type BubbleSayOptions = { ttl?: number; key?: string };

type ActiveThought = {
  bubble: ThoughtBubble;
  thought: { text: string; tool?: string } | null;
  say: { text: string; until: number; key?: string } | null;
  shown: string | null;
};

const DEFAULT_SAY_MS = 2600;
const MAX_ENVELOPES = 20;

/** Shared world-space bubble overlay for station themes. */
export class BubbleLayer {
  readonly container = new Container();
  private readonly thoughts = new Map<string, ActiveThought>();
  private readonly anchors = new Map<string, { x: number; y: number }>();
  private readonly envelopes: MessageEnvelope[] = [];
  private now = 0;

  constructor(private readonly bounds: { width: number; height: number }) {
    this.container.sortableChildren = true;
    this.container.eventMode = 'none';
  }

  setThought(id: string, thought: { text: string; tool?: string } | null): void {
    const active = this.get(id);
    active.thought = thought;
    this.render(active);
  }

  /** Public prop API: show one temporary speech line, then restore the thought. */
  say(id: string, text: string, options: BubbleSayOptions = {}): void {
    const active = this.get(id);
    active.say = { text, until: this.now + Math.max(0, options.ttl ?? DEFAULT_SAY_MS), key: options.key };
    this.render(active);
  }

  /** Take a keyed speech line off early (its prop ended); any other line is left alone. */
  unsay(id: string, key: string): void {
    const active = this.thoughts.get(id);
    if (!active || !active.say || active.say.key !== key) return;
    active.say = null;
    this.render(active);
  }

  /** Public event-feed API for Crew-like bounded arrays. */
  consumeSays(events: readonly BubbleSay[], cursor: BubbleSayCursor): void {
    consumeSayEvents(events, cursor, (id, text, options) => this.say(id, text, options));
  }

  remove(id: string): void {
    const active = this.thoughts.get(id);
    if (!active) return;
    active.bubble.destroy();
    this.thoughts.delete(id);
    this.anchors.delete(id);
  }

  /** Spawn an envelope using the latest feet anchors; unknown endpoints are ignored. */
  handoff(fromId: string, toId: string, act: MessageAct, needsHuman = false): void {
    if (this.envelopes.length >= MAX_ENVELOPES || fromId === toId) return;
    const from = this.anchors.get(fromId), to = this.anchors.get(toId);
    if (!from || !to) return;
    const envelope = new MessageEnvelope(from, to, act, needsHuman);
    this.container.addChild(envelope.container);
    this.envelopes.push(envelope);
  }

  /** Update positions and lifetimes. Must run even when station depth did not change. */
  update(dt: number, anchors: readonly BubbleAnchor[], zoom: number): void {
    this.now += dt;
    this.anchors.clear();
    for (const anchor of anchors) this.anchors.set(anchor.id, anchor);

    const layouts: Array<{ active: ActiveThought; x: number; y: number; w: number; h: number; anchor: { x: number; y: number } }> = [];
    for (const [id, active] of this.thoughts) {
      if (active.say && active.say.until <= this.now) { active.say = null; this.render(active); }
      const anchor = this.anchors.get(id);
      if (!anchor) { active.bubble.hide(); continue; }
      active.bubble.setBounds(this.bounds.width, this.bounds.height);
      active.bubble.setZoom(zoom);
      active.bubble.setLift(0);
      active.bubble.setPosition(anchor.x, anchor.y);
      const layout = active.bubble.getLayout(anchor.x, anchor.y);
      if (layout) layouts.push({ active, anchor, ...layout });
    }

    layouts.sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x);
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const item of layouts) {
      let y = item.y;
      for (let moved = true, guard = 0; moved && guard++ < 12;) {
        moved = false;
        for (const prior of placed) {
          const overlapX = item.x < prior.x + prior.w + 4 && item.x + item.w + 4 > prior.x;
          const overlapY = y < prior.y + prior.h + 4 && y + item.h + 4 > prior.y;
          if (overlapX && overlapY) { y = prior.y - item.h - 4; moved = true; }
        }
      }
      item.active.bubble.setLift(item.y - y);
      item.active.bubble.setPosition(item.anchor.x, item.anchor.y);
      placed.push({ x: item.x, y, w: item.w, h: item.h });
    }

    for (const active of this.thoughts.values()) active.bubble.update(dt / 1000);
    for (let i = this.envelopes.length - 1; i >= 0; i--) {
      if (this.envelopes[i].update(dt / 1000)) {
        this.envelopes[i].destroy();
        this.envelopes.splice(i, 1);
      }
    }
  }

  destroy(): void {
    for (const active of this.thoughts.values()) active.bubble.destroy();
    for (const envelope of this.envelopes) envelope.destroy();
    this.thoughts.clear();
    this.envelopes.length = 0;
    this.container.destroy({ children: true });
  }

  private get(id: string): ActiveThought {
    let active = this.thoughts.get(id);
    if (active) return active;
    const bubble = new ThoughtBubble();
    this.container.addChild(bubble.container);
    active = { bubble, thought: null, say: null, shown: null };
    this.thoughts.set(id, active);
    return active;
  }

  private render(active: ActiveThought): void {
    const next = active.say ? active.say.text : active.thought?.text ?? null;
    if (next === active.shown) return;
    active.shown = next;
    if (next === null) active.bubble.hide();
    else active.bubble.show(next, active.say ? undefined : active.thought?.tool);
  }
}
