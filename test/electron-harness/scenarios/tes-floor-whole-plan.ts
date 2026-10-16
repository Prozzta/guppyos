/** The run tes-floor-whole.tsx makes: its first host box, the resizes and the selections (a selected
 *  agent's nudge must not move the whole camera: TES-SCENE-BOUNCE-188) at a render count, how many
 *  renders, and how often the texel check runs (1: every frame). A runner may swap this module. */
export const BOX = { w: 576, h: 587 };
export const RESIZES: Array<{ at: number; w: number; h: number }> = [{ at: 160, w: 960, h: 640 }, { at: 320, w: 700, h: 470 }, { at: 480, w: 1200, h: 900 }];
export const LAST = 660;
export const CHECK_EVERY = 1;
export const SELECTS: Array<{ at: number; id: string | null }> = [
  { at: 40, id: 'jim' }, { at: 80, id: 'god' }, { at: 120, id: null },
  { at: 190, id: 'andy' }, { at: 230, id: 'pam' }, { at: 270, id: null },
  { at: 340, id: 'dwight' }, { at: 380, id: 'pam' }, { at: 420, id: null },
  { at: 500, id: 'jim' }, { at: 540, id: 'god' }, { at: 580, id: null }
];
