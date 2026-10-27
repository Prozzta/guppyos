'use strict';
/**
 * CLAIMS-90 step 3 (Jim 4370f6, god 8c87a7): the answer child's claims deps. The read verbs (memory get,
 * memory history) answer through main's own read wiring, src/main/claims/readWiring.ts, which index.ts
 * calls, so the harness cannot drift from the shipped path. get's tasks are the app's own
 * HiveManager.allTasks() over the jailed hive (Jim 0959e3: tasks.json through the hive's reader, plus the
 * archive). The answerer never writes: level 'reader' refuses every write verb, as the app does for a reader.
 * The ledger's taskStatus and the delivery's tasks read the same list (Jim 8dc581), as index.ts does.
 */
const path = require('node:path');

/** L loads a tree module by its repo-relative path (load-ts). The hive folder is <home>/hive, as HiveManager roots it. */
function hiveTasksFor(L, hive) {
  const { HiveManager } = L('src/main/hive.ts');
  const hm = new HiveManager(() => path.dirname(hive));
  if (path.resolve(hm.root() ?? '').toLowerCase() !== path.resolve(hive).toLowerCase()) throw new Error(`HiveManager roots ${hm.root()}, not ${hive}`);
  return { allTasks: () => hm.allTasks().tasks, dispose: () => hm.dispose() };
}

/** index.ts ClaimStore taskStatus: a card's status from hive.allTasks(), the archive included. */
function taskStatusFor(allTasks) {
  return (id) => (allTasks() ?? []).find((t) => t.id === id)?.status ?? null;
}

function claimsDepsFor(L, { hive, store, agents, allTasks }) {
  const { claimCardLeadOver, claimGetOver, claimHistoryOver } = L('src/main/claims/readWiring.ts');
  const read = { root: hive, store, agents, tasks: allTasks };
  return {
    store,
    level: () => 'reader',
    claimHistory: (agentId, id) => claimHistoryOver(read, agentId, id),
    get: (_agentId, args) => claimGetOver(read, args),
    // CLAIMS-90 keyfind (god c4eea4): the search briefs (S1-S4), as index.ts's NativeMemoryWiring cardLead answers them.
    // Without it every served search printed no card or release brief (on-1: no bump, tag or merge brief on any row).
    cardLead: (ask) => claimCardLeadOver(read, ask),
  };
}

/** Jim 4370f6 run guard: a reply saying the build does not answer a verb. */
const UNAVAILABLE_RE = /unsupported command|not available in this build/;

module.exports = { hiveTasksFor, taskStatusFor, claimsDepsFor, UNAVAILABLE_RE };
