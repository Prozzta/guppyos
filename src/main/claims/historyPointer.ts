/**
 * CLAIMS-90 HISTORY-PTR: the one place a claim's history pointer is spelled. A pointer is a runnable
 * `memory` command, answered from the hive the app serves (the snapshot under the runner, the live
 * hive in the app); it never names a file, so an agent never goes looking for one on disk. To
 * point somewhere else later (a `memory get <key>` line), change historyPointer only.
 *
 * withHistoryCommands rewrites the old `memory.md#claim-history-<id>` anchors that memory.md files
 * written before this change still hold, wherever such text is served (search hits, wake-up).
 */
export const historyPointer = (id: string): string => `memory history ${id}`;

const LEGACY_ANCHOR = /memory\.md#claim-history-([A-Za-z0-9_-]+)/g;

export const withHistoryCommands = (text: string): string => text.replace(LEGACY_ANCHOR, (_m, id: string) => historyPointer(id));
