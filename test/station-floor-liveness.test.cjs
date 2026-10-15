'use strict';

// PANEL-WORKING-COLOUR-186: the TES floor must use the same display-status projection as the
// office floor. A long tool can leave the hook-driven status at idle while liveness knows it is
// BUSY_PROGRESSING; crew.sync needs the projected status so the avatar takes its working seat.

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const ACTIVITY = loadTs('src/shared/activityView.ts');
const STATION_FLOOR = 'src/renderer/src/scene/themes/StationFloor.tsx';

function stationCrewAgents() {
  const source = readSource(STATION_FLOOR);
  const file = ts.createSourceFile(STATION_FLOOR, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'crewAgents');
  assert.ok(declaration, 'StationFloor defines the crew projection');
  const output = ts.transpileModule(`${declaration.getText(file)}\nmodule.exports = crewAgents;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const mod = { exports: {} };
  new Function('activityStatus', 'presetIdOf', 'module', 'exports', output)(
    ACTIVITY.activityStatus,
    () => 'worker',
    mod,
    mod.exports
  );
  return mod.exports;
}

const busyLiveness = {
  v: 1, agentId: 'andy', incarnation: 1, lifecycle: 'LIVE', classification: 'BUSY_PROGRESSING',
  classifiedSince: Date.parse('2026-10-15T05:00:00.000Z'), reason: 'turn-started', evidence: { sampledAt: Date.parse('2026-10-15T05:00:00.000Z') }
};

test('TES projects an idle agent with LIVE BUSY_PROGRESSING liveness to crew working', () => {
  const crewAgents = stationCrewAgents();
  const crew = crewAgents(
    { manifest: { builder: 'tes', id: 'tes' } },
    [{ id: 'andy', status: 'idle', isGod: false }],
    { andy: busyLiveness }
  );
  assert.equal(crew[0].status, 'working', 'the crew receives the displayed working status and seats the avatar');
});

test('TES synchronises when only the liveness record changes', () => {
  const source = readSource(STATION_FLOOR);
  assert.match(source, /const \{ agents, liveness \} = useStore\.getState\(\);\s*crew\.sync\(crewAgents\(pack, agents, liveness\)\);/,
    'every crew sync receives the current liveness snapshot');
  assert.match(source, /if \(s\.agents !== prev\.agents \|\| s\.liveness !== prev\.liveness\) sync\(\);/,
    'a new liveness object invokes that sync even when the agents array is unchanged');
});
