'use strict';

/**
 * MAIN-SYNC-LOG-LEDGER (config), found by the widened mutation scan after Jim's FAIL on the tasks
 * cache: readConfig() serves a cached value up to CONFIG_REVALIDATE_MS (1 s) old, and every
 * read-modify-write of config.json outside config.ts built its patch on it (the voice schedules,
 * the scheduler's lastFiredAt stamps, the boot migrations, webhooks, codex opt-ins, integrations,
 * triggers, the term hold...). A change another process made inside that window was lost. Those
 * bases now come from readConfigForWrite(), which skips the window (the stat decides), and the
 * voice schedules write through deps.editMissions, which applies the edit to that fresh read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-write-base-'));
const handlers = {};
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } }
};
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { readConfig, readConfigForWrite, writeConfig, __resetConfigCacheForTests } = loadTs('src/main/config.ts');
const RA = loadTs('src/main/realtimeActions.ts');
const file = path.join(userData, 'config.json');
const MIGRATED = { triggersMigratedV1: true, defaultModelCliMigratedV1: true };

const clock = 1_000_000;
const handEdit = (obj) => fs.writeFileSync(file, JSON.stringify({ ...MIGRATED, onboardingComplete: true, ...obj }), 'utf8');
// The window clock stands still (every read below is inside one window); the racy wall is a
// minute ahead, so the files just written count as old (proven) writes and the cache serves them.
const start = (obj) => { handEdit(obj); __resetConfigCacheForTests(() => clock, () => Date.now() + 60_000); readConfig(); };
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).missions.map((m) => `${m.id}:${m.enabled}:${m.lastFiredAt ?? '-'}`);
const mission = (id, extra = {}) => ({ id, label: `${id} label`, intervalMs: 3_600_000, to: 'god', body: 'b', enabled: true, ...extra });

// The same wiring as index.ts.
RA.registerRealtimeActionIpc({
  hiveEnabled: () => true,
  hiveRegistry: () => ({ agents: {} }),
  hiveLog: () => {},
  listMissions: () => readConfig().missions ?? [],
  editMissions: (edit) => { writeConfig({ missions: edit(readConfigForWrite().missions ?? []) }); }
});
const say = (verb, args) => handlers['realtime:action'](null, { verb, ...args });
const confirm = () => handlers['realtime:action:confirm'](null, { phrase: 'confirm' });

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('readConfigForWrite reads through the window; readConfig keeps serving the cache', () => {
  start({ missions: [mission('A')] });
  handEdit({ missions: [mission('A'), mission('B')] });
  assert.deepEqual(readConfig().missions.map((m) => m.id), ['A'], 'control: the cache still serves the old list');
  assert.deepEqual(readConfigForWrite().missions.map((m) => m.id), ['A', 'B']);
});

test('a voice create_schedule keeps a mission another writer added inside the window', async () => {
  start({ missions: [mission('A')] });
  handEdit({ missions: [mission('A'), mission('B')] });
  const p = await say('create_schedule', { label: 'Nightly', prompt: 'run the sweep', intervalMinutes: 30 });
  assert.equal(p.needsConfirm, true, p.spoken);
  const r = await confirm();
  assert.equal(r.ok, true, r.spoken);
  const ids = onDisk();
  assert.deepEqual(ids.slice(0, 2), ['A:true:-', 'B:true:-']);
  assert.match(ids[2], /^voice-nightly-.*:true:-$/);
});

test('a voice edit_schedule keeps a scheduler stamp and a mission written inside the window', async () => {
  start({ missions: [mission('A'), mission('C')] });
  handEdit({ missions: [mission('A', { lastFiredAt: 123 }), mission('C'), mission('B')] });
  const p = await say('edit_schedule', { label: 'A label', action: 'disable' });
  assert.equal(p.needsConfirm, true, p.spoken);
  assert.equal((await confirm()).ok, true);
  assert.deepEqual(onDisk(), ['A:false:123', 'C:true:-', 'B:true:-']);
  start({ missions: [mission('A'), mission('C')] });
  handEdit({ missions: [mission('A'), mission('C'), mission('B')] });
  await say('edit_schedule', { label: 'C label', action: 'delete' });
  assert.equal((await confirm()).ok, true);
  assert.deepEqual(onDisk(), ['A:true:-', 'B:true:-']);
});

// Every read-modify-write base in main, by its verbatim line (a census: each must be present).
const BASES = {
  'src/main/index.ts': [
    ['scheduler stamp (gate)', 1, '              const current = readConfigForWrite().missions ?? [];'],
    ['scheduler stamp (no gate)', 1, '          const current = readConfigForWrite().missions ?? [];'],
    ['ops standup seed', 1, '  const cfg = readConfigForWrite();'],
    ['heartbeat retire', 1, '  const cfg2 = readConfigForWrite();'],
    ['delta gate seed', 1, '  const cfgGate = readConfigForWrite();'],
    ['compact maintenance retire', 1, '  const cfg3 = readConfigForWrite();'],
    ['autoCompact strip', 1, '  const cfg4 = readConfigForWrite();'],
    ['project theme', 1, '  const current = readConfigForWrite(), home = current.harnessHome;'],
    ['home change maps', 1, '  const maps = applyProjectHomeChange(readConfigForWrite(), {'],
    ['codex opt-in allow', 1, '  const cur = readConfigForWrite().codexLayerOptIns ?? [];'],
    ['codex opt-in revoke', 1, '  writeConfig({ codexLayerOptIns: (readConfigForWrite().codexLayerOptIns ?? []).filter('],
    ['auto-delivery pause', 1, '  const current = new Set(readConfigForWrite().autoDeliveryPausedAgents ?? []);'],
    ['missions:save merge', 1, '    (readConfigForWrite().missions ?? []).map((m) => [m.id, m] as const)'],
    ['context trigger', 1, '  const current = readConfigForWrite().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;'],
    ['webhooks:save', 1, '  const existing = readConfigForWrite().webhookTriggers ?? [];'],
    ['webhooks:delete', 1, '  const list = (readConfigForWrite().webhookTriggers ?? []).filter((t) => t.id !== id);'],
    ['org trigger', 1, '  const current = readConfigForWrite().orgTrigger ?? DEFAULT_ORG_TRIGGER;'],
    ['legacy webhook', 1, '  const list = readConfigForWrite().webhookTriggers ?? [];'],
    ['voice schedules', 1, '  editMissions: (edit) => { writeConfig({ missions: edit(readConfigForWrite().missions ?? []) }); },'],
    ['term hold', 1, '  floorHold: { get: () => parseFloorHold(readConfigForWrite().floorHold), set: (h) => { writeConfig({ floorHold: h }); } },']
  ],
  'src/main/integrations.ts': [
    ['integration upsert', 1, '  const current = readConfigForWrite().integrations ?? [];'],
    ['integration remove', 1, '  const next = (readConfigForWrite().integrations ?? []).filter((r) => r.id !== id);']
  ]
};
test('every read-modify-write of config.json in main builds on readConfigForWrite (census)', () => {
  for (const [rel, rows] of Object.entries(BASES)) {
    const src = readSource(rel).replace(/\r\n/g, '\n');
    // Each anchor carries its indentation, so the two scheduler stamps stay apart.
    const lines = src.split('\n');
    for (const [what, n, line] of rows) assert.equal(lines.filter((l) => l.startsWith(line)).length, n, `${rel}: ${what}`);
  }
});

// The rule for new code: a writeConfig() whose block reads readConfig() above it must be one of the
// read-only uses below (a scalar decision, a compare, a deps read), never a base.
const READ_ONLY = [
  /savedLevel: \(\) => readConfig\(\)\.claimLedger,/,
  /readMission: \(\) => \(readConfig\(\)\.missions/,
  /^const cfg = readConfig\(\);$/, // changeHome recovery: restarts the slack server, writes nothing
  /^const previousBindAllInterfaces = readConfig\(\)\.inboundBindAllInterfaces === true;$/,
  /^listMissions: \(\) => readConfig\(\)\.missions \?\? \[\],$/,
  /^getConfigValue: \(key\) => \(readConfig\(\)/,
  /^if \(readConfig\(\)\.realtimeVoiceEnabled\) writeConfig\(\{ realtimeVoiceEnabled: false \}\);$/,
  /^const cfgHome = readConfig\(\)\.harnessHome \?\? '';$/
];
test('no writeConfig() in main builds on the cached readConfig() (the rule for new code)', () => {
  const bad = [];
  for (const rel of Object.keys(BASES)) {
    const lines = readSource(rel).split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/\bwriteConfig\(/.test(l)) return;
      for (let j = i; j >= Math.max(0, i - 30); j--) {
        const t = lines[j];
        if (/\breadConfig\(\)/.test(t) && !READ_ONLY.some((re) => re.test(t.trim()))) bad.push(`${rel}:${j + 1} (for the write at ${i + 1}): ${t.trim()}`);
        if (j < i && /^(ipcMain\.handle|function |export function |async function |const \w+ = \(|\}\);?$|\};?$)/.test(t)) break;
      }
    });
  }
  assert.deepEqual(bad, []);
});
