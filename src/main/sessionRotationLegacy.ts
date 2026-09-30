/**
 * SESSION-PROMPT-ROTATION: the NORMALISED 1.1.75 prompt fingerprint of every Claude prompt
 * variant (sessionRotation.ts: CANONICAL_PROMPT, promptVariant). A session recorded before
 * stamps existed is stamped with its variant's value at the first 1.1.76 boot, then compared as
 * usual. Generated from the v1.1.75 prompt text (0a9347a8) by rendering the canonical prompt of
 * each variant; test/session-prompt-rotation.test.cjs pins it. Build-time constant: never edit
 * by hand, and never regenerate from a later prompt (it describes what 1.1.75 sessions got).
 */
export const LEGACY_175_PROMPT_FP: Readonly<Record<string, string>> = {
  'claude|inject|worker': 'fea58284406c3930',
  'claude|legacy-read|worker': 'e3be5bc71dacccf6',
  'claude|legacy-move|worker': 'f03ee762f9f8ca35',
  'claude|work-order|worker': '00d3f58ea22cffb9',
  'claude|inject|assistant': '4d5d527b33fe4c13',
  'claude|legacy-read|assistant': 'cd33f87a086e8b15',
  'claude|legacy-move|assistant': '32f0e925e5fb0fcb',
  'claude|work-order|assistant': 'eba6c6fc7d6e3ce0',
  'claude|inject|god': '0e158445beba291a',
  'claude|legacy-read|god': 'a2cf66e0d57425c9',
  'claude|legacy-move|god': 'ca6f0c117db3c881',
  'claude|work-order|god': 'fd7bad9b10cf26c7',
  'claude|inject|god+spawn': '2b4812453e444fa5',
  'claude|legacy-read|god+spawn': 'aaa1702d3ffa4587',
  'claude|legacy-move|god+spawn': 'c3afbfac44316500',
  'claude|work-order|god+spawn': '93a08f4c8627566a',
};
