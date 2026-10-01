'use strict';
/**
 * liveness-v1 contract, type level (C:/Dunder/_work/creed-177/LIVENESS-V1.md). Self-contained, no
 * framework: `node test/liveness-v1-contract.test.cjs`.
 *
 * src/shared/livenessV1.ts is the ONE definition the producer (AgentLivenessMonitor) and the
 * consumers (ZT-I3 boardMonitor/floorDigest, the UI) import. This test type-checks fixtures against
 * it with the bundled `typescript` compiler (strict, in memory, no emit):
 *   - the positive fixtures (one per classification and lifecycle, every evidence field) compile;
 *   - each negative fixture fails with a type error (a dropped field, a value outside a union, a
 *     missing required field);
 *   - the unions are pinned EXACTLY (both directions), so adding or removing a member fails;
 *   - the runtime export LIVENESS_REASON_OPERATOR_HOLD is the literal 'operator-hold'.
 * The producer-side half of the contract (archiveReason present iff ARCHIVED; classifiedSince
 * unchanged across same-class samples) is behaviour and is pinned by the monitor's own tests.
 *
 * Named mutants (applied to the source text in memory; each must make this test fail):
 *   M1 archiveReason-dropped        the archiveReason field is removed from LivenessV1
 *   M2 classification-RUNNING       'RUNNING' is added to LivenessClassification
 *   M3 lifecycle-member-dropped     'DELETED' is removed from LivenessLifecycle
 *   M4 archive-reason-widened       ArchiveReason gains 'manual'
 *   M5 operator-hold-renamed        the reserved reason constant becomes 'hold'
 *   M6 evidence-field-dropped       evidence.lastTurnEndAt is removed
 *   M7 required-made-optional       incarnation becomes optional
 *   M8 dropped-field-readded        a `process` field (dropped by the spec) is added back
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC_PATH = path.join(__dirname, '..', 'src', 'shared', 'livenessV1.ts');
const SOURCE = fs.readFileSync(SRC_PATH, 'utf8');

const COMPILER_OPTIONS = {
  strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noLib: false,
  exactOptionalPropertyTypes: false, types: []
};

// Exact type equality: fails to compile unless A and B are mutually assignable, member for member.
const EQ = 'type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\n'
  + 'const assertTrue = <T extends true>(): T => (true as T);\n';

const POSITIVE = `import {
  LIVENESS_REASON_OPERATOR_HOLD,
  type LivenessV1, type LivenessClassification, type LivenessLifecycle, type LivenessArchiveReason
} from './livenessV1';
${EQ}
assertTrue<Eq<LivenessClassification,
  'BUSY_PROGRESSING' | 'IDLE' | 'SUSPECT' | 'STUCK_WAKE' | 'CRASHED' | 'EXITED' | 'UNKNOWN'>>();
assertTrue<Eq<LivenessLifecycle, 'LIVE' | 'ARCHIVED' | 'DELETED'>>();
assertTrue<Eq<LivenessArchiveReason, 'explicit' | 'orphan' | 'pty-exit'>>();
assertTrue<Eq<typeof LIVENESS_REASON_OPERATOR_HOLD, 'operator-hold'>>();
assertTrue<Eq<keyof LivenessV1,
  'agentId' | 'incarnation' | 'lifecycle' | 'archivedAt' | 'archiveReason' | 'classification'
  | 'classifiedSince' | 'reason' | 'evidence'>>();
assertTrue<Eq<keyof LivenessV1['evidence'],
  'sampledAt' | 'lastPtyTrafficAt' | 'lastHookAt' | 'lastRolloutStartedAt' | 'lastRolloutCompleteAt'
  | 'lastTurnEndAt' | 'lastWakeRefusalAt' | 'wakeRefusalSince' | 'processExitAt' | 'exitCode'>>();
// Required vs optional is part of the contract.
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
assertTrue<Eq<RequiredKeys<LivenessV1>,
  'agentId' | 'incarnation' | 'lifecycle' | 'classification' | 'classifiedSince' | 'reason' | 'evidence'>>();
assertTrue<Eq<RequiredKeys<LivenessV1['evidence']>, 'sampledAt'>>();
assertTrue<Eq<LivenessV1['evidence']['exitCode'], number | null | undefined>>();
assertTrue<Eq<LivenessV1['reason'], string>>();

const classes: LivenessClassification[] =
  ['BUSY_PROGRESSING', 'IDLE', 'SUSPECT', 'STUCK_WAKE', 'CRASHED', 'EXITED', 'UNKNOWN'];
export const live: LivenessV1[] = classes.map((classification, i) => ({
  agentId: 'andy-mtuk4y4x', incarnation: 'pty-' + i, lifecycle: 'LIVE', classification,
  classifiedSince: 1000 + i, reason: 'fixture', evidence: { sampledAt: 2000 + i }
}));
export const archived: LivenessV1[] = (['explicit', 'orphan', 'pty-exit'] as const).map((archiveReason) => ({
  agentId: 'jim-mtujpe28', incarnation: 'pty-9', lifecycle: 'ARCHIVED', archivedAt: 5000, archiveReason,
  classification: 'EXITED', classifiedSince: 5000, reason: 'archived', evidence: { sampledAt: 5001 }
}));
export const deleted: LivenessV1 = {
  agentId: 'x', incarnation: 'pty-1', lifecycle: 'DELETED', classification: 'UNKNOWN',
  classifiedSince: 1, reason: 'deleted', evidence: { sampledAt: 2 }
};
export const hold: LivenessV1 = {
  agentId: 'x', incarnation: 'pty-1', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1,
  reason: LIVENESS_REASON_OPERATOR_HOLD, evidence: { sampledAt: 2 }
};
export const full: LivenessV1 = {
  agentId: 'x', incarnation: 'pty-2', lifecycle: 'LIVE', classification: 'CRASHED', classifiedSince: 1,
  reason: 'pty-exit-nonzero',
  evidence: {
    sampledAt: 10, lastPtyTrafficAt: 1, lastHookAt: 2, lastRolloutStartedAt: 3, lastRolloutCompleteAt: 4,
    lastTurnEndAt: 5, lastWakeRefusalAt: 6, wakeRefusalSince: 7, processExitAt: 8, exitCode: 3
  }
};
export const nullExit: LivenessV1 = { ...full, evidence: { sampledAt: 11, processExitAt: 9, exitCode: null } };
`;

const BASE = `{ agentId: 'x', incarnation: 'p', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: { sampledAt: 2 } }`;
// Each must produce at least one diagnostic.
const NEGATIVE = {
  'classification RUNNING is not a value': `const v: LivenessV1 = { ...${BASE}, classification: 'RUNNING' };`,
  'lifecycle RUNNING is not a value': `const v: LivenessV1 = { ...${BASE}, lifecycle: 'RUNNING' };`,
  'archiveReason outside the registry union': `const v: LivenessV1 = { ...${BASE}, lifecycle: 'ARCHIVED', archiveReason: 'manual' };`,
  'dropped field process': `const v: LivenessV1 = { agentId: 'x', incarnation: 'p', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: { sampledAt: 2 }, process: 'running' };`,
  'dropped field pendingWake': `const v: LivenessV1 = { agentId: 'x', incarnation: 'p', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: { sampledAt: 2 }, pendingWake: true };`,
  'dropped field nextCheckAt': `const v: LivenessV1 = { agentId: 'x', incarnation: 'p', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: { sampledAt: 2 }, nextCheckAt: 3 };`,
  'dropped evidence lastTaskCompleteAt': `const v: LivenessV1 = { agentId: 'x', incarnation: 'p', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: { sampledAt: 2, lastTaskCompleteAt: 3 } };`,
  'evidence.sampledAt is required': `const v: LivenessV1 = { agentId: 'x', incarnation: 'p', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: {} };`,
  'incarnation is required': `const v: LivenessV1 = { agentId: 'x', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 1, reason: 'r', evidence: { sampledAt: 2 } };`,
  'classifiedSince is a number': `const v: LivenessV1 = { ...${BASE}, classifiedSince: '1' };`,
  'exitCode is number or null, not string': `const v: LivenessV1 = { ...${BASE}, evidence: { sampledAt: 1, exitCode: '0' } };`
};

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-v1-'));
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;

// Type-checks each fixture against source in ONE program (all written to a fresh temp dir) and
// returns the diagnostics per fixture name. Throws if a fixture cannot even resolve the module, so a
// negative fixture or a mutant can never "fail" for that reason.
function check(source, fixtures) {
  const dir = path.join(WORK, String(seq++));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'livenessV1.ts'), source, 'utf8');
  const names = Object.keys(fixtures);
  const fileOf = (i) => path.join(dir, `fixture${i}.ts`);
  names.forEach((n, i) => fs.writeFileSync(fileOf(i), fixtures[n], 'utf8'));
  const program = ts.createProgram(names.map((_, i) => fileOf(i)), COMPILER_OPTIONS);
  const out = {};
  names.forEach((n, i) => {
    const sf = program.getSourceFile(fileOf(i));
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    const unresolved = diags.filter((d) => d.code === 2307 || d.code === 2305);
    if (unresolved.length) throw new Error(`harness (${n}): ` + ts.flattenDiagnosticMessageText(unresolved[0].messageText, '\n'));
    out[n] = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  });
  const global = program.getGlobalDiagnostics().concat(program.getSemanticDiagnostics(program.getSourceFile(path.join(dir, 'livenessV1.ts'))));
  if (global.length) out['livenessV1.ts itself'] = global.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  return out;
}

const negFixture = (body) => `import { type LivenessV1 } from './livenessV1';\n${body}\nexport {};\n`;

// The whole contract against a given source text; returns the list of broken clauses.
function contractViolations(source) {
  const broken = [];
  const fixtures = { positive: POSITIVE };
  for (const [name, body] of Object.entries(NEGATIVE)) fixtures['neg: ' + name] = negFixture(body);
  const res = check(source, fixtures);
  if (res.positive.length) broken.push('positive fixtures: ' + res.positive.join(' | '));
  if (res['livenessV1.ts itself']) broken.push('livenessV1.ts itself: ' + res['livenessV1.ts itself'].join(' | '));
  for (const name of Object.keys(NEGATIVE)) {
    if (res['neg: ' + name].length === 0) broken.push('negative accepted: ' + name);
  }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  if (mod.exports.LIVENESS_REASON_OPERATOR_HOLD !== 'operator-hold') broken.push('runtime operator-hold constant');
  const runtimeKeys = Object.keys(mod.exports).sort().join(',');
  if (runtimeKeys !== 'LIVENESS_REASON_OPERATOR_HOLD') broken.push('runtime exports: ' + runtimeKeys);
  return broken;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('liveness-v1 contract (type level)');

test('the fixture harness sees type errors at all (a bad fixture is rejected)', () => {
  assert.ok(check(SOURCE, { bad: negFixture(`const n: number = 'not a number';`) }).bad.length > 0);
});

test('src/shared/livenessV1.ts satisfies the whole contract', () => {
  assert.deepStrictEqual(contractViolations(SOURCE), []);
});

test('the file is the single definition: it imports nothing', () => {
  assert.ok(!/^\s*import\b/m.test(SOURCE) && !/\brequire\(/.test(SOURCE), 'livenessV1.ts must be dependency-free');
});

test('ArchiveReason mirrors the registry (src/main/hive.ts)', () => {
  const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const m = /export type ArchiveReason = ([^;]+);/.exec(hive);
  assert.ok(m, 'hive.ts declares ArchiveReason');
  const mine = /export type LivenessArchiveReason = ([^;]+);/.exec(SOURCE);
  assert.ok(mine, 'livenessV1.ts declares LivenessArchiveReason');
  const set = (s) => s.split('|').map((x) => x.trim()).sort().join('|');
  assert.strictEqual(set(mine[1]), set(m[1]));
});

const MUTANTS = {
  'M1 archiveReason-dropped': [/^\s*archiveReason\?: LivenessArchiveReason;.*$/m, ''],
  'M2 classification-RUNNING': ["| 'CRASHED' | 'EXITED' | 'UNKNOWN';", "| 'CRASHED' | 'EXITED' | 'UNKNOWN' | 'RUNNING';"],
  'M3 lifecycle-member-dropped': ["'LIVE' | 'ARCHIVED' | 'DELETED'", "'LIVE' | 'ARCHIVED'"],
  'M4 archive-reason-widened': ["'explicit' | 'orphan' | 'pty-exit';", "'explicit' | 'orphan' | 'pty-exit' | 'manual';"],
  'M5 operator-hold-renamed': ["= 'operator-hold' as const", "= 'hold' as const"],
  'M6 evidence-field-dropped': [/^\s*lastTurnEndAt\?: number;.*$/m, ''],
  'M7 required-made-optional': ['incarnation: string;', 'incarnation?: string;'],
  'M8 dropped-field-readded': ['  agentId: string;', "  agentId: string;\n  process?: 'running' | 'exited';"]
};

for (const [name, [from, to]] of Object.entries(MUTANTS)) {
  test(`mutant ${name} dies`, () => {
    const mutated = SOURCE.replace(from, to);
    assert.notStrictEqual(mutated, SOURCE, 'the mutant must apply to the current source');
    assert.ok(contractViolations(mutated).length > 0, 'the contract must reject the mutant');
  });
}

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall liveness-v1 contract tests passed');
