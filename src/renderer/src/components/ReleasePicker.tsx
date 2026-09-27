/**
 * Choose WHICH newer release to install.
 *
 * The updater used to name exactly one version, the latest, so someone two
 * releases behind never saw the one in between and could not pick it. The
 * status now carries every newer release (`versions`, newest first). This is
 * the drop-down both the title-bar badge and Settings → Updates render, with
 * the latest preselected and the digest of the SELECTED release's notes under
 * it, so the choice is made knowing what each version brings.
 *
 * Controlled: the parent owns the selected version, because what its buttons
 * do (native download vs. installer link) depends on it.
 */
import { useMemo } from 'react';
import { summarizeReleaseNotes } from '@shared/releaseNotes';
import type { ReleaseOption } from '@shared/updateState';

export function ReleasePicker({
  choices,
  selected,
  onSelect,
  onOpenRelease
}: {
  choices: ReleaseOption[];
  selected: string;
  onSelect: (version: string) => void;
  onOpenRelease?: (url: string) => void;
}) {
  const option = choices.find((c) => c.version === selected) ?? choices[0];
  const notes = useMemo(() => summarizeReleaseNotes(option?.notes), [option?.notes]);
  if (!option) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cth-ink-700)' }}>
        <span>Version</span>
        <select
          aria-label="Version to install"
          value={option.version}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12,
            padding: '2px 4px', background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
            border: '1px solid var(--cth-ink-300)', borderRadius: 2
          }}
        >
          {choices.map((c, i) => (
            <option key={c.version} value={c.version}>
              v{c.version}{i === 0 ? ' (latest)' : ''}
            </option>
          ))}
        </select>
        {onOpenRelease && (
          <a
            href={option.url}
            onClick={(e) => { e.preventDefault(); onOpenRelease(option.url); }}
            style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}
          >
            view release
          </a>
        )}
      </label>
      {notes.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {notes.map((line, i) => (
            <li key={i} style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              <span aria-hidden style={{ color: 'var(--cth-ink-300)' }}>•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No release notes for v{option.version}.</span>
      )}
    </div>
  );
}
