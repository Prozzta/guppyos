/** Count-only W8 diagnostics. Inputs are claims-note-choice rows (never note text). */
export interface NoteChoiceRow { kind?: unknown; choice?: unknown; targets?: unknown; bareSeparate?: unknown; sameKey?: unknown; sameKeyChosen?: unknown }
export function summarizeWriteHabit(rows: NoteChoiceRow[]): {
  offered: number; replace: number; separate: number; separateWithCandidate: number; cancel: number; new: number;
  explicitResolution: number; replaceShare: number | null;
  /** CL-M4-FORWARD-PATH: notes written where no offer could be shown (the `ledger` command). */
  unoffered: number;
  /** Offers a bare --separate was sent back to; offers that held a same-key claim; replaces of one. */
  bareSeparate: number; offeredSameKey: number; replaceSameKey: number;
  /** Claims written (replace + separate + new + unoffered) and the replace share of them. */
  writes: number; replaceOfWrites: number | null;
} {
  let offered = 0, replace = 0, separate = 0, separateWithCandidate = 0, cancel = 0, fresh = 0;
  let unoffered = 0, bareSeparate = 0, offeredSameKey = 0, replaceSameKey = 0;
  for (const row of rows) {
    if (row.kind !== 'claims-note-choice') continue;
    const n = Array.isArray(row.targets) ? row.targets.length : 0;
    if (row.choice === 'offered' && n > 0) {
      offered++;
      if (row.bareSeparate === true) bareSeparate++;
      if (typeof row.sameKey === 'number' && row.sameKey > 0) offeredSameKey++;
    }
    else if (row.choice === 'replace') { replace++; if (row.sameKeyChosen === true) replaceSameKey++; }
    else if (row.choice === 'separate') { separate++; if (n > 0) separateWithCandidate++; }
    else if (row.choice === 'cancel') cancel++;
    else if (row.choice === 'new') fresh++;
    else if (row.choice === 'unoffered') unoffered++;
  }
  const explicitResolution = replace + separateWithCandidate + cancel;
  const writes = replace + separate + fresh + unoffered;
  return { offered, replace, separate, separateWithCandidate, cancel, new: fresh, explicitResolution,
    replaceShare: explicitResolution ? replace / explicitResolution : null,
    unoffered, bareSeparate, offeredSameKey, replaceSameKey, writes, replaceOfWrites: writes ? replace / writes : null };
}
