/**
 * CLAIM-LEDGER B10: secrets are redacted on write. A claim is kept verbatim except for what looks
 * like a credential, which becomes `[redacted]`, and the record carries `redacted: true`.
 * Conservative patterns only: a false positive costs a word, a false negative leaks a secret into
 * an append-only file.
 */
const MARK = '[redacted]';

const WHOLE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,                 // Anthropic / OpenAI keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                            // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                                    // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                          // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                               // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,   // JWT
];
/** A label that stays, then the value that goes. */
const LABELLED: RegExp[] = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*)(?!\[redacted\])\S{6,}/gi,
];

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const re of WHOLE) out = out.replace(re, MARK);
  for (const re of LABELLED) out = out.replace(re, (_m, label: string) => `${label}${MARK}`);
  return { text: out, redacted: out !== text };
}
