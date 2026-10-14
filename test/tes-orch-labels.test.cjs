'use strict';

// TES-ORCH-LABELS (1.1.86): UI text names the orchestrator the floor shows. In the Office (and
// the built-in TV themes) every label reads exactly as before, "Michael"; on a theme-pack floor
// it is the orchestrator's display name, or the pack's seed name before the god exists. Generic:
// no pack is named. Ids, the god role and agent prompts keep "michael"/"god" untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const PT = loadTs('src/shared/projectTheme.ts');
const ON = loadTs('src/shared/orchestratorName.ts');
const EA = loadTs('src/shared/engineAvailability.ts');

PT.registerPackThemes([
  { id: 'deck-labels', label: 'Deck Labels', orchestrator: { name: 'Commander Seed', appearance: { bodyId: 'b', colors: {} } } },
  { id: 'deck-noseed', label: 'Deck No Seed' }
]);

test('the Office keeps "Michael"; a pack floor names its own orchestrator', () => {
  for (const office of ['office', 'parks', undefined, null, 'not-a-theme']) {
    assert.equal(ON.orchestratorDisplayName(office), 'Michael', String(office));
    // Even a renamed god does not change the Office wording.
    assert.equal(ON.orchestratorDisplayName(office, 'Gareth'), 'Michael', String(office));
  }
  assert.equal(ON.orchestratorDisplayName('deck-labels', 'Cpt Kerk'), 'Cpt Kerk');
  assert.equal(ON.orchestratorDisplayName('deck-labels', '  '), 'Commander Seed', 'booting: the pack seed');
  assert.equal(ON.orchestratorDisplayName('deck-labels'), 'Commander Seed');
  assert.equal(ON.orchestratorDisplayName('deck-noseed'), 'Michael', 'no seed, no god: the default');

  // A shared string helper: same words in the Office, the pack's name on a pack floor.
  const a = { state: 'not-installable' };
  assert.match(EA.engineAvailabilityMessage(a, 'Grok'), /so Michael could not start\./);
  assert.match(EA.engineAvailabilityMessage(a, 'Grok', ON.orchestratorDisplayName('deck-labels', 'Cpt Kerk')), /so Cpt Kerk could not start\./);
});

// Every label that named the orchestrator now reads it from the floor. The Office output is the
// old text because the name is 'Michael' there (pinned above), and these are the templates.
const SITES = {
  'src/renderer/src/App.tsx': ['{orchName} is clocking in.'],
  'src/renderer/src/components/AgentHoldButton.tsx': ['`End the 1:1. ${orch} can hand ${agent.name} work again.`', 'Take ${agent.name} aside. ${orch} stops sending', '`End the 1:1 and release this agent to ${orch}`'],
  'src/renderer/src/components/CommandCenterPanel.tsx': ['title={`DISPATCH — VIA ${orch.toUpperCase()}`}', 'placeholder={`Describe the task… (${orch} decomposes, writes the card, and assigns)`}'],
  'src/renderer/src/components/MichaelBooting.tsx': ['{orch} is settling into the corner office'],
  'src/renderer/src/components/TasksKanban.tsx': ['new work? dispatch it to {orch} (monitor tab)'],
  'src/renderer/src/components/SetupPanel.tsx': ['{orch} can install the', 'ask {orch} to set up everything'],
  'src/renderer/src/components/WorkersTab.tsx': ['Isolated workers {orch} spins up'],
  'src/renderer/src/components/RealtimeMichaelToggle.tsx': ['`Talk to ${orch} — start the voice session`', 'view.help(orch)'],
  'src/renderer/src/components/triggers/TriggerHistoryTab.tsx': ['`No reply yet. ${orch} has this one.`', 'next to what ${orch} sent back.', 'title={`Send this message through to ${orch}`}'],
  'src/renderer/src/components/triggers/SchedulesSection.tsx': ["to === 'god' ? orch :", '<option value="god">{orch}</option>', "<option value=\"god\">{targetName('god')}</option>"],
  'src/renderer/src/components/OnboardingWizard.tsx': ['orchestratorDisplayName(projectTheme)', '`${orch.toUpperCase()} IS YOUR CLONE`', "This only sets {orch}'s engine.", 'providerPreset(godProvider).label, orch)'],
  'src/renderer/src/components/SettingsModal.tsx': ["Triggers tab of ${orch}'s Command Center.`", '{webhookApiDoc(orch)}', '`me and ${orch}`', 'Realtime {orch}', "Reset wipes {orch}'s memories,"]
};

test('every orchestrator label takes the floor\'s name; no UI text hard-codes "Michael"', () => {
  for (const [file, needles] of Object.entries(SITES)) {
    const src = read(file);
    for (const n of needles) assert.ok(src.includes(n), `${file}: ${n}`);
    if (file !== 'src/renderer/src/components/OnboardingWizard.tsx') assert.match(src, /useOrchestratorName\(\)/, file);
    // Outside comments, "Michael" survives only inside identifiers (MichaelBooting, RealtimeMichael…).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const left = code.split(/\r?\n/).filter((l) => /(?<![A-Za-z])Michael(?![A-Za-z])/.test(l));
    assert.deepEqual(left, [], file);
  }
  const hook = read('src/renderer/src/hooks/useOrchestratorName.ts');
  assert.match(hook, /orchestratorDisplayName\(floor, godName\)/);
  assert.match(hook, /s\.officeTheme/);
});

test('the new tagline is the package description and the Linux description', () => {
  const tagline = 'Boldly code where no team has coded before. Your AI crew, on duty 24/7.';
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.description.startsWith(tagline + ' A free, local-first multi-agent harness'), pkg.description);
  const eb = read('electron-builder.yml');
  assert.ok(eb.includes(`description: "${tagline} A free, local-first multi-agent harness`));
  assert.ok(!/Clones for you and your team/.test(JSON.stringify(pkg) + eb), 'the old tagline is gone');
});
