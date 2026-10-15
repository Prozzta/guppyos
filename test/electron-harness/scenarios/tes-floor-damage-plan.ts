/** The run tes-floor-damage.tsx makes, by render count: the host box and its resizes, the
 *  selections (each nudges the camera), the crew's changes (an agent leaves and comes back, a
 *  status flips, which brings or drops a thought cloud), and a lost WebGL context. A runner may
 *  swap this module (a mutant run swaps the sources instead). */
export const BOX = { w: 576, h: 587 };
export const RESIZES: Array<{ at: number; w: number; h: number }> = [{ at: 200, w: 960, h: 640 }, { at: 400, w: 700, h: 470 }];
export const SELECTS: Array<{ at: number; id: string | null }> = [{ at: 60, id: 'jim' }, { at: 110, id: null }, { at: 470, id: 'pam' }, { at: 520, id: null }];
export const CREW: Array<{ at: number; leave?: string; back?: string; status?: [string, string] }> = [
  { at: 140, leave: 'andy' }, { at: 170, back: 'andy' },
  { at: 250, status: ['jim', 'working'] }, { at: 300, status: ['pam', 'idle'] }, { at: 340, status: ['jim', 'idle'] }
];
export const LOSE_AT = 560;
export const LAST = 700;
/** Frames the rebuilt floor draws before the run ends. */
export const AFTER = 140;
