import type { IDecoration, IDisposable, ILink, IMarker, Terminal } from '@xterm/xterm';
import { VENDORED_FILE_EXTENSIONS, VENDORED_TLDS } from './terminalPathData';

/*! The line/column suffix forms in TERMINAL_PATH_SUFFIX are ported from Visual Studio Code,
 * src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts at commit
 * 6b7ba7ebf1906f2851a1351f63086533ce772b73 (TERM-PATH-EXT-107).
 * Copyright (c) Microsoft Corporation. Licensed under the MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */

/** A scan result is deliberately a plain string range so the recognizer can be
 * tested without a DOM or xterm. All patterns are ASCII-shaped: their offsets
 * therefore also map directly to terminal cells. */
export type TerminalPatternKind = 'path' | 'sha' | 'PASS' | 'FAIL' | 'ERROR' | 'WARN' | 'agent' | 'URL' | 'version';

export interface TerminalPatternMatch {
  kind: TerminalPatternKind;
  start: number;
  end: number;
  text: string;
}

export type TerminalPatternColour = Readonly<{
  light: string;
  dark: string;
  style: 'underline' | 'colour only';
}>;

/**
 * The one, shipped palette for recognisable terminal output. These values are
 * deliberately the exact xterm ANSI/token values used by PtyTerminalView:
 * fixed ANSI colours plus the light/dark `term-yellow` design token. Keep this
 * as the source of truth for both decorations and the published colour artifact.
 */
export const TERMINAL_PATTERN_COLOUR_TABLE = {
  path:    { light: '#2B6CB0', dark: '#6FB3C4', style: 'underline' },
  sha:     { light: '#8A5CF0', dark: '#A896E3', style: 'colour only' },
  PASS:    { light: '#20904B', dark: '#74C096', style: 'colour only' },
  FAIL:    { light: '#D1453B', dark: '#E08C82', style: 'colour only' },
  ERROR:   { light: '#D1453B', dark: '#E08C82', style: 'colour only' },
  WARN:    { light: '#9C6B00', dark: '#CFAA57', style: 'colour only' },
  agent:   { light: '#1F9C94', dark: '#6FB3C4', style: 'colour only' },
  URL:     { light: '#3B7DC4', dark: '#8FC5D1', style: 'underline' },
  version: { light: '#9B72F2', dark: '#C0B3EB', style: 'colour only' }
} as const satisfies Record<TerminalPatternKind, TerminalPatternColour>;

type Palette = Record<string, string | undefined>;
let patternColoringEnabled = true;
const highlighters = new Set<TerminalPatternHighlighter>();

/** Global renderer preference; existing decorations vanish immediately on off.
 * Re-enabling begins at the next pty write rather than walking old scrollback. */
export function setTerminalPatternColoringEnabled(enabled: boolean): void {
  patternColoringEnabled = enabled;
  if (!enabled) for (const highlighter of highlighters) highlighter.reset();
}

/** TERM-PATH-EXT-107: line/column suffix forms ported from VS Code terminalLinkParsing.ts (see the
 * header): foo:339, foo:339:12, foo:339:12-789, foo:339:12-341.789, foo:339.12, foo#339 (and #339:12),
 * foo(339), foo(339,12), foo(339, 12), foo(339:12), foo:(339) and the same with [ ]. Left out on
 * purpose, because they collide with prose: the space-separated forms ('foo 339', 'foo, 339',
 * 'foo (339)'), the quoted '"foo",339' form and the 'line 339, column 12' word forms. */
const TERMINAL_PATH_SUFFIX = String.raw`(?:[:#]\d+(?:[:.]\d+(?:-(?:\d+\.)?\d+)?)?|:?[[(]\d+(?:(?:, ?|:)\d+)?[\])])?`;

const URL_RE = /\bhttps?:\/\/[^\s<>'"`]+/gi;
const WINDOWS_PATH_RE = new RegExp(String.raw`(?<![\w])(?:[A-Za-z]:[\\/](?:[^\r\n<>"|?*]*?\.[A-Za-z][A-Za-z0-9]{0,7}|[^\s<>"|?*]+))` + TERMINAL_PATH_SUFFIX + String.raw`(?=$|[\s),\]}"])`, 'g');
// Requiring a second slash rejects ubiquitous Claude/Codex slash commands such
// as `/clear` while retaining ordinary absolute POSIX file paths.
const POSIX_PATH_RE = new RegExp(String.raw`(?<![\w])(?:\/(?:[^\s:()<>]+\/)+[^\s:()<>]+)` + TERMINAL_PATH_SUFFIX + String.raw`(?=$|[\s),\]}"])`, 'g');
// A sha is a whole word: no letter, digit, underscore or dash on either side (TERM-SHA-WORDBOUND-107),
// so 'claudeeb75033b' never colours its tail. Path separators, spaces, parens and quotes still bound it.
const SHA_RE = /(?<![\w-])(?=[0-9a-f]*[a-f])(?!(?:[a-f]{7})(?![0-9a-f]))[0-9a-f]{7,40}(?![\w-])/gi;
const STATUS_RE = /\b(PASS|FAIL|ERROR|WARN(?:ING)?)\b/gi;
// A full stop straight after a version ends the sentence ('for 1.1.107.'), so it is allowed when
// whitespace or the end of the line follows; '1.1.107.4' is still not a version (TERM-PATH-EXT-107).
const VERSION_RE = /(?<![\w.])v?\d+\.\d+\.\d+(?!\w|\.(?=\S))/gi;

/** Vendored TLDs that are still files when bare (Human decision via god b11dd5: where a TLD clashes
 * with an extension, treat it as a file). Reviewed by hand from the 45 clashes; the rest (ai, info,
 * so, as, ...) stay plain because a domain is the likelier reading. */
export const TERMINAL_PATH_TLD_FILE_CLASHES: ReadonlySet<string> = new Set([
  'cab', 'cc', 'coffee', 'dds', 'fish', 'inc', 'java', 'map', 'md', 'mk', 'ml', 'mm', 'mov', 'pl', 'pm',
  'properties', 'py', 'rs', 'sh', 'sv', 'zip'
]);

/** Extensions the vendored lists lack but Guppy output uses; none is a TLD. */
const TERMINAL_PATH_EXTRA_EXTENSIONS = [
  'asar', 'blockmap', 'env', 'jsonc', 'jsonl', 'lock', 'node', 'out', 'output', 'ps1', 'svelte', 'toml',
  'tsbuildinfo'
];

const VENDORED_TLD_SET: ReadonlySet<string> = new Set(VENDORED_TLDS);

/** TERM-PATH-EXT-107: extensions that make a BARE name (no slash or backslash) a file, e.g.
 * PROTOCOL.md. One constant, built from the vendored text-extensions + binary-extensions lists
 * (terminalPathData.ts) minus every vendored TLD, plus the reviewed clashes and the Guppy extras.
 * A span with a slash or backslash is a path whatever its extension; this set gates bare names only,
 * so github.com / guppyos.com stay plain. Lower case; looked up case-insensitively. */
export const TERMINAL_PATH_EXTENSIONS: ReadonlySet<string> = new Set([
  ...VENDORED_FILE_EXTENSIONS.filter((ext) => !VENDORED_TLD_SET.has(ext) || TERMINAL_PATH_TLD_FILE_CLASHES.has(ext)),
  ...TERMINAL_PATH_EXTRA_EXTENSIONS
]);

/** TERM-PATH-EXT-107 (Human decision): bare names that are never paths although their extension
 * is listed, matched case-insensitively on the whole bare token. A span with a slash or backslash
 * (src/node.js) is still a path. */
export const TERMINAL_PATH_EXCEPTIONS: ReadonlySet<string> = new Set([
  'node.js', 'vue.js', 'next.js', 'nuxt.js', 'react.js', 'express.js', 'three.js', 'chart.js',
  'd3.js', 'deno.js'
]);

// An extension (at least one letter) with an optional :line:col, ending at whitespace, a closing
// bracket or quote, or sentence punctuation that is itself followed by one of those. The span is
// then walked back from the dot to the first whitespace, ( [ { < or quote: the Human's design.
const RELATIVE_PATH_EXT_RE = new RegExp(String.raw`\.(?=\d*[A-Za-z])([A-Za-z0-9]{1,24})` + TERMINAL_PATH_SUFFIX +
  String.raw`(?=$|[\s)\]}>"'\x60]|[.,;:!?]+(?=$|[\s)\]}>"'\x60]))`, 'g');
const PATH_WALK_STOP = /[\s([{<"'`]/;

/** TERM-PATH-EXT-107: the relative/bare path matcher, kept self-contained (with the two sets
 * above) so a better source can replace it. 'taken' spans (drive/POSIX paths, URLs) are never
 * split or coloured twice. */
export function findRelativePaths(text: string, taken: readonly { start: number; end: number }[] = []): TerminalPatternMatch[] {
  const found: TerminalPatternMatch[] = [];
  RELATIVE_PATH_EXT_RE.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = RELATIVE_PATH_EXT_RE.exec(text)) !== null) {
    const dot = hit.index;
    let start = dot;
    while (start > 0 && !PATH_WALK_STOP.test(text[start - 1])) start--;
    if (start === dot) continue; // nothing before the dot: '.md' alone, or 'x .md'
    const end = dot + hit[0].length;
    const span = text.slice(start, end);
    const name = text.slice(start, dot + 1 + hit[1].length);
    if (!/[\\/]/.test(span)) {
      if (!TERMINAL_PATH_EXTENSIONS.has(hit[1].toLowerCase())) continue;
      if (TERMINAL_PATH_EXCEPTIONS.has(name.toLowerCase())) continue;
      if (!/^[\w.-]+$/.test(name)) continue; // a bare file name is one word: not 'x=a.md' or 'a,b.md'
    }
    if (taken.some((m) => start < m.end && end > m.start)) continue;
    found.push({ kind: 'path', start, end, text: span });
  }
  return found;
}

const ERROR_LINE_RE = /\b(?:error|exception|fatal|traceback)\s*(?::|\bat\b)/i;

function addMatches(matches: TerminalPatternMatch[], kind: TerminalPatternKind, re: RegExp, text: string): void {
  re.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text)) !== null) {
    let value = hit[0];
    // Punctuation closes prose URLs; it is not part of the target.
    if (kind === 'URL') value = value.replace(/[.,;:!?)}\]]+$/, '');
    if (value) matches.push({ kind, start: hit.index, end: hit.index + value.length, text: value });
    if (hit[0].length === 0) re.lastIndex++;
  }
}

/** Recognise high-signal output tokens. The painter preserves the first,
 * outermost match where tokens overlap. */
export function findTerminalPatterns(text: string, agentNames: readonly string[] = []): TerminalPatternMatch[] {
  const matches: TerminalPatternMatch[] = [];
  addMatches(matches, 'URL', URL_RE, text);
  addMatches(matches, 'path', WINDOWS_PATH_RE, text);
  addMatches(matches, 'path', POSIX_PATH_RE, text);
  // Drive and POSIX paths (they handle spaces) and URLs keep their own matches.
  matches.push(...findRelativePaths(text, matches.filter((m) => m.kind === 'path' || m.kind === 'URL')));
  addMatches(matches, 'sha', SHA_RE, text);
  STATUS_RE.lastIndex = 0;
  let status: RegExpExecArray | null;
  while ((status = STATUS_RE.exec(text)) !== null) {
    const kind: TerminalPatternKind = status[1].toUpperCase().startsWith('WARN') ? 'WARN' : status[1].toUpperCase() as 'PASS' | 'FAIL' | 'ERROR';
    matches.push({ kind, start: status.index, end: status.index + status[0].length, text: status[0] });
  }
  addMatches(matches, 'version', VERSION_RE, text);
  if (ERROR_LINE_RE.test(text)) matches.push({ kind: 'ERROR', start: 0, end: text.length, text });

  for (const name of agentNames) {
    const clean = name.trim();
    if (!clean) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'g');
    addMatches(matches, 'agent', re, text);
  }
  return matches.sort((a, b) => a.start - b.start || b.end - a.end || a.kind.localeCompare(b.kind));
}

/** Range to inspect after a completed xterm write. The only re-read line is the
 * cursor line (it may have received the end of a token); scrollback before the
 * previous cursor is never revisited. */
export function newlyWrittenLineRange(lastScanned: number, baseY: number, cursorY: number): { start: number; end: number } | null {
  const end = baseY + cursorY;
  if (end < baseY) return null;
  if (lastScanned > end) return { start: baseY, end };
  return { start: Math.max(baseY, lastScanned < baseY ? baseY : lastScanned), end };
}

function isDarkTerminal(palette: Palette): boolean {
  const background = (palette.background ?? '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(background)) return false;
  const value = parseInt(background, 16);
  const red = (value >> 16) & 255, green = (value >> 8) & 255, blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
}

function colourFor(kind: TerminalPatternKind, palette: Palette): string {
  const item = TERMINAL_PATTERN_COLOUR_TABLE[kind];
  return isDarkTerminal(palette) ? item.dark : item.light;
}

type BufferLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>;

function cellsForTextRange(line: BufferLine, start: number, end: number): { start: number; end: number } | null {
  let textOffset = 0;
  let startCell: number | null = null;
  let endCell: number | null = null;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    if (startCell === null && start <= textOffset) startCell = x;
    const width = Math.max(cell.getChars().length, 1);
    textOffset += width;
    if (endCell === null && end <= textOffset) endCell = x + cell.getWidth();
    if (startCell !== null && endCell !== null) return { start: startCell, end: endCell };
  }
  return null;
}

function isDefaultForeground(line: BufferLine, start: number, end: number): boolean {
  if (!line) return false;
  for (let x = start; x < end; x++) {
    const cell = line.getCell(x);
    if (!cell || !cell.isFgDefault()) return false;
  }
  return true;
}

/** Marker-backed decorations are renderer-only paint. No bytes are sent to or
 * rewritten in the pty, so selections, copy and agent parsing retain the exact
 * output that was produced. */
export class TerminalPatternHighlighter {
  // Logical line positions compensate for xterm's scrollback trims, so both
  // signatures and decorations remain associated with their original output.
  private readonly decorations = new Map<IMarker, { decoration: IDecoration; logicalLine: number }>();
  private readonly decorationsByLine = new Map<number, Set<IMarker>>();
  private readonly visibleSignatures = new Map<number, string>();
  private readonly renderSubscription: IDisposable;
  private progressMarker: IMarker | undefined;
  private trimAnchor: IMarker | undefined;
  private trimAnchorLine = -1;
  private trimOffset = 0;
  private agentSignature = '';
  private agentNames: string[] = [];
  private palette: Palette;

  constructor(private readonly term: Terminal, palette: Palette = {}) {
    this.palette = palette;
    this.renderSubscription = term.onRender(({ start, end }) => this.rescanRenderedRows(start, end));
    highlighters.add(this);
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    this.clearDecorations();
    this.visibleSignatures.clear();
    this.rescanRenderedRows(0, this.term.rows - 1);
  }

  reset(): void {
    this.clearDecorations();
    this.visibleSignatures.clear();
    this.progressMarker?.dispose();
    this.progressMarker = undefined;
    this.trimAnchor?.dispose();
    this.trimAnchor = undefined;
    this.trimAnchorLine = -1;
    this.trimOffset = 0;
  }

  dispose(): void { this.reset(); this.renderSubscription.dispose(); highlighters.delete(this); }

  scanNewOutput(agentNames: readonly string[] = []): void {
    const signature = agentNames.join('\u0000');
    if (signature !== this.agentSignature) {
      this.agentSignature = signature;
      this.agentNames = [...agentNames];
    }
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    this.syncTrim(cursorLine);
    const priorLine = this.progressMarker?.line;
    if (!patternColoringEnabled) { this.replaceProgressMarker(); return; }
    // A cursor-up redraw is handled by the small viewport onRender pass. It is
    // never a reason to walk history back to baseY.
    if (priorLine !== undefined && priorLine >= 0 && priorLine > cursorLine) {
      this.replaceProgressMarker();
      return;
    }
    const start = priorLine === undefined || priorLine < buffer.baseY ? buffer.baseY : priorLine;
    for (let y = start; y <= cursorLine; y++) this.scanLine(y, cursorLine);
    this.replaceProgressMarker();
  }

  private scanLine(y: number, cursorLine: number): void {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return;
    this.clearDecorationsForLine(y);
    const text = line?.translateToString(true) ?? '';
    this.rememberVisibleSignature(y, line, text);
    if (!text) return;
    const seen: Array<readonly [number, number]> = [];
    for (const match of findTerminalPatterns(text, this.agentNames)) {
      const cells = cellsForTextRange(line!, match.start, match.end);
      if (!cells || seen.some(([start, end]) => cells.start < end && start < cells.end) || !isDefaultForeground(line!, cells.start, cells.end)) continue;
      seen.push([cells.start, cells.end]);
      const marker = this.term.registerMarker(y - cursorLine);
      if (!marker) continue;
      const decoration = this.term.registerDecoration({
        marker,
        x: cells.start,
        width: cells.end - cells.start,
        foregroundColor: colourFor(match.kind, this.palette),
        layer: 'top'
      });
      if (decoration) {
        if (TERMINAL_PATTERN_COLOUR_TABLE[match.kind].style === 'underline') {
          decoration.onRender((element) => { element.style.textDecoration = 'underline'; });
        }
        this.rememberDecoration(marker, decoration, this.logicalLine(y));
      }
      else marker.dispose();
    }
  }

  private clearDecorations(): void {
    for (const marker of [...this.decorations.keys()]) this.forgetDecoration(marker, true);
  }

  private clearDecorationsForLine(y: number): void {
    for (const marker of [...(this.decorationsByLine.get(this.logicalLine(y)) ?? [])]) this.forgetDecoration(marker, true);
  }

  private rememberDecoration(marker: IMarker, decoration: IDecoration, logicalLine: number): void {
    this.decorations.set(marker, { decoration, logicalLine });
    const markers = this.decorationsByLine.get(logicalLine) ?? new Set<IMarker>();
    markers.add(marker);
    this.decorationsByLine.set(logicalLine, markers);
    marker.onDispose(() => this.forgetDecoration(marker, false));
  }

  private forgetDecoration(marker: IMarker, disposeMarker: boolean): void {
    const record = this.decorations.get(marker);
    if (!record) return;
    this.decorations.delete(marker);
    const markers = this.decorationsByLine.get(record.logicalLine);
    markers?.delete(marker);
    if (markers?.size === 0) this.decorationsByLine.delete(record.logicalLine);
    record.decoration.dispose();
    if (disposeMarker) marker.dispose();
  }

  private replaceProgressMarker(): void {
    this.progressMarker?.dispose();
    this.progressMarker = this.term.registerMarker();
  }

  /** xterm keeps absolute positions stable while growing, but shifts every
   * retained marker when a full scrollback ring trims. A nearby marker tells
   * those two cases apart without visiting historical decorations. */
  private syncTrim(cursorLine: number): void {
    if (this.trimAnchor && this.trimAnchor.line >= 0 && this.trimAnchor.line < this.trimAnchorLine) {
      this.trimOffset += this.trimAnchorLine - this.trimAnchor.line;
      this.trimAnchor.dispose();
      this.trimAnchor = undefined;
    }
    if (!this.trimAnchor || this.trimAnchor.line < 0) {
      this.trimAnchor = this.term.registerMarker();
      this.trimAnchorLine = this.trimAnchor?.line ?? cursorLine;
    }
  }

  private logicalLine(y: number): number { return y + this.trimOffset; }

  private signature(line: BufferLine | undefined, text: string): string {
    if (!line) return '';
    let fg = '';
    for (let x = 0; x < line.length; x++) fg += line.getCell(x)?.isFgDefault() ? '1' : '0';
    return `${text}\u0000${fg}`;
  }

  private rememberVisibleSignature(y: number, line: BufferLine | undefined, text: string): void {
    this.visibleSignatures.set(this.logicalLine(y), this.signature(line, text));
    const maximum = Math.max(1_000, this.term.rows * 4);
    while (this.visibleSignatures.size > maximum) this.visibleSignatures.delete(this.visibleSignatures.keys().next().value!);
  }

  private rescanRenderedRows(start: number, end: number): void {
    if (!patternColoringEnabled) return;
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    this.syncTrim(cursorLine);
    for (let row = start; row <= end; row++) {
      const y = buffer.viewportY + row;
      const line = buffer.getLine(y);
      const text = line?.translateToString(true) ?? '';
      if (!line || this.visibleSignatures.get(this.logicalLine(y)) !== this.signature(line, text)) this.scanLine(y, cursorLine);
    }
  }
}

/** URLs deliberately use the same modifier-click convention as file links: a
 * plain click stays with an interactive terminal UI. */
export function registerTerminalUrlLinkProvider(term: Terminal, openExternal: (url: string) => void): void {
  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      if (!patternColoringEnabled) { callback(undefined); return; }
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      const text = line?.translateToString(true) ?? '';
      const links: ILink[] = [];
      for (const match of findTerminalPatterns(text).filter((item) => item.kind === 'URL')) {
        links.push({
          range: { start: { x: match.start + 1, y: bufferLineNumber }, end: { x: match.end, y: bufferLineNumber } },
          text: match.text,
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => {
            if (event && !(event.metaKey || event.ctrlKey)) return;
            try {
              const url = new URL(match.text);
              if (url.protocol === 'http:' || url.protocol === 'https:') openExternal(url.href);
            } catch { /* terminal output is untrusted; a malformed URL is inert */ }
          }
        });
      }
      callback(links.length ? links : undefined);
    }
  });
}
