/** The promise-only clipboard surface introduced by Electron 44, kept small so
 * IPC wiring can be tested without an Electron process or a real user clipboard. */
export interface AsyncClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  read(): Promise<ReadonlyArray<{
    types: readonly string[];
    getType(type: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  }>>;
}

export async function copyClipboardText(clipboard: AsyncClipboard, text: unknown): Promise<{ ok: boolean; error?: string }> {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { await clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function readClipboardText(clipboard: AsyncClipboard): Promise<string> {
  try { return await clipboard.readText(); } catch { return ''; }
}

/** Returns the PNG bytes for a clipboard image, or null when the clipboard has none. */
export async function readClipboardPng(clipboard: AsyncClipboard): Promise<ArrayBuffer | null> {
  const item = (await clipboard.read()).find((entry) => entry.types.includes('image/png'));
  if (!item) return null;
  return (await item.getType('image/png')).arrayBuffer();
}
