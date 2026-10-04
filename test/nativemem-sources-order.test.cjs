'use strict';
/**
 * NATIVEMEM-SOURCES-LOCALE-SORT (Creed, CL-W8-STREAM-ORDER audit). An agent's `.md` sources, and the
 * wake-up's rooms, were ordered with localeCompare: ICU puts `alpha_notes` before `alpha-notes` and
 * `alpha` before `Zeta` (case-insensitive first), and that depends on the machine's locale and Node
 * build. They are now ordinal (UTF-16 code units, as `.sort()`), the same everywhere, with the
 * intended `memory-archive-*.md` before `memory.md`. File names are invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { discoverSources, ordinal } = loadTs('src/main/nativeMemory/sources.ts');
const { formatWakeUp } = loadTs('src/main/nativeMemory/format.ts');

test('an agent\'s .md sources come out in ordinal order: case and - before _ as code units, archives before memory.md', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'agents', 'a1');
  fs.mkdirSync(dir, { recursive: true });
  // notes_b / notesa (Jim): NTFS lists by UPPER-case collation ('_' 0x5F after 'A'), the case-folded
  // ordinal puts '_' before 'a': so the explicit sort, not the filesystem, decides.
  const names = ['memory.md', 'b.md', 'alpha_notes.md', 'Zeta-REPORT.md', 'memory-archive-2026-09-27.md', 'alpha-notes.md', 'memory-archive-2026-10-03.md', 'notesa.md', 'notes_b.md'];
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'invented\n');
  const d = discoverSources(root, { topLevel: [], include: {} });
  assert.deepEqual(d.eligible.map((e) => path.basename(e.path)), [
    'alpha-notes.md',                  // '-' (0x2D) before '_' (0x5F), whatever the locale
    'alpha_notes.md',
    'b.md',
    'memory-archive-2026-09-27.md',    // archives, oldest first...
    'memory-archive-2026-10-03.md',
    'memory.md',                       // ...then the live memory ('-' < '.')
    'notes_b.md',                      // '_' (0x5F) before 'a' (0x61), unlike NTFS's own listing
    'notesa.md',
    'Zeta-REPORT.md'                   // case-folded: z after m (Jim S1)
  ]);
  // Jim S1: an upper-case MEMORY.md (still the memory room) stays after its archives.
  const d2 = path.join(root, 'agents', 'a2');
  fs.mkdirSync(d2, { recursive: true });
  for (const n of ['MEMORY.md', 'Memory-Archive-2026-09-27.md', 'memory-archive-2026-10-03.md']) fs.writeFileSync(path.join(d2, n), 'invented\n');
  const a2 = discoverSources(root, { topLevel: [], include: {} }).eligible.filter((e) => e.wing === 'a2');
  assert.deepEqual(a2.map((e) => [path.basename(e.path), e.kind]), [['Memory-Archive-2026-09-27.md', 'deliverable'], ['memory-archive-2026-10-03.md', 'deliverable'], ['MEMORY.md', 'memory']]);
});

test('ordinal: case-folded code units first, raw code units as the tie-break', () => {
  assert.deepEqual(['b', 'B', 'a_', 'a-', 'a', 'Zeta', 'alpha'].sort(ordinal), ['a', 'a-', 'a_', 'alpha', 'B', 'b', 'Zeta']);
  assert.equal(ordinal('x', 'x'), 0);
});

test('wake-up rooms: memory first, then ordinal (notes-x before notes_x)', () => {
  const e = (room) => ({ wing: 'a1', room, source: `agents/a1/${room}.md`, content: `invented ${room}` });
  const text = formatWakeUp(null, [e('notes_x'), e('notes-x'), e('memory'), e('b')]);
  const order = [...text.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['memory', 'b', 'notes-x', 'notes_x']);
});
