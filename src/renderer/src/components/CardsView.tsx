/**
 * CARDS-TAB-190 — the Human's CARDS review tab: every tasks.json card as a readable card, in the
 * look of ASK ME (AskMeTab / HumanQuestionCard). It is where cards are READ, not a second kanban:
 * there is no write action here at all; answering an open ask stays on ASK ME.
 *
 * Each card: title, id, status, assignee (kept on done cards: the restorable roster resolves a
 * gone worker's name), priority, status age (state/task-meta.json), the latest result, parked /
 * waitingFor / fixVersion where set, the notes and results as one dated timeline (newest first),
 * and the full humanQA history through the shared read-only HumanQuestionCard. Markdown renders
 * through the same SafeMarkdown as ASK ME. Newest activity first; filters for status, assignee,
 * text, and a toggle for done cards. Long text and long timelines collapse behind "show more".
 *
 * This file is presentational and store-free (renderer tests render it); CardsTab.tsx feeds it
 * the kanban's own data (useHiveTasks): no new store, no second ledger reader.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { HumanQuestionCard, SafeMarkdown } from './HumanQuestionCard';
import { formatStamp } from './humanQuestion';
import { statusAgeText } from '@shared/agentBadges';
import {
  DEFAULT_FILTER, TIMELINE_SHOWN, collapsed, filterCards,
  type CardFilter, type CardStatus, type ReviewCard, type TimelineEntry
} from './cardsReview';

const STATUS_ACCENT: Record<CardStatus, string> = {
  todo: 'var(--cth-sky)', doing: 'var(--cth-lemon)', blocked: 'var(--cth-coral)', done: 'var(--cth-mint)'
};
const STATUS_LIGHT: Record<CardStatus, string> = {
  todo: 'var(--cth-sky-light)', doing: 'var(--cth-lemon-light)', blocked: 'var(--cth-coral-light, #f7d6cf)', done: 'var(--cth-mint-light)'
};

const small: CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' };
const linkBtn: CSSProperties = {
  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, alignSelf: 'flex-start',
  fontSize: 10, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)', textDecoration: 'underline'
};
const control: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: '3px 6px', border: 'none',
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-900)', minWidth: 0
};

function Tag({ children, bg, title }: { children: ReactNode; bg: string; title?: string }) {
  return (
    <span title={title} style={{
      fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', padding: '0 5px',
      background: bg, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', whiteSpace: 'nowrap'
    }}>{children}</span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-700)' }}>{children}</div>;
}

/** Markdown that collapses past COLLAPSE_CHARS, with its own "show more". */
function LongText({ text, onOpenLink }: { text: string; onOpenLink?: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const c = collapsed(text);
  return (
    <div data-long={c.cut ? (open ? 'open' : 'cut') : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <SafeMarkdown source={open ? text : c.text} onOpenLink={onOpenLink} />
      {c.cut && <button type="button" style={linkBtn} onClick={() => setOpen(!open)}>{open ? 'SHOW LESS' : 'SHOW MORE'}</button>}
    </div>
  );
}

function Timeline({ entries, now, onOpenLink }: { entries: TimelineEntry[]; now: Date; onOpenLink?: (href: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, TIMELINE_SHOWN);
  return (
    <div className="cth-cards-timeline" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>TIMELINE · {entries.length}</SectionLabel>
      {shown.map((e, i) => (
        <div key={i} data-entry={e.source} style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8, boxShadow: `inset 2px 0 0 ${e.source === 'result' ? 'var(--cth-mint)' : 'var(--cth-ink-100)'}` }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Tag bg={e.source === 'result' ? 'var(--cth-mint-light)' : 'var(--cth-paper-200)'}>{e.source === 'result' ? 'RESULT' : 'NOTE'}</Tag>
            <span style={small} title={e.at ?? undefined}>{e.at ? (formatStamp(e.at, now) ?? e.at) : 'undated'}</span>
          </span>
          <LongText text={e.text} onOpenLink={onOpenLink} />
        </div>
      ))}
      {entries.length > TIMELINE_SHOWN && (
        <button type="button" style={linkBtn} onClick={() => setAll(!all)}>
          {all ? 'SHOW LESS' : `SHOW ${entries.length - TIMELINE_SHOWN} MORE`}
        </button>
      )}
    </div>
  );
}

export function ReviewCardView({ card, assigneeName, now, onOpen, onOpenLink }: {
  card: ReviewCard;
  assigneeName?: string;
  now: Date;
  onOpen?: (id: string) => void;
  onOpenLink?: (href: string) => void;
}) {
  const age = statusAgeText(card.meta, now.getTime());
  return (
    <div className="cth-card-review" data-card={card.id} data-status={card.status} style={{
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'flex', flexDirection: 'column', minWidth: 0
    }}>
      {/* header: status stripe + title (opens the full task detail) */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', minWidth: 0,
        background: STATUS_LIGHT[card.status], boxShadow: `inset 4px 0 0 ${STATUS_ACCENT[card.status]}, inset 0 -1px 0 var(--cth-ink-700)`
      }}>
        <button
          type="button"
          onClick={() => onOpen?.(card.id)}
          title="open the full task detail"
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 0 0 4px', textAlign: 'left',
            fontFamily: 'var(--cth-font-mono)', fontSize: 15, color: 'var(--cth-ink-900)', flex: 1, minWidth: 0, overflowWrap: 'anywhere'
          }}
        >{card.title}</button>
      </div>

      <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        {/* facts: id, status, assignee, priority, age, and the wait fields where set */}
        <div className="cth-card-facts" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ ...small, fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-700)' }}>{card.id}</span>
          <Tag bg={STATUS_LIGHT[card.status]}>{card.status.toUpperCase()}</Tag>
          {assigneeName && <Tag bg="var(--cth-lilac-light, #ece2f5)" title={card.assignee}>{assigneeName.toUpperCase()}</Tag>}
          {card.priority && <Tag bg="var(--cth-paper-200)">{card.priority.toUpperCase()}</Tag>}
          {card.parked && <Tag bg="var(--cth-paper-200)">PARKED</Tag>}
          {card.waitingFor && <Tag bg="var(--cth-lemon-light)">WAITING FOR {card.waitingFor.toUpperCase()}</Tag>}
          {card.fixVersion && <Tag bg="var(--cth-sky-light)">FIX {card.fixVersion}</Tag>}
          {age && <span style={small} title="time in this status">{card.status} {age}</span>}
          {card.doneAt && <span style={small}>done {formatStamp(card.doneAt, now) ?? card.doneAt}</span>}
        </div>

        {card.result && (
          <div className="cth-card-result" style={{
            padding: '7px 9px', background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0
          }}>
            <SectionLabel>RESULT</SectionLabel>
            <LongText text={card.result} onOpenLink={onOpenLink} />
          </div>
        )}

        {card.description && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>DESCRIPTION</SectionLabel>
            <LongText text={card.description} onOpenLink={onOpenLink} />
          </div>
        )}

        {card.timeline.length > 0 && <Timeline entries={card.timeline} now={now} onOpenLink={onOpenLink} />}

        {card.humanQA.length > 0 && (
          <div className="cth-card-qa" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionLabel>ASKED THE HUMAN · {card.humanQA.length}</SectionLabel>
            {card.humanQA.map((e, i) => (
              <div key={i} style={{ paddingLeft: 8, boxShadow: 'inset 2px 0 0 var(--cth-lilac, #b9a3d6)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* read-only: no onAnswer, so the shared card renders no controls */}
                <HumanQuestionCard entry={e} now={now} onOpenLink={onOpenLink} />
                {e.dismissedAt && !e.a && <span style={small}>dismissed {formatStamp(e.dismissedAt, now) ?? e.dismissedAt}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The list with its filters. Presentational: the cards come in, nothing goes out but a click. */
export function CardsView({ cards, nameFor = () => undefined, now = new Date(), initialFilter = DEFAULT_FILTER, onOpen, onOpenLink }: {
  cards: ReviewCard[];
  nameFor?: (id?: string) => string | undefined;
  now?: Date;
  initialFilter?: CardFilter;
  onOpen?: (id: string) => void;
  onOpenLink?: (href: string) => void;
}) {
  const [f, setF] = useState<CardFilter>(initialFilter);
  const shown = filterCards(cards, f, nameFor);
  const assignees = [...new Set(cards.map((c) => c.assignee ?? ''))].sort((a, b) => (nameFor(a) ?? a).localeCompare(nameFor(b) ?? b));
  const doneCount = cards.filter((c) => c.status === 'done').length;
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      <div className="cth-cards-filters" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search" value={f.text} placeholder="search cards…" aria-label="search cards"
          onChange={(e) => setF({ ...f, text: e.target.value })}
          style={{ ...control, flex: '1 1 160px' }}
        />
        <select aria-label="status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as CardFilter['status'] })} style={control}>
          <option value="all">all statuses</option>
          <option value="todo">todo</option>
          <option value="doing">doing</option>
          <option value="blocked">blocked</option>
          <option value="done">done</option>
        </select>
        <select aria-label="assignee" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} style={{ ...control, maxWidth: 160 }}>
          <option value="all">everyone</option>
          {assignees.map((a) => <option key={a || '-'} value={a}>{a ? (nameFor(a) ?? a) : 'unassigned'}</option>)}
        </select>
        <label style={{ ...small, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={f.showDone} onChange={(e) => setF({ ...f, showDone: e.target.checked })} />
          done ({doneCount})
        </label>
      </div>
      <div style={small}>{shown.length} of {cards.length} cards · newest activity first</div>
      {shown.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          No card matches.{!f.showDone && f.status === 'all' && doneCount > 0 ? ' Done cards are hidden: tick "done" to include them.' : ''}
        </div>
      )}
      {shown.map((c) => (
        <ReviewCardView key={c.id} card={c} assigneeName={nameFor(c.assignee)} now={now} onOpen={onOpen} onOpenLink={onOpenLink} />
      ))}
    </div>
  );
}
