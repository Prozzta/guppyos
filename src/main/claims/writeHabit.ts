/** Count-only W8 diagnostics. Inputs are claims-note-choice rows (never note text). */
export interface NoteChoiceRow { kind?: unknown; choice?: unknown; targets?: unknown }
export function summarizeWriteHabit(rows: NoteChoiceRow[]): {
  offered: number; replace: number; separate: number; separateWithCandidate: number; cancel: number; new: number;
  explicitResolution: number; replaceShare: number | null;
} {
  let offered = 0, replace = 0, separate = 0, separateWithCandidate = 0, cancel = 0, fresh = 0;
  for (const row of rows) {
    if (row.kind !== 'claims-note-choice') continue;
    const n = Array.isArray(row.targets) ? row.targets.length : 0;
    if (row.choice === 'offered' && n > 0) offered++;
    else if (row.choice === 'replace') replace++;
    else if (row.choice === 'separate') { separate++; if (n > 0) separateWithCandidate++; }
    else if (row.choice === 'cancel') cancel++;
    else if (row.choice === 'new') fresh++;
  }
  const explicitResolution = replace + separateWithCandidate + cancel;
  return { offered, replace, separate, separateWithCandidate, cancel, new: fresh, explicitResolution,
    replaceShare: explicitResolution ? replace / explicitResolution : null };
}
