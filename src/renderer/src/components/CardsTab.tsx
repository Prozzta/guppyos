/**
 * CARDS-TAB-190: the CARDS tab in the Command Center. The view (CardsView.tsx) is read-only and
 * store-free; this wrapper feeds it the kanban's own data hook and the roster names.
 */
import { useStore } from '@/store/store';
import { useHiveTasks } from './TasksKanban';
import { rawById, reviewCards } from './cardsReview';
import { CardsView } from './CardsView';

export function CardsTab() {
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const { tasks, raw, meta } = useHiveTasks();
  // A done card keeps its author: the restorable roster names a worker whose terminal is gone.
  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;
  return <CardsView cards={reviewCards(tasks, rawById(raw), meta)} nameFor={nameFor} onOpen={openTaskDetail} />;
}
