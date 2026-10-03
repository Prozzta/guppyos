/**
 * CLAIM-LEDGER W6: the marker of a GENERATED memory.md (plan §3 W6, gate G6.6).
 *
 * In `writer` mode an agent's memory.md is a view rendered from its claims ledger (W4
 * renderMemoryMd). Two older janitors rewrite memory.md: the 1.1.83 rollover (memoryRollover.ts)
 * and the Haiku condense (reflect.ts). Neither may ever touch a generated view: the ledger is the
 * authority, and a rewrite would be overwritten at the next render anyway (or, worse, re-imported).
 *
 * The contract between W4 and W6: the renderer writes GENERATED_MEMORY_MARKER as the file's first
 * line, and both janitors skip any memory.md whose first line starts with GENERATED_MEMORY_PREFIX.
 * It is an HTML comment, so it renders invisibly, and the import's split skips comment lines,
 * so it never becomes a claim.
 */
export const GENERATED_MEMORY_PREFIX = '<!-- claim-ledger: generated';
export const GENERATED_MEMORY_MARKER = `${GENERATED_MEMORY_PREFIX} view of this agent's claims; do not edit (use \`memory note\`) -->`;

/** Whether a memory.md text is a generated view (its first line, after any BOM, is the marker). */
export function isGeneratedMemory(text: string): boolean {
  return text.replace(/^﻿/, '').startsWith(GENERATED_MEMORY_PREFIX);
}
