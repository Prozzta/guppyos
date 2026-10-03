import type {
  BuildWorkingSetFn, ClaimRec, ClaimsState, LedgerRec, Receipt, ReconcileItem,
  RenderExportLineFn, RenderMemoryMdFn, WorldView,
} from '../../shared/claims';
import { GENERATED_MEMORY_MARKER } from './generated';
import { reconcilePromptText } from './reconcile';

/** B8 fixed budget shares; lower-tier unused capacity flows down only. */
export const WORKING_SET_TIER_SHARES = [0.40, 0.10, 0.50] as const;
export const DEFAULT_WORKING_SET_BUDGET = 3000;
export type CountTokens = (text: string) => number;
export type RenderMemoryMdOptions = { exclude?: (id: string) => boolean };
export type RenderMemoryMdWithExcludeFn = (state: ClaimsState, view: WorldView, mode: 'view' | 'complete', options?: RenderMemoryMdOptions) => string;

const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const tokens = (count: CountTokens, text: string): number => {
  const n = count(text); return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
};
const flagText = (flags: string[]): string => flags.length ? `⚠ ${flags.join(', ')} · ` : '';
const claimLine = (claim: ClaimRec, status: string, flags: string[] = []): string => {
  const [first, ...rest] = claim.text.split('\n');
  return [`- ${flagText(flags)}${first} [status:${status}] [c:${claim.id}]`, ...rest.map(line => `  ${line}`)].join('\n');
};

/** Bind an immutable append-order snapshot and the native-memory tokenizer to frozen W4 signatures. */
export function createClaimViews(records: LedgerRec[], countTokens: CountTokens, reconcileItems: ReconcileItem[] = []): {
  buildWorkingSet: BuildWorkingSetFn; renderMemoryMd: RenderMemoryMdFn & RenderMemoryMdWithExcludeFn; renderExportLine: RenderExportLineFn;
} {
  const claims = records.filter((r): r is ClaimRec => r.t === 'claim');
  const byId = new Map(claims.map((c, i) => [c.id, { claim: c, order: i }]));
  const acceptedMail = new Set<string>();
  for (const r of records) if (r.t === 'event' && r.ev === 'reconcile-answer' && (r.answer === 'keep-both' || r.answer === 'supersedes')) {
    for (const id of r.targets) acceptedMail.add(id);
  }

  const buildWorkingSet: BuildWorkingSetFn = (state, view, budget) => {
    const cap = Math.max(0, Math.floor(budget));
    const excluded = new Map<string, Receipt['excluded'][number]['reason']>();
    const eligible: Array<{ claim: ClaimRec; order: number }> = [];
    for (const [id, status] of Object.entries(state.claims)) {
      const found = byId.get(id);
      if (status.status !== 'live' || !found) { excluded.set(id, 'status'); continue; }
      if (view.flags[id]?.includes('expired')) { excluded.set(id, 'expired'); continue; }
      if (found.claim.source.startsWith('mail:') && !acceptedMail.has(id)) { excluded.set(id, 'status'); continue; }
      eligible.push(found);
    }
    const tier = (c: ClaimRec): 0 | 2 => c.pin === true || c.kind === 'lesson' ? 0 : 2;
    const rank = (a: typeof eligible[number], b: typeof eligible[number]): number => {
      const ca = state.claims[a.claim.id]; const cb = state.claims[b.claim.id];
      const ua = view.counters[a.claim.id] ?? { helped: 0, hurt: 0 };
      const ub = view.counters[b.claim.id] ?? { helped: 0, hurt: 0 };
      return cmp(cb.lastAt, ca.lastAt) || cb.sightings - ca.sightings ||
        (ub.helped - ub.hurt) - (ua.helped - ua.hurt) || a.order - b.order;
    };
    const groups = [eligible.filter(x => tier(x.claim) === 0).sort(rank), [], eligible.filter(x => tier(x.claim) === 2).sort(rank)];
    const output = [`# Memory working set — ${state.agent}`];
    let used = tokens(countTokens, output.join('\n'));
    const included: Receipt['included'] = [];
    const tierUsed = [0, 0, 0];
    const add = (line: string, t: number, id?: string): boolean => {
      const n = tokens(countTokens, line);
      if (tokens(countTokens, [...output, line].join('\n')) > cap || tierUsed[t] + n > Math.floor(cap * WORKING_SET_TIER_SHARES[t])) return false;
      output.push(line); used = tokens(countTokens, output.join('\n')); tierUsed[t] += n;
      if (id) included.push({ id, tier: t, tokens: n });
      return true;
    };
    // T0 pinned/lesson claims are first. Overflow is explicit and is not promoted to T2.
    for (const { claim, order: _order } of groups[0]) {
      const id = claim.id;
      if (!add(claimLine(claim, state.claims[id].status, view.flags[id] ?? []), 0, id)) excluded.set(id, 'tier-share');
    }
    // T1 holds reconcile prompts and world warning markers. Use the exact rendered prompt text
    // that ReconcileApi token-counted/charged, so daily accounting matches delivery byte-for-byte.
    const markers = [
      ...reconcileItems.slice(0, 3).map(reconcilePromptText),
      ...Object.keys(view.flags).filter(id => view.flags[id].length).sort(cmp).map(id => `⚠ ${id}: ${view.flags[id].join(', ')}`),
    ];
    let markersIncluded = 0;
    for (const marker of markers) if (add(marker, 1)) markersIncluded++;
    const markersOmitted = markers.length - markersIncluded;
    const t2Limit = Math.floor(cap * WORKING_SET_TIER_SHARES[2]) +
      Math.max(0, Math.floor(cap * WORKING_SET_TIER_SHARES[0]) - tierUsed[0]) +
      Math.max(0, Math.floor(cap * WORKING_SET_TIER_SHARES[1]) - tierUsed[1]);
    let t2Used = 0;
    const t2Cap = Math.min(cap - used, t2Limit);
    for (const { claim } of groups[2]) {
      const id = claim.id; const line = claimLine(claim, state.claims[id].status);
      const n = tokens(countTokens, line);
      if (tokens(countTokens, [...output, line].join('\n')) <= cap && t2Used + n <= t2Cap) {
        output.push(line); used = tokens(countTokens, output.join('\n')); t2Used += n; tierUsed[2] += n;
        included.push({ id, tier: 2, tokens: n });
      } else excluded.set(id, 'budget');
    }
    const excludedRows = [...excluded].sort(([a], [b]) => cmp(a, b)).map(([id, reason]) => ({ id, reason }));
    const omitted = excludedRows.filter(x => x.reason === 'budget' || x.reason === 'tier-share').length;
    const warnings = [
      ...(groups[0].some(({ claim }) => excluded.get(claim.id) === 'tier-share') ? ['Pinned/lesson tier exceeded its budget share.'] : []),
      ...(markersOmitted ? [`${markersOmitted} warning marker(s) omitted at the tier-share limit.`] : []),
      ...(omitted ? [`Working set omitted ${omitted} claim(s) at the ${cap}-token budget.`] : []),
    ];
    if (omitted) {
      const note = `⚠ ${warnings[warnings.length - 1]}`;
      const n = tokens(countTokens, note);
      if (tokens(countTokens, [...output, note].join('\n')) <= cap) { output.push(note); used = tokens(countTokens, output.join('\n')); }
      const more = `+${omitted} more`; const mn = tokens(countTokens, more);
      if (tokens(countTokens, [...output, more].join('\n')) <= cap) { output.push(more); used = tokens(countTokens, output.join('\n')); }
    }
    const text = output.join('\n');
    const receipt: Receipt = { at: records.at(-1)?.wt ?? '', agent: state.agent, budget: cap,
      used: tokens(countTokens, text), included, excluded: excludedRows, warnings };
    return { text, receipt };
  };

  const renderMemoryMd: RenderMemoryMdFn & RenderMemoryMdWithExcludeFn = (state, view, mode, options?: RenderMemoryMdOptions) => {
    const isExcluded = options?.exclude ?? (() => false);
    const selectedRecords = records.map((rec, index) => ({ rec, index }))
      .sort((a, b) => cmp(a.rec.at, b.rec.at) || cmp(a.rec.wt, b.rec.wt) || a.index - b.index)
      .map(({ rec }) => rec);
    const lines = [GENERATED_MEMORY_MARKER, `# Memory — ${state.agent}`];
    if (mode === 'view') {
      const working = buildWorkingSet(state, view, DEFAULT_WORKING_SET_BUDGET);
      lines.push('', '## How I work (standing lessons)');
      const includedIds = new Set(working.receipt.included.map(item => item.id));
      for (const c of claims.filter(c => c.kind === 'lesson' && state.claims[c.id]?.status === 'live' && includedIds.has(c.id)).sort((a, b) => cmp(a.at, b.at) || cmp(a.id, b.id))) {
        lines.push(claimLine(c, state.claims[c.id].status, view.flags[c.id] ?? []));
      }
      const lessons = new Set(claims.filter(c => c.kind === 'lesson' && includedIds.has(c.id)).map(c => `[c:${c.id}]`));
      lines.push('', '## Working set', ...working.text.split('\n').slice(1)
        .filter(line => ![...lessons].some(tag => line.includes(tag))));
    } else {
      lines.push('', '## How I work (standing lessons)');
      for (const rec of selectedRecords) {
        if (rec.t === 'claim' && rec.kind === 'lesson' && state.claims[rec.id]?.status === 'live') {
          lines.push(claimLine(rec, state.claims[rec.id].status));
        }
      }
      lines.push('', '## All claims (complete export)');
      for (const rec of selectedRecords) {
        if (rec.t === 'event') { lines.push(`<!-- event:${rec.id} ${rec.ev} -->`); continue; }
        if (isExcluded(rec.id)) continue;
        const status = state.claims[rec.id]?.status ?? 'live';
        if (rec.kind === 'lesson' && status === 'live') continue;
        lines.push(claimLine(rec, status));
      }
    }
    return lines.join('\n') + '\n';
  };
  const renderExportLine: RenderExportLineFn = (rec, state) => rec.t === 'event'
    ? `<!-- event:${rec.id} ${rec.ev} -->`
    : `- ${JSON.stringify(rec.text)} [status:${state.claims[rec.id]?.status ?? 'live'}] [c:${rec.id}]`;
  return { buildWorkingSet, renderMemoryMd, renderExportLine };
}
