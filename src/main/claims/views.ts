import type {
  BuildWorkingSetFn, ClaimRec, ClaimsState, LedgerRec, Receipt, ReconcileItem,
  KeyRegistry, RenderExportLineFn, RenderMemoryMdFn, WorldView,
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
const canonicalKey = (key: string, registry: KeyRegistry): string => {
  let current = key; const seen = new Set<string>();
  while (!seen.has(current)) { seen.add(current); const alias = registry.keys[current]?.aliasOf; if (!alias) break; current = alias; }
  return current;
};
const isSingleKey = (key: string, registry?: KeyRegistry): boolean => {
  if (!registry) return false;
  const canonical = canonicalKey(key, registry);
  const exact = registry.keys[canonical] ?? registry.keys[key];
  if (exact) return exact.cardinality === 'single';
  for (const namespace of registry.namespaces) {
    const star = namespace.pattern.indexOf('*');
    const prefix = star < 0 ? namespace.pattern : namespace.pattern.slice(0, star);
    const suffix = star < 0 ? '' : namespace.pattern.slice(star + 1);
    if (canonical.startsWith(prefix) && canonical.endsWith(suffix) && canonical.length >= prefix.length + suffix.length)
      return namespace.cardinality === 'single';
  }
  return false;
};
const tokens = (count: CountTokens, text: string): number => {
  const n = count(text); return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
};
const flagText = (flags: string[]): string => flags.length ? `⚠ ${flags.join(', ')} · ` : '';
const claimLine = (claim: ClaimRec, status: string, flags: string[] = []): string => {
  const [first, ...rest] = claim.text.split('\n');
  return [`- ${flagText(flags)}${first} [status:${status}] [c:${claim.id}]`, ...rest.map(line => `  ${line}`)].join('\n');
};

/** Explicit supersedes and derived same-key supersededBy links form a dated history group. */
function historyGroups(claims: ClaimRec[], state: ClaimsState): Map<string, ClaimRec[]> {
  const byId = new Map(claims.map(c => [c.id, c]));
  const parent = new Map(claims.map(c => [c.id, c.id]));
  const root = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const r = root(p); parent.set(id, r); return r;
  };
  const join = (a: string, b: string): void => {
    if (!byId.has(a) || !byId.has(b)) return;
    const ra = root(a), rb = root(b); if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of claims) {
    for (const id of c.supersedes ?? []) join(c.id, id);
    const successor = state.claims[c.id]?.supersededBy;
    if (successor) join(c.id, successor);
  }
  const groups = new Map<string, ClaimRec[]>();
  for (const c of claims) { const r = root(c.id); const group = groups.get(r) ?? []; group.push(c); groups.set(r, group); }
  return groups;
}

function historyCurrent(group: ClaimRec[], state: ClaimsState): ClaimRec | undefined {
  return group.slice().sort((a, b) => {
    const live = Number(state.claims[a.id]?.status === 'live') - Number(state.claims[b.id]?.status === 'live');
    return live || cmp(a.at || a.wt, b.at || b.wt) || cmp(a.wt, b.wt) || cmp(a.id, b.id);
  }).at(-1);
}

const claimDate = (c: ClaimRec): string => (c.at || c.wt).slice(0, 10);
const historyAnchor = (id: string): string => `claim-history-${id}`;

/** Bind an immutable append-order snapshot and the native-memory tokenizer to frozen W4 signatures. */
export function createClaimViews(records: LedgerRec[], countTokens: CountTokens, reconcileItems: ReconcileItem[] = [], registry?: KeyRegistry): {
  buildWorkingSet: BuildWorkingSetFn;
  buildWorkingSetDetailed: (state: ClaimsState, view: WorldView, budget: number) => {
    text: string; receipt: Receipt; renderedReconcileItems: ReconcileItem[];
    droppedReconcileItems: Array<{ item: ReconcileItem; reason: string }>;
  };
  renderMemoryMd: RenderMemoryMdFn & RenderMemoryMdWithExcludeFn; renderExportLine: RenderExportLineFn;
} {
  const claims = records.filter((r): r is ClaimRec => r.t === 'claim');
  const byId = new Map(claims.map((c, i) => [c.id, { claim: c, order: i }]));
  const acceptedMail = new Set<string>();
  for (const r of records) if (r.t === 'event' && r.ev === 'reconcile-answer' && (r.answer === 'keep-both' || r.answer === 'supersedes')) {
    for (const id of r.targets) acceptedMail.add(id);
  }

  const buildWorkingSetDetailed = (state: ClaimsState, view: WorldView, budget: number) => {
    const cap = Math.max(0, Math.floor(budget));
    const histories = historyGroups(claims, state);
    const historyFor = new Map<string, ClaimRec[]>();
    for (const group of histories.values()) for (const c of group) historyFor.set(c.id, group);
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
    const supersededBy = new Set(Object.values(state.claims).map((claim) => claim.supersededBy).filter((id): id is string => !!id));
    const currentValues = new Set(eligible.filter(({ claim }) => !!claim.key && isSingleKey(claim.key, registry) && supersededBy.has(claim.id)).map(({ claim }) => claim.id));
    const rank = (a: typeof eligible[number], b: typeof eligible[number]): number => {
      const ca = state.claims[a.claim.id]; const cb = state.claims[b.claim.id];
      const ua = view.counters[a.claim.id] ?? { helped: 0, hurt: 0 };
      const ub = view.counters[b.claim.id] ?? { helped: 0, hurt: 0 };
      return cmp(cb.lastAt, ca.lastAt) || cb.sightings - ca.sightings ||
        (ub.helped - ub.hurt) - (ua.helped - ua.hurt) || a.order - b.order;
    };
    const groups = [eligible.filter(x => tier(x.claim) === 0).sort(rank), [],
      eligible.filter(x => tier(x.claim) === 2 && currentValues.has(x.claim.id)).sort(rank),
      eligible.filter(x => tier(x.claim) === 2 && !currentValues.has(x.claim.id)).sort(rank)];
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
      const group = historyFor.get(id);
      const line = claimLine(claim, 'current', view.flags[id] ?? []) + (group && group.length > 1 ? ` [history: memory.md#${historyAnchor(id)}]` : '');
      if (!add(line, 0, id)) excluded.set(id, 'tier-share');
    }
    // T1 holds reconcile prompts and world warning markers. Use the exact rendered prompt text
    // that ReconcileApi token-counted/charged, so daily accounting matches delivery byte-for-byte.
    const markers = [
      ...reconcileItems.slice(0, 3).map(reconcilePromptText),
      ...Object.keys(view.flags).filter(id => view.flags[id].length).sort(cmp).map(id => `⚠ ${id}: ${view.flags[id].join(', ')}`),
    ];
    let markersIncluded = 0;
    const droppedReconcileItems: Array<{ item: ReconcileItem; reason: string }> = [];
    const reconcileMarkers = reconcileItems.slice(0, 3).map((item) => ({ item, text: reconcilePromptText(item) }));
    for (const marker of markers) {
      if (add(marker, 1)) { markersIncluded++; continue; }
      const item = reconcileMarkers.find((candidate) => candidate.text === marker)?.item;
      if (item) droppedReconcileItems.push({ item, reason: 'T1-space' });
    }
    const markersOmitted = markers.length - markersIncluded;
    const historyPointers = [...histories.values()].filter(group => group.length > 1)
      .map(group => historyCurrent(group, state))
      .filter((c): c is ClaimRec => !!c && state.claims[c.id]?.status === 'live')
      .map(c => ({ id: c.id, line: `- ${c.key ?? c.id} history: memory.md#${historyAnchor(c.id)}` }));
    const t0Included = new Set(included.map(x => x.id));
    const selectTier2 = (pointerReserve: number) => {
      const selected: Array<{ id: string; line: string; n: number }> = [];
      let selectedTokens = 0;
      const t2Limit = Math.max(0, Math.floor(cap * WORKING_SET_TIER_SHARES[2]) - pointerReserve) +
        Math.max(0, Math.floor(cap * WORKING_SET_TIER_SHARES[0]) - tierUsed[0]) +
        Math.max(0, Math.floor(cap * WORKING_SET_TIER_SHARES[1]) - tierUsed[1]);
      const t2Cap = Math.min(cap - used, t2Limit);
      const addT2 = (items: typeof eligible, localCap: number): void => {
        let localUsed = 0;
        for (const { claim } of items) {
          const id = claim.id; const group = historyFor.get(id);
          const line = claimLine(claim, 'current') + (group && group.length > 1 ? ` [history: memory.md#${historyAnchor(id)}]` : '');
          const n = tokens(countTokens, line);
          if (tokens(countTokens, [...output, ...selected.map(x => x.line), line].join('\n')) <= cap &&
              selectedTokens + n <= t2Cap && localUsed + n <= localCap) {
            selected.push({ id, line, n }); selectedTokens += n; localUsed += n;
          }
        }
      };
      // Reserve at most half of T2's fixed B8 share for changed-key winners, leaving
      // room for plain recency even when unused T0/T1 capacity flows down.
      addT2(groups[2], Math.floor(cap * WORKING_SET_TIER_SHARES[2] / 2));
      addT2(groups[3], t2Cap - selectedTokens);
      return selected;
    };
    const reserveFor = (selected: Array<{ id: string }>): number => {
      const inline = new Set([...t0Included, ...selected.map(x => x.id)]);
      return historyPointers.filter(p => !inline.has(p.id)).reduce((n, p) => n + tokens(countTokens, p.line), 0);
    };
    let tier2 = selectTier2(0);
    let pointerReserve = 0;
    for (let pass = 0; pass <= historyPointers.length; pass++) {
      const needed = reserveFor(tier2);
      if (needed <= pointerReserve) break;
      pointerReserve = needed;
      tier2 = selectTier2(pointerReserve);
    }
    for (const { id, line, n } of tier2) {
      output.push(line); used = tokens(countTokens, output.join('\n')); tierUsed[2] += n;
      included.push({ id, tier: 2, tokens: n });
    }
    const includedNow = new Set(included.map(x => x.id));
    for (const { claim } of [...groups[2], ...groups[3]]) if (!includedNow.has(claim.id)) excluded.set(claim.id, 'budget');
    const includedIds = new Set(included.map(x => x.id));
    for (const pointer of historyPointers) if (!includedIds.has(pointer.id)) {
      if (tokens(countTokens, [...output, pointer.line].join('\n')) <= cap) {
        output.push(pointer.line); used = tokens(countTokens, output.join('\n'));
      }
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
    return { text, receipt, renderedReconcileItems: reconcileItems.slice(0, 3).filter((item) => text.split('\n').includes(reconcilePromptText(item))), droppedReconcileItems };
  };
  const buildWorkingSet: BuildWorkingSetFn = (state, view, budget) => {
    const built = buildWorkingSetDetailed(state, view, budget);
    return { text: built.text, receipt: built.receipt };
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
      const grouped = new Set([...historyGroups(claims, state).values()].filter(group => group.length > 1).flatMap(group => group.map(c => c.id)));
      for (const rec of selectedRecords) {
        if (rec.t === 'claim' && rec.kind === 'lesson' && state.claims[rec.id]?.status === 'live' && !grouped.has(rec.id)) {
          lines.push(claimLine(rec, state.claims[rec.id].status));
        }
      }
      lines.push('', '## All claims (complete export)');
      const histories = historyGroups(claims, state);
      const ordered = [...histories.values()].map(group => group.slice().sort((a, b) => cmp(a.at || a.wt, b.at || b.wt) || cmp(a.wt, b.wt) || cmp(a.id, b.id)))
        .sort((a, b) => cmp(a.at(-1)?.at ?? a.at(-1)?.wt ?? '', b.at(-1)?.at ?? b.at(-1)?.wt ?? ''));
      for (const group of ordered) {
        const kept = group.filter(rec => !isExcluded(rec.id));
        if (!kept.length) continue;
        if (group.length === 1) {
          const rec = kept[0]; const status = state.claims[rec.id]?.status ?? 'live';
          if (!(rec.kind === 'lesson' && status === 'live')) lines.push(claimLine(rec, status));
          continue;
        }
        const current = historyCurrent(kept, state) ?? kept.at(-1)!;
        lines.push('', `### Claim history: ${current.key ?? current.id}`, `<a id="${historyAnchor(current.id)}"></a>`);
        for (const rec of kept) {
          const status = state.claims[rec.id]?.status ?? 'live';
          const label = rec.id === current.id ? 'CURRENT' : state.claims[rec.id]?.status === 'live' ? 'CONFLICT' : 'PRIOR';
          const [first, ...rest] = rec.text.split('\n');
          lines.push(`- ${label} — ${claimDate(rec)} — ${first} [status:${status}] [c:${rec.id}]`, ...rest.map(line => `  ${line}`));
        }
      }
      for (const rec of selectedRecords) if (rec.t === 'event') lines.push(`<!-- event:${rec.id} ${rec.ev} -->`);
    }
    return lines.join('\n') + '\n';
  };
  const renderExportLine: RenderExportLineFn = (rec, state) => rec.t === 'event'
    ? `<!-- event:${rec.id} ${rec.ev} -->`
    : `- ${JSON.stringify(rec.text)} [status:${state.claims[rec.id]?.status ?? 'live'}] [c:${rec.id}]`;
  return { buildWorkingSet, buildWorkingSetDetailed, renderMemoryMd, renderExportLine };
}
