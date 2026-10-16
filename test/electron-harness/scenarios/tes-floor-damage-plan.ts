/** The run tes-floor-damage.tsx makes, by render count: the host box and its resizes, the
 *  selections (a nudge, which no longer moves the whole camera: TES-SCENE-BOUNCE-188), the crew's changes (an agent leaves and comes back, a
 *  status flips, which brings or drops a thought cloud), and a lost WebGL context. A runner may
 *  swap this module (a mutant run swaps the sources instead). */
export const BOX = { w: 576, h: 587 };
export const RESIZES: Array<{ at: number; w: number; h: number }> = [{ at: 200, w: 960, h: 640 }, { at: 400, w: 700, h: 470 }];
export const SELECTS: Array<{ at: number; id: string | null }> = [{ at: 60, id: 'jim' }, { at: 110, id: null }, { at: 470, id: 'pam' }, { at: 520, id: null }];
export const CREW: Array<{ at: number; leave?: string; back?: string; status?: [string, string] }> = [
  { at: 140, leave: 'andy' }, { at: 170, back: 'andy' },
  { at: 250, status: ['jim', 'working'] }, { at: 300, status: ['pam', 'idle'] }, { at: 340, status: ['jim', 'idle'] }
];
/** In-place look changes, none of which moves anything: a still person (the floor never dims or tints
 *  one today, so the run does it) is dimmed, tinted, blended, and one is put behind the props,
 *  each then put back; then the layer all people and props share is dimmed and made unrenderable.
 *  `at` counts from the first render at or after LOOKS_FROM that follows 8 frames none of which was
 *  drawn whole (the camera has settled), so no whole frame hides a missed change. */
export const LOOKS_FROM = 260;
export const LOOKS: Array<{ at: number; look: 'pick' | 'alpha' | 'tint' | 'blend' | 'behind' | 'back' | 'layerAlpha' | 'layerHidden' | 'layerBack' }> = [
  { at: 0, look: 'pick' }, { at: 3, look: 'alpha' }, { at: 7, look: 'back' }, { at: 10, look: 'tint' }, { at: 14, look: 'back' },
  { at: 17, look: 'blend' }, { at: 21, look: 'back' }, { at: 24, look: 'behind' }, { at: 28, look: 'back' },
  { at: 30, look: 'layerAlpha' }, { at: 32, look: 'layerBack' }, { at: 34, look: 'layerHidden' }, { at: 36, look: 'layerBack' }
];
/** The edge step (the clear's pin) starts at the first render at or after EDGE_FROM that follows 8
 *  frames none of which was drawn whole: in the 700x470 pane, before the selection at 470. */
export const EDGE_FROM = 420;
export const LOSE_AT = 560;
export const LAST = 700;
/** Frames the rebuilt floor draws before the run ends. */
export const AFTER = 140;
