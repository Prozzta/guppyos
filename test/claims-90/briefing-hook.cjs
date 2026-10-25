'use strict';
/**
 * CLAIMS-90 M4: the contained answerer's SessionStart hook. It hands Claude Code the snapshot
 * briefing that the serve child rendered, in the reply shape hooks.ts sends for the briefing part
 * (additionalContext; nothing when the render is empty).
 *   node briefing-hook.cjs <briefing file>
 */
const fs = require('node:fs');

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const text = fs.readFileSync(process.argv[2], 'utf8');
  process.stdout.write(JSON.stringify(text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {}));
});
