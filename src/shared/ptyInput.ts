/**
 * Input that crosses the renderer-to-main PTY boundary.  Normal terminal data is
 * text; xterm's `onBinary` is a byte string (one 0..255 code unit per byte).
 * Keep that second form as bytes so IPC and node-pty never UTF-8 re-encode it.
 */
export type PtyInput = string | Uint8Array;

/** Convert xterm's binary-string callback payload into its exact octets. */
export function binaryStringToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i);
  return bytes;
}

/** IPC must accept only the two forms the preload can send. */
export function isPtyInput(value: unknown): value is PtyInput {
  return typeof value === 'string' || value instanceof Uint8Array;
}
