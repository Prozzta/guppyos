/**
 * CARDS-TAB-190: the CARDS tab in the Command Center. The view (CardsView.tsx) is read-only and
 * store-free; this wrapper feeds it the kanban's own data hook and the roster names.
 *
 * Jim MUST 2: the model is memoised on the raw ledger and the status ages, which useHiveTasks
 * only replaces when a poll brought different content; the roster names come in as a string
 * key, so an agent's status tick does not rebuild nameFor (and with it every card).
 */
import { useCallback, useMemo } from 'react';
import { useStore } from '@/store/store';
import { parseTasks, useHiveTasks } from './TasksKanban';
import { rawById, reviewCards } from './cardsReview';
import { CardsView } from './CardsView';

const nameKey = (list: { id: string; name: string }[]): string => list.map((a) => `${a.id}\t${a.name}`).join('\n');

export function CardsTab() {
  const agentNames = useStore((s) => nameKey(s.agents));
  const restorableNames = useStore((s) => nameKey(s.restorableAgents));
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const { raw, meta } = useHiveTasks();
  const cards = useMemo(() => reviewCards(parseTasks(raw), rawById(raw), meta), [raw, meta]);
  // A done card keeps its author: the restorable roster names a worker whose terminal is gone.
  const nameFor = useMemo(() => {
    const names = new Map<string, string>();
    for (const key of [restorableNames, agentNames]) { // live agents win over restorable ones
      for (const line of key ? key.split('\n') : []) {
        const [id, name] = line.split('\t');
        if (id && name) names.set(id, name);
      }
    }
    return (id?: string): string | undefined => (id ? names.get(id) ?? id : undefined);
  }, [agentNames, restorableNames]);
  // SHOULD 1 (god's ruling b): the detail opens read-only from here, with no move or assign.
  const onOpen = useCallback((id: string) => openTaskDetail(id, { readOnly: true }), [openTaskDetail]);
  const onOpenAskMe = useCallback(() => requestCommandCenterTab('human'), [requestCommandCenterTab]);
  return <CardsView cards={cards} nameFor={nameFor} onOpen={onOpen} onOpenAskMe={onOpenAskMe} />;
}
