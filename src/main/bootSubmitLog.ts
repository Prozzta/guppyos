/**
 * START-FIXES-163 (3), Jim N2: which boot-submit outcomes get a log.jsonl row.
 *
 * A booting TUI answers REFUSED/ABORTED up to 40 times (BOOT_PROMPT_MAX_ATTEMPTS, 1.5 s
 * apart) before it is judged ready. A row per retry buried the one that mattered. So a
 * retrying state is logged only when it CHANGES for that request (kind + reason), and
 * every final outcome always is. Bounded: at most `cap` requests are remembered.
 */
export function createBootSubmitRowGate(cap = 64): (requestId: string, kind: string, reason: string | undefined) => boolean {
  const last = new Map<string, string>();
  return (requestId, kind, reason) => {
    const retrying = kind === 'REFUSED' || kind === 'ABORTED';
    if (!retrying) { last.delete(requestId); return true; }
    const key = `${kind}|${reason ?? ''}`;
    if (last.get(requestId) === key) return false;
    if (!last.has(requestId) && last.size >= cap) last.delete(last.keys().next().value as string);
    last.set(requestId, key);
    return true;
  };
}
