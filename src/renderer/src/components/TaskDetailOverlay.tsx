import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { useStore, selectAgentNameKey, agentNameOf } from '@/store/store';
import { TaskDetail, parseTasks, type HiveTask } from './TasksKanban';

/**
 * App-wide host for the task detail: whoever calls store.openTaskDetail(id) —
 * a kanban card, the sticky note on an agent's strip card, a floor prop —
 * gets the SAME big overlay rendered over the office floor. Keeps its own
 * 5s ledger poll so an open detail stays fresh while the god edits cards.
 */

const POLL_MS = 5000;

// APP-SHALLOW-SELECTOR: memo so an App render (roster change) does not re-render this
// subtree; it subscribes to the store slices it needs itself.
export const TaskDetailOverlay = memo(function TaskDetailOverlay() {
  const taskDetailId = useStore((s) => s.taskDetailId);
  const closeTaskDetail = useStore((s) => s.closeTaskDetail);
  // CARDS-TAB-190: opened from CARDS (read-only), the detail gets no move or assign.
  const readOnly = useStore((s) => s.taskDetailReadOnly);
  // PERF-151-NITS: only names are read here, and only while a detail is open; a status/progress
  // tick on any agent (or anything at all while closed) no longer re-renders the overlay.
  useStore((s) => (taskDetailId ? selectAgentNameKey(s) : ''));
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    // parseTasks NORMALIZES (the ledger is a hand-written file; cards may lack
    // dependsOn/priority/etc.) — a raw card without dependsOn crashed the
    // detail once. Never feed TaskDetail unparsed ledger entries.
    // TASKS-JSON-SPLIT: a card opened from the board's ARCHIVED view is not on hot tasks.json;
    // only then is the archive read as well.
    try {
      let list = parseTasks(await window.cth.hiveTasks());
      if (taskDetailId && !list.some((t) => t.id === taskDetailId)) list = parseTasks(await window.cth.hiveAllTasks());
      setTasks(list);
    } catch { /* keep last good */ }
  }, [taskDetailId]);

  useEffect(() => {
    if (!taskDetailId) return;
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [taskDetailId, refresh]);

  if (!taskDetailId) return null;
  const task = tasks.find((t) => t.id === taskDetailId);
  if (!task) return null;

  const nameFor = (id?: string): string | undefined =>
    id ? (agentNameOf(id) ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  // Moving a card writes ONE field. Operate on the RAW ledger (the same pattern
  // as TasksKanban.dismissTask), never on the display-parsed state: parseTasks
  // NORMALIZES, so re-serializing it turns a hand-written `priority: "high"`
  // into the number 3 and grafts `dependsOn: []` onto a card that spells the key
  // `deps`. Those are real values, so they survive the merge in hive.writeTasks
  // and land on disk — a status change quietly rewriting the god's cards.
  const move = async (status: HiveTask['status']) => {
    const next = tasks.map((t) => (t.id === task.id ? { ...t, status } : t));
    setTasks(next); // optimistic
    try {
      const result = await window.cth.hivePatchTask(task.id, { status });
      if (!result.ok) void refresh();
    } catch { void refresh(); }
  };

  const assign = () => {
    // Route through the Command Center's dispatch box (which mails the god —
    // the human never writes into a worker's inbox directly).
    const st = useStore.getState();
    const god = st.agents.find((a) => a.isGod);
    if (god) st.select(god.id);
    const desc = task.description?.trim() ? task.description.trim() : '(no description)';
    st.requestDispatchSeed(`Task: ${task.title}\nContext: ${desc}\n`);
    st.requestCommandCenterTab('floor');
    closeTaskDetail();
  };

  return (
    <TaskDetail
      task={task}
      all={tasks}
      assigneeName={nameFor(task.assignee)}
      {...(readOnly ? {} : { onMove: (s: HiveTask['status']) => void move(s), onAssign: assign })}
      onClose={closeTaskDetail}
    />
  );
});
