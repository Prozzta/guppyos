/**
 * BLOB-TRAY-TOASTS + BLOB-ORCH-MOOD: which of the Blob's faces each surface shows. The Blob is one
 * of one: the overlay (BlobApp), the tray icon, the toasts and the saved image all draw the same
 * name, palette and traits (BLOB_IDENTITY) and pick a face from the one orchestrator mood.
 */
import type { BlobMood } from './blob';
import type { DictationState } from './dictation';

/** The Blob's identity: the reference's bright yellow blob. blobatar's own swatches are
 *  contrast-muted (OKLCH hue 90 gives #c9a32e), so the head and eye colours are pinned. */
export const BLOB_IDENTITY = {
  name: 'guppy',
  palette: { head: '#ffd84a', eye: '#1a1320' },
  traits: { shape: 0.05 },
} as const;

/** Faces rendered to PNG (each one is a blobatar/expression export of the same name). */
export const BLOB_FACES = ['idle', 'thinking', 'sleepy', 'unsure', 'sick', 'happy', 'sad', 'shy', 'surprised'] as const;
export type BlobFace = (typeof BLOB_FACES)[number];

/** The orchestrator's mood as a face (BlobApp's MOOD_EXPR, by name). */
export const MOOD_FACE: Record<BlobMood, BlobFace> = {
  idle: 'idle',
  working: 'thinking',
  sleepy: 'sleepy',
  waiting: 'unsure',
  sick: 'sick',
  happy: 'happy',
  sad: 'sad',
};

/** Dictation states that take over the overlay face (BlobApp's DICT_EXPR, by name). */
export const DICTATION_FACE: Partial<Record<DictationState, BlobFace>> = {
  listening: 'surprised',
  transcribing: 'thinking',
  typing: 'happy',
  error: 'unsure',
  unavailable: 'unsure',
};

/** The tray icon's face. Dictation first (listening/transcribing = thinking, error = sad), then the
 *  orchestrator's mood. At rest it is idle whatever the invisible state, as on the overlay: shy's
 *  heat tints the yellow head peach and invisible is the default, so a shy rest face would blush
 *  all the time. Invisible is said by the tooltip instead (trayTip). */
export function trayFace(mood: BlobMood, dictation: DictationState | undefined): BlobFace {
  if (dictation === 'error') return 'sad';
  if (dictation === 'listening' || dictation === 'transcribing') return 'thinking';
  return MOOD_FACE[mood];
}

/** The tray icon's tooltip: says when the Blob is hidden from shares (the invisible setting). */
export function trayTip(invisible: boolean): string {
  return invisible ? 'Guppy - Hidden from shares' : 'Guppy';
}

export type BlobToastKind = 'done' | 'error' | 'info';

/** A toast's face: done = happy, error = sad, anything else = the current mood. */
export function toastFace(kind: BlobToastKind, mood: BlobMood): BlobFace {
  if (kind === 'done') return 'happy';
  if (kind === 'error') return 'sad';
  return MOOD_FACE[mood];
}

/** The face 'Save Blob image' writes: the overlay's face without a ring reaction (dictation, then mood). */
export function currentFace(mood: BlobMood, dictation: DictationState | undefined): BlobFace {
  return (dictation && DICTATION_FACE[dictation]) || MOOD_FACE[mood];
}

/** Square sizes rendered per face: tray (16/20/24/32 = 100-200% DPI), toasts (40-64) and Save (512). */
export const BLOB_TRAY_SIZES = [16, 20, 24, 32] as const;
export const BLOB_TOAST_SIZE = 64;
export const BLOB_SAVE_SIZE = 512;

/** blob:save-image's reply (Settings > Blob 'Save Blob image'). */
export type BlobSaveImageResult = { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; error: string };
