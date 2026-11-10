import { BLOB_SLOTS, type BlobSlot } from '../../../shared/blob';

/** The overlay window is RING_SIZE square while the ring is open (main/blobOverlay.ts). */
export const RING_BOX = 340;
export const RING_RADIUS = 118;

/** Clockwise from the top, as in the reference ring. */
export const RING_SLOTS: readonly BlobSlot[] = BLOB_SLOTS;

/** Centre of a slot's button inside the ring box (px). */
export function ringSlotPosition(slot: BlobSlot): { x: number; y: number } {
  const i = RING_SLOTS.indexOf(slot);
  const angle = (-90 + i * (360 / RING_SLOTS.length)) * (Math.PI / 180);
  const c = RING_BOX / 2;
  return { x: Math.round(c + RING_RADIUS * Math.cos(angle)), y: Math.round(c + RING_RADIUS * Math.sin(angle)) };
}
