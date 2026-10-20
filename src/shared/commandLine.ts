/** Split a command string into argv, respecting double/single quotes so a model
 *  value with spaces (agy's `--model "Gemini 3.1 Pro (High)"`) stays one token.
 *  Quotes are stripped from the result.
 *
 *  Shared because BOTH sides split command lines: the renderer's spawn flows
 *  (AddAgentModal, restore, command center) and main's god-hired-worker path
 *  (processSpawnRequest). They used to carry byte-identical copies, which is an
 *  invitation for the two to drift — and a worker whose command line splits
 *  differently from the renderer's is exactly the class of silent breakage the
 *  spawn-request fix exists to prevent. */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === '"' && ch === '\\' && i + 1 < command.length && /["\\]/.test(command[i + 1])) {
      token += command[++i];
      started = true;
    } else if (ch === quote) {
      quote = null;
      started = true;
    } else if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
      started = true;
    } else if (!quote && /\s/.test(ch)) {
      if (started) out.push(token);
      token = '';
      started = false;
    } else {
      token += ch;
      started = true;
    }
  }
  if (started) out.push(token);
  return out;
}
