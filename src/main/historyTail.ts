/**
 * HISTORY-VIEW-169: a bounded line reader for append-only JSONL transcripts.
 *
 * A Codex rollout reaches 100+ MB (Dwight's reached 132 MB), so nothing here ever reads a
 * file whole:
 *  - BACKWARD from a byte offset (the tail, or an older page), in CHUNK-sized reads, and
 *    only until the caller has enough or the byte budget is spent;
 *  - FORWARD from a byte offset (following growth), with the same budget.
 *
 * The limits, per request:
 *  - `budget`: bytes read before the reader stops at the next line boundary.
 *  - `maxLine`: a line longer than this is SKIPPED, never assembled or parsed (Codex
 *    `compacted` records run to many MB). Skipping still has to find the line's end, so
 *    an oversized line may read up to `skipMax` more before the reader gives up at a
 *    boundary.
 *
 * Offsets are BYTE offsets of line starts. A line is split at 0x0A, which never occurs
 * inside a multi-byte UTF-8 sequence, so each line decodes on its own; a trailing CR
 * (CRLF files) is dropped. An unterminated last line is one still being written: it is
 * never returned, and the window's `end` stops before it, so the next forward read picks
 * it up whole.
 *
 * Growth is detected by SIZE, not mtime: on Windows a Codex rollout's mtime can stay at
 * its creation time while the file grows.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const HISTORY_CHUNK_BYTES = 64 * 1024;
export const HISTORY_BUDGET_BYTES = 4 * 1024 * 1024;
export const HISTORY_MAX_LINE_BYTES = 1024 * 1024;
export const HISTORY_SKIP_MAX_BYTES = 64 * 1024 * 1024;

export interface TailLimits {
  budget?: number;
  maxLine?: number;
  skipMax?: number;
  chunk?: number;
}

export interface LineRef {
  /** Byte offset of the line's first byte. */
  offset: number;
  text: string;
}

export interface ScanResult {
  /** Oldest first. */
  lines: LineRef[];
  /** The window covered, [start, end): both are line boundaries. */
  start: number;
  end: number;
  /** The file's size at the read. */
  size: number;
  /** Lines skipped for exceeding maxLine. */
  skipped: number;
  bytesRead: number;
}

function limitsOf(l: TailLimits = {}): Required<TailLimits> {
  return {
    budget: l.budget ?? HISTORY_BUDGET_BYTES,
    maxLine: l.maxLine ?? HISTORY_MAX_LINE_BYTES,
    skipMax: l.skipMax ?? HISTORY_SKIP_MAX_BYTES,
    chunk: l.chunk ?? HISTORY_CHUNK_BYTES
  };
}

function decode(parts: Buffer[]): string {
  const s = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('utf8');
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/**
 * Read lines BACKWARD from `from` (default: the end of the file). `from` may sit mid-line
 * (the file's unterminated last line): that fragment is not returned, and `end` becomes
 * the boundary before it. `enough(lines)` is asked after each line (newest first) and
 * stops the scan once it says so.
 */
export function readLinesBackward(
  file: string,
  from: number | null,
  enough: (newestFirst: LineRef[]) => boolean,
  limits?: TailLimits
): ScanResult {
  const { budget, maxLine, skipMax, chunk } = limitsOf(limits);
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const top = from === null ? size : Math.max(0, Math.min(from, size));
    const out: LineRef[] = [];
    let skipped = 0;
    let bytesRead = 0;
    let pos = top;
    // The bytes of the line being assembled, AFTER `pos` (latest part last).
    let carry: Buffer[] = [];
    let carryLen = 0;
    let oversized = false;
    // null until the first newline is met: until then we are inside the trailing fragment.
    let end: number | null = null;
    // The start of the oldest line fully handled: the window's start if we stop now.
    let boundary = top;
    let stopped = false;
    const buf = Buffer.alloc(Math.max(1, chunk));

    // A line [lineStart, …) is complete: emit it (or skip it), then decide whether to stop.
    const finishLine = (lineStart: number): boolean => {
      if (end === null) {
        // The fragment after the last newline: never returned; the window ends before it.
        end = lineStart;
      } else if (oversized) {
        skipped += 1;
      } else if (carryLen > 0) {
        const text = decode(carry);
        if (text) out.push({ offset: lineStart, text });
      }
      carry = []; carryLen = 0; oversized = false;
      boundary = lineStart;
      return enough(out) || bytesRead >= budget;
    };

    while (pos > 0 && !stopped) {
      const n = Math.min(buf.length, pos);
      pos -= n;
      readSync(fd, buf, 0, n, pos);
      bytesRead += n;
      let segEnd = n;
      for (let i = n - 1; i >= 0; i -= 1) {
        if (buf[i] !== 0x0a) continue;
        if (!oversized) {
          const piece = buf.subarray(i + 1, segEnd);
          if (piece.length) { carry.unshift(Buffer.from(piece)); carryLen += piece.length; }
          if (carryLen > maxLine) { oversized = true; carry = []; }
        }
        segEnd = i;
        if (finishLine(pos + i + 1)) { stopped = true; break; }
      }
      if (stopped) break;
      if (!oversized) {
        const piece = buf.subarray(0, segEnd);
        if (piece.length) { carry.unshift(Buffer.from(piece)); carryLen += piece.length; }
        if (carryLen > maxLine) { oversized = true; carry = []; }
      } else {
        carryLen += segEnd;
      }
      // Out of budget in the middle of a line: stop at the last boundary, unless this is
      // an oversized line being skipped (it may read up to skipMax more to find its start).
      if (bytesRead >= budget && !(oversized && bytesRead < budget + skipMax)) {
        stopped = true;
      }
    }
    if (!stopped && pos === 0) {
      // Reached the start of the file: what is carried is the first line, complete.
      finishLine(0);
    }
    const windowEnd = end ?? boundary;
    out.reverse();
    return { lines: out, start: Math.min(boundary, windowEnd), end: windowEnd, size, skipped, bytesRead };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read complete lines FORWARD from `after` (a line start). Costs one fstat and no read
 * when the file has not grown past `after`.
 */
export function readLinesForward(file: string, after: number, limits?: TailLimits): ScanResult {
  const { budget, maxLine, skipMax, chunk } = limitsOf(limits);
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const out: LineRef[] = [];
    const startAt = Math.max(0, after);
    if (size <= startAt) return { lines: out, start: startAt, end: startAt, size, skipped: 0, bytesRead: 0 };
    let skipped = 0;
    let bytesRead = 0;
    let pos = startAt;
    let lineStart = startAt;
    let boundary = startAt;
    let carry: Buffer[] = [];
    let carryLen = 0;
    let oversized = false;
    const buf = Buffer.alloc(Math.max(1, chunk));
    let stopped = false;
    while (pos < size && !stopped) {
      const n = Math.min(buf.length, size - pos);
      readSync(fd, buf, 0, n, pos);
      bytesRead += n;
      let segStart = 0;
      for (let i = 0; i < n; i += 1) {
        if (buf[i] !== 0x0a) continue;
        if (!oversized) {
          const piece = buf.subarray(segStart, i);
          if (piece.length) { carry.push(Buffer.from(piece)); carryLen += piece.length; }
          if (carryLen > maxLine) oversized = true;
        }
        if (oversized) skipped += 1;
        else if (carryLen > 0) {
          const text = decode(carry);
          if (text) out.push({ offset: lineStart, text });
        }
        carry = []; carryLen = 0; oversized = false;
        lineStart = pos + i + 1;
        boundary = lineStart;
        segStart = i + 1;
        if (bytesRead >= budget) { stopped = true; break; }
      }
      if (!stopped) {
        if (!oversized) {
          const piece = buf.subarray(segStart, n);
          if (piece.length) { carry.push(Buffer.from(piece)); carryLen += piece.length; }
          if (carryLen > maxLine) { oversized = true; carry = []; }
        }
        if (bytesRead >= budget && !(oversized && bytesRead < budget + skipMax)) stopped = true;
      }
      pos += n;
    }
    // Whatever is carried has no newline yet: still being written. Not returned.
    return { lines: out, start: startAt, end: boundary, size, skipped, bytesRead };
  } finally {
    closeSync(fd);
  }
}
