'use strict';
/**
 * The agent card's NAME outranks its badges (MunderDev 97bda465 + c6b98de9, TES-GUPPY-PORT-PLAN
 * step 7). At the 220px card the god row (rename pencil + BOSS + a status chip like "working")
 * left the name ~17px: "M…" for MICHAEL, "CPT …" for CPT KERK; a worker beside "compacting"
 * showed "JAC…". The chip collapses to its colour dot (label in the tooltip and aria-label)
 * whenever the name would otherwise show fewer than 8 glyphs, or fewer than it has.
 *
 * Layout needs a real browser: the rendered part runs the REAL AgentCard in the hidden-window
 * harness (scenarios/agentcard-name-fit.tsx); upstream used its bug-14 fixture, which Guppy has
 * not. Guppy's badges (task chip, mail, impact) and its impact-aware status label are kept.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const REPO = path.resolve(__dirname, '..');
const card = fs.readFileSync(path.join(REPO, 'src/renderer/src/components/AgentCard.tsx'), 'utf8');

test('source: the name has a tooltip and the status chip can fall back to its dot', () => {
  assert.match(card, /<span title=\{name\} style=\{\{/, 'the plain name carries the full name as a title');
  assert.match(card, /label="" style=\{\{ flexShrink: 0, padding: '5px 6px' \}\}/);
  assert.match(card, /<span role="img" title=\{badgeLabel\} aria-label=\{badgeLabel\}/, 'the dot is a labelled image to assistive tech');
  // Guppy: the label is the impact-aware chip's (a held agent's verb), and the full chip keeps it.
  assert.match(card, /const badgeLabel = badgeText\(held\.status, held\.label\);/);
  assert.match(card, /<PixelBadge status=\{held\.status\} label=\{held\.label\} style=\{\{ flexShrink: 0 \}\} \/>/);
  assert.match(card, /title=\{taskChipTitle\(doingCount, taskFlags\)\}/, 'the task chip stays');
  assert.match(card, /title=\{mailBadgeTitle\(inboxBacklog\)\}/, 'the mail badge stays');
});

test('rendered: every card name shows at least 8 glyphs (or all of a shorter one)', { timeout: harnessTestTimeout(90_000) }, async () => {
  const r = await runScenario(path.join(__dirname, 'electron-harness', 'scenarios', 'agentcard-name-fit.tsx'), { timeoutMs: 90_000 });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.font, 'the display face loaded (else glyph widths mean nothing)');
  for (const [id, m] of Object.entries(r.atMount)) assert.equal(m.dot, null, `${id}: under the 4px stand-in every name fits, so no dot at mount`);
  const ids = Object.keys(r.cases);
  assert.equal(ids.length, 8);
  // Only the fonts 'loadingdone' re-measure can have dotted godMichael (checked below).
  for (const [when, set] of [['after font load', r.cases], ['after a status change', r.after]]) {
    for (const id of ids) {
      const m = set[id], name = { godMichael: 'Michael', godCptKerk: 'Cpt Kerk', godLong: 'Michael Gary Scott', godPlain: 'Cpt Kerk',
        worker: 'Scetty', worker8: 'Jackov12', workerLong: 'McCey the engineer', goesBusy: 'Jackov12' }[id];
      assert.ok(m.found, `${id} ${when}: name element`);
      const glyphs = m.full > m.client ? Math.floor((m.client - m.glyph) / m.glyph) : name.length; // an ellipsis costs one
      assert.ok(glyphs >= Math.min(8, name.length), `${id} ${when}: "${name}" shows ${glyphs} glyphs (${m.client}/${m.full}px)`);
      assert.ok(m.titled, `${id} ${when}: the full name is in a title`);
      if (m.dot) assert.ok(m.dot.title && m.dot.aria === m.dot.title, `${id} ${when}: the dot carries its label as title + aria-label`);
    }
  }
  assert.ok(r.cases.worker.badgeText && !r.cases.worker.dot, 'a name that fits keeps the full status chip');
  assert.ok(!r.cases.godMichael.badgeText && r.cases.godMichael.dot, 'god\'s chip drops to its (role="img") dot for the name');
  assert.equal(r.cases.godMichael.dot.title, 'working');
  assert.ok(r.cases.goesBusy.badgeText && !r.cases.goesBusy.dot, 'Jackov12 fits beside "idle" and keeps the chip');
  assert.ok(!r.after.goesBusy.badgeText && r.after.goesBusy.dot, 'going idle -> compacting re-measures and drops to the dot');
  assert.equal(r.after.goesBusy.dot.title, 'compacting');
});
