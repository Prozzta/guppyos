'use strict';
/**
 * CLAIMS-90 C0b (god 21:20, 21:21): the answerer may follow a claim's `history: memory.md#...`
 * pointer with the Read tool, on the sandbox's T_s copy only. A live agent types the live path
 * (its spawn prompt names the hive), so the serve hook rewrites a Read of exactly
 * <live hive>/agents/<id>/memory.md to the sandbox copy; a Read of the sandbox copy is allowed as is.
 * Nothing else matches: not Grep, not Bash, not another file, not a path with `..`.
 */
const fs = require('node:fs');
const path = require('node:path');

const LIVE_MEMORY_MD = /^(?:c:|\/c)[\\/]+Dunder[\\/]+hive[\\/]+agents[\\/]+([A-Za-z0-9._-]+)[\\/]+memory\.md$/i;

/** { kind: 'live'|'sandbox', agent, target } when filePath is an agent's memory.md and the sandbox copy exists; else null. */
function memoryMdOf(filePath, sandboxHive) {
  if (typeof filePath !== 'string' || !sandboxHive || /(^|[\\/])\.\.([\\/]|$)/.test(filePath)) return null;
  const copy = (agent) => path.join(sandboxHive, 'agents', agent, 'memory.md');
  const live = LIVE_MEMORY_MD.exec(filePath);
  if (live && !/^\.+$/.test(live[1])) return fs.existsSync(copy(live[1])) ? { kind: 'live', agent: live[1], target: copy(live[1]) } : null;
  const rel = path.relative(path.resolve(sandboxHive), path.resolve(filePath)).split(path.sep);
  if (rel.length === 3 && rel[0] === 'agents' && rel[2] === 'memory.md' && /^[A-Za-z0-9._-]+$/.test(rel[1]) && !/^\.+$/.test(rel[1])) {
    return fs.existsSync(copy(rel[1])) ? { kind: 'sandbox', agent: rel[1], target: copy(rel[1]) } : null;
  }
  return null;
}

module.exports = { memoryMdOf, LIVE_MEMORY_MD };
