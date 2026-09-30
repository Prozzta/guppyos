#!/usr/bin/env node
/**
 * SESSION-PROMPT-ROTATION: generate src/main/sessionRotationLegacy.ts, the normalised 1.1.75
 * prompt fingerprint of every Claude prompt variant.
 *
 * usage: node tools/gen-legacy-prompt-fp.cjs <checkout of v1.1.75 with node_modules>
 *
 * It renders the REAL v1.1.75 injectedPrompt (that checkout's own hive.ts, not this branch's)
 * with the canonical inputs forced: placeholder name/id/dir/root/node path, memory on, KG off,
 * no runtime line, and each mail mode and role. The fingerprint function is this branch's
 * (normaliseCanonicalPaths + sha256). HOME is redirected before the hive module loads.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const legacyRoot = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(legacyRoot, 'src/main/hive.ts'))) throw new Error(`not a checkout: ${legacyRoot}`);
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-fp-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
if (os.homedir() !== FAKE_HOME) throw new Error('HOME redirect failed');

const loadLegacy = require(path.join(legacyRoot, 'test/load-ts.cjs'));
const loadHere = require(path.join(__dirname, '../test/load-ts.cjs'));
const { HiveManager } = loadLegacy('src/main/hive.ts');
const R = loadHere('src/main/sessionRotation.ts');
const P = R.CANONICAL_PROMPT;

const MODES = ['inject', 'legacy-read', 'legacy-move', 'work-order'];
const ROLES = ['worker', 'assistant', 'god', 'god+spawn'];
const out = {};
try {
  for (const role of ROLES) {
    const hive = new HiveManager(() => FAKE_HOME);
    hive.setRuntimeInfo(null);
    hive.nodeCommand = () => P.node;
    if (role === 'god+spawn') hive.setOrchestratorMaySpawn?.(true);
    if (role === 'god' || role === 'god+spawn') {
      if (hive.orchestratorMaySpawn() !== (role === 'god+spawn')) throw new Error(`cannot set the spawn toggle for ${role}`);
    }
    const meta = { id: P.id, name: P.name, provider: 'claude', cwd: FAKE_HOME, isGod: role.startsWith('god'), isAssistant: role === 'assistant' };
    for (const mode of MODES) {
      hive.promptMailMode = () => mode;
      const text = hive.injectedPrompt(meta, P.agentDir, P.hiveRoot, true, false, undefined);
      out[R.promptVariant('claude', mode, role)] = R.canonicalPromptFingerprint(text);
    }
    hive.dispose?.();
  }
} finally {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
const target = path.join(__dirname, '../src/main/sessionRotationLegacy.ts');
const src = fs.readFileSync(target, 'utf8');
const body = Object.entries(out).map(([k, v]) => `  '${k}': '${v}',`).join('\n');
fs.writeFileSync(target, src.replace(/(LEGACY_175_PROMPT_FP: Readonly<Record<string, string>> = \{)[\s\S]*?(\n\};)/, `$1\n${body}$2`));
console.log(JSON.stringify(out, null, 2));
