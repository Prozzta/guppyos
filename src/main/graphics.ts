/**
 * GPU-SETTING-188 — main's half of the Graphics setting (src/shared/graphicsMode.ts has the rules).
 *
 * The mode is read from config.json ONCE, at startup, before app ready: `disableHardwareAcceleration`
 * only works before ready, and the floors' WebGL power preference is chosen when they first draw.
 * The read is deliberately NOT readConfig (that one quarantines a corrupt file and migrates): it is a
 * plain read of one key, and anything unreadable is 'auto', so a bad config.json never blocks the
 * app and never forces software rendering.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  graphicsModeFromConfigText, graphicsModeOf, hardwareCompositing,
  type GraphicsMode, type GraphicsStatus
} from '../shared/graphicsMode';

/** The parts of Electron's `app` this needs (a fake in the unit tests). */
export interface GraphicsApp {
  isReady(): boolean;
  getPath(name: 'userData'): string;
  disableHardwareAcceleration(): void;
}

let applied: GraphicsMode = 'auto';
let hardwareDisabled = false;
let appliedOnce = false;

/** The mode saved in `<userData>/config.json`, 'auto' when the file is missing, unreadable or corrupt. */
export function readStartupGraphicsMode(userData: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): GraphicsMode {
  let text: string | null = null;
  try { text = read(join(userData, 'config.json')); } catch { /* missing or unreadable: the default */ }
  return graphicsModeFromConfigText(text);
}

/**
 * Apply the saved mode. MUST run at module load of main, before app ready (index.ts, right after the
 * userData path is final). 'cpu' disables hardware acceleration; 'auto' and 'gpu' leave Chromium's GPU
 * choice and blocklist alone (gpu only changes the floors' WebGL power preference). Too late (after
 * ready) it applies nothing and says so: the run keeps Chromium's default, never a half-applied mode.
 */
export function applyGraphicsModeAtStartup(app: GraphicsApp, read?: (p: string) => string): { mode: GraphicsMode; applied: boolean } {
  if (appliedOnce) return { mode: applied, applied: true };
  const mode = readStartupGraphicsMode(app.getPath('userData'), read);
  if (app.isReady()) {
    console.error(`[graphics] the graphics mode "${mode}" was read after app ready: not applied this run`);
    return { mode, applied: false };
  }
  if (mode === 'cpu') { app.disableHardwareAcceleration(); hardwareDisabled = true; }
  applied = mode;
  appliedOnce = true;
  return { mode, applied: true };
}

/** The mode this run started with. */
export function appliedGraphicsMode(): GraphicsMode { return applied; }

/** What the Settings indicator needs from main: the mode in force, the saved one, Chromium's view. */
export function graphicsStatus(storedConfig: { graphicsMode?: unknown } | null | undefined, featureStatus: Record<string, string> | null | undefined): GraphicsStatus {
  return {
    applied,
    stored: graphicsModeOf(storedConfig),
    hardwareDisabled,
    hardwareCompositing: hardwareDisabled ? false : hardwareCompositing(featureStatus)
  };
}

/** Unit tests only: forget what this module applied. */
export function __resetGraphicsForTests(): void { applied = 'auto'; hardwareDisabled = false; appliedOnce = false; }
