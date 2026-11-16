/**
 * GUPPY-BLOB-P01: the Guppy blob, a small always-on-top overlay (the blobatar face) whose click
 * opens a radial ring of actions. Phase 0+1 ship the overlay, the ring, and the "invisible" toggle
 * (content protection: the window is left out of screen captures and shares). The capture actions
 * are slots only ("coming soon") until phase 2+.
 *
 * Pure: shared by main (validation, persistence), the overlay preload and the renderer.
 */
import type { DictationStatus } from './dictation';

/** The ring's six slots, clockwise from the top (UX: agents/god/refs/stapler-ring.png). */
export const BLOB_SLOTS = ['screenshot', 'meeting', 'invisible', 'close', 'screen', 'message'] as const;
export type BlobSlot = (typeof BLOB_SLOTS)[number];

/** Slots whose action is not built yet: the ring shows them, a click says "coming soon". */
export const BLOB_COMING_SOON: readonly BlobSlot[] = ['screenshot', 'meeting', 'message'];
/** Shown greyed out and never actionable (screen sharing is out of scope). */
export const BLOB_DISABLED: readonly BlobSlot[] = ['screen'];

/** Show/hide hotkey. Ctrl+Alt+Space stays free for phase-2 dictation. */
export const BLOB_DEFAULT_HOTKEY = 'Control+Alt+G';

/** BLOB-GAZE diagnostic: the overlay's one console line when the gaze driver runs but the eyes never move. */
export const BLOB_GAZE_DEAD = '[blob-gaze] eyes not driven:';

/** BLOB-SETUP-GUIDE: the public set-up guide, opened from Settings → Blob in the external browser. */
export const BLOB_SETUP_GUIDE_URL = 'https://guppyos.com/blob/setup/';

export interface BlobPosition { x: number; y: number }

/**
 * BLOB-ORCH-MOOD: the orchestrator's mood, as one main-process source sets it (setMood) and the
 * overlay, tray and toasts read it. Dictation states and ring reactions take priority on the face.
 *   idle      nothing notable              working   god is busy (face: thinking)
 *   sleepy    idle for a long time         waiting   an open ask for the Human (face: unsure)
 *   sick      the circuit breaker tripped  happy     a card done or a release
 *   sad       an error
 */
export const BLOB_MOODS = ['idle', 'working', 'sleepy', 'waiting', 'sick', 'happy', 'sad'] as const;
export type BlobMood = (typeof BLOB_MOODS)[number];
export function isBlobMood(m: unknown): m is BlobMood { return typeof m === 'string' && (BLOB_MOODS as readonly string[]).includes(m); }

/** BLOB-GAZE: where the eyes look, in the overlay window's client coordinates (DIPs). */
export interface BlobGazePoint { x: number; y: number }
/** How often main samples the screen cursor for the overlay's eyes while the feed is on. */
export const BLOB_GAZE_MS = 33;

/** The persisted blob settings, as main applies them. */
export interface BlobSettings {
  /** The blob overlay exists at all. Default off: zero behaviour change. */
  enabled: boolean;
  /** Global show/hide accelerator ('' = no hotkey). */
  hotkey: string;
  /** Content protection on the blob overlay. Default on: the blob is meant to stay out of shares. */
  invisible: boolean;
  /** Content protection on the app's own windows too (opt-in). */
  invisibleMain: boolean;
  /** Last dragged position (top-left of the collapsed blob), or null for the default corner. */
  position: BlobPosition | null;
  /** GUPPY-DICTATION-P2: hold Ctrl+Alt+Space to dictate into the focused app. Default off. */
  dictation: boolean;
}

/** The config fields behind BlobSettings (HarnessConfig keeps them flat). */
export interface BlobConfigFields {
  blobEnabled?: boolean;
  blobHotkey?: string;
  blobInvisible?: boolean;
  blobInvisibleMain?: boolean;
  blobPosition?: BlobPosition | null;
  blobDictation?: boolean;
}

/** What the Settings section may send (`blob:setConfig`); position is the overlay's own business. */
export interface BlobSettingsPatch { enabled?: boolean; hotkey?: string; invisible?: boolean; invisibleMain?: boolean; dictation?: boolean }

/** What main tells the overlay and the Settings section. */
export interface BlobStatus extends BlobSettings {
  /** The hotkey is registered (false when the OS or another app holds it). */
  hotkeyRegistered: boolean;
  /** The overlay is currently shown. */
  visible: boolean;
  /** Where dictation is (off unless enabled, supported and armed). */
  dictationStatus: DictationStatus;
  /** BLOB-ORCH-MOOD: the orchestrator's mood (idle until a source sets it). */
  mood: BlobMood;
}

/** What main pushes to the overlay on `blob:status`. */
export type BlobOverlayStatus = BlobStatus & { ringOpen?: boolean };

/** `window.blob` in the overlay renderer (src/preload/blob.ts). Nothing else is exposed there. */
export interface BlobOverlayApi {
  status(): Promise<{ ok: true; status: BlobStatus } | { ok: false; error: string }>;
  action(slot: BlobSlot): Promise<BlobActionResult>;
  ring(open: boolean): Promise<{ ok: true; status: BlobStatus } | { ok: false; error: string }>;
  drag(phase: 'start' | 'move' | 'end'): Promise<{ ok: boolean; error?: string }>;
  onStatus(cb: (s: BlobOverlayStatus) => void): () => void;
  /** BLOB-GAZE: ask main to feed (or stop feeding) the cursor/focus point. Off under reduced motion. */
  gaze(on: boolean): Promise<{ ok: boolean; error?: string }>;
  /** BLOB-GAZE: each point main sends while the feed is on (only when it changes). */
  onGaze(cb: (p: BlobGazePoint) => void): () => void;
}

export type BlobActionResult =
  | { ok: true; slot: BlobSlot; state: 'done'; status: BlobStatus }
  | { ok: true; slot: BlobSlot; state: 'coming-soon' | 'disabled' }
  | { ok: false; error: string };

const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);
const KEY_RE = /^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|space|tab|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|plus|[`\-=[\]\\;',./])$/i;

/**
 * An Electron accelerator we accept: one or more modifiers then exactly one key. A bare key would
 * be swallowed system-wide, so at least one modifier is required. '' means "no hotkey".
 */
export function isValidBlobHotkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s === '') return true;
  if (s.length > 64) return false;
  const parts = s.split('+');
  if (parts.length < 2 || parts.some((p) => p === '')) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  if (!mods.every((m) => MODIFIERS.has(m)) || new Set(mods).size !== mods.length) return false;
  return KEY_RE.test(key);
}

function isPosition(p: unknown): p is BlobPosition {
  return !!p && typeof p === 'object'
    && Number.isFinite((p as BlobPosition).x) && Number.isFinite((p as BlobPosition).y)
    && Math.abs((p as BlobPosition).x) < 100_000 && Math.abs((p as BlobPosition).y) < 100_000;
}

/** The settings a config holds, with defaults for anything absent or malformed. */
export function blobSettingsFrom(cfg: BlobConfigFields | null | undefined): BlobSettings {
  const c = cfg ?? {};
  return {
    enabled: c.blobEnabled === true,
    hotkey: isValidBlobHotkey(c.blobHotkey) ? c.blobHotkey : BLOB_DEFAULT_HOTKEY,
    invisible: c.blobInvisible !== false,
    invisibleMain: c.blobInvisibleMain === true,
    position: isPosition(c.blobPosition) ? { x: Math.round(c.blobPosition.x), y: Math.round(c.blobPosition.y) } : null,
    dictation: c.blobDictation === true,
  };
}

/**
 * A Settings patch from a renderer, reduced to valid config fields. Unknown keys and wrong types
 * are dropped; an invalid hotkey is an error (the user typed it and should hear why).
 */
export function sanitizeBlobPatch(patch: unknown): { ok: true; fields: BlobConfigFields } | { ok: false; error: string } {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid patch' };
  const p = patch as Record<string, unknown>;
  const fields: BlobConfigFields = {};
  if (typeof p.enabled === 'boolean') fields.blobEnabled = p.enabled;
  if (typeof p.invisible === 'boolean') fields.blobInvisible = p.invisible;
  if (typeof p.invisibleMain === 'boolean') fields.blobInvisibleMain = p.invisibleMain;
  if (typeof p.dictation === 'boolean') fields.blobDictation = p.dictation;
  if ('hotkey' in p) {
    const h = typeof p.hotkey === 'string' ? p.hotkey.trim() : p.hotkey;
    if (!isValidBlobHotkey(h)) return { ok: false, error: 'invalid hotkey (use modifiers then one key, e.g. Control+Alt+G)' };
    fields.blobHotkey = h;
  }
  return { ok: true, fields };
}
