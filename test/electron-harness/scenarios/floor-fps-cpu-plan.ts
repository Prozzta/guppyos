/** The default plan for floor-fps-cpu.tsx; run-floor-fps-cpu.cjs --plan <file> swaps in another
 *  (HARNESS_SOURCE_OVERRIDES). `hide` takes TES layers out after the warm-up, to price each one. */
export type FloorLayer = 'below' | 'statics' | 'above' | 'people';
export interface FloorRun { theme: 'idle' | 'office' | 'tes'; hide?: FloorLayer[] }
export interface FloorPlan { box: { w: number; h: number }; runs: FloorRun[] }

const plan: FloorPlan = {
  box: { w: 160, h: 100 },
  runs: [{ theme: 'idle' }, { theme: 'office' }, { theme: 'tes' }, { theme: 'office' }, { theme: 'tes' }, { theme: 'idle' }],
};
export default plan;
