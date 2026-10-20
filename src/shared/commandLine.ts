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
  const legacy = (): string[] => {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  };
  const out: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === '"' && ch === '\\') {
      let n = 1;
      while (command[i + n] === '\\') n++;
      if (command[i + n] === '"') {
        token += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) token += '"';
        else quote = null;
        i += n;
      } else {
        token += '\\'.repeat(n);
        i += n - 1;
      }
      started = true;
    } else if (ch === quote) {
      quote = null;
      started = true;
    } else if (!quote && (ch === '"' || (!started && ch === "'"))) {
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
  // Keep the former tokenization for malformed command text rather than
  // silently absorbing every following flag into an unterminated quote.
  if (quote) return legacy();
  if (started) out.push(token);
  return out;
}
