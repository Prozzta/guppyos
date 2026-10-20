/** Turn xterm's binary callback string into the representation node-pty needs.
 *
 * POSIX PTYs pass bytes through, so xterm code units map directly to latin-1
 * bytes.  ConPTY decodes its input pipe as UTF-8: a raw 0x85 is discarded as
 * invalid, while a JS string is encoded as c2 85 and decoded by UTF-8 terminal
 * children back to U+0085 (the X10 coordinate).  ConPTY also consumes legacy
 * ESC[M itself, so this does not make X10 clicks usable on Windows; SGR 1006
 * stays on xterm's onData path when the terminal application enables it.
 */
export function ptyBinaryInput(data: string, platform: NodeJS.Platform = process.platform): string | Buffer {
  return platform === 'win32' ? data : Buffer.from(data, 'latin1');
}
