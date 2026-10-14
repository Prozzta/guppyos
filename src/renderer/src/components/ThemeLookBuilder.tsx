import { useEffect, useRef } from 'react';
import { SpritePortrait } from './SpritePortrait';
import type { OfficeCharacterName } from '@/scene/office/cast';
import { LOOK_PARTS, type LookPart } from '@/scene/themes/manifest';
import { bodiesOf, pickBody, pickPreset, resolveLook, draftToLook, setColour, type LookDraft } from '@/scene/themes/looks';
import { lookColumn } from '@/scene/themes/lookArt';
import type { ThemeLooks } from '@/scene/themes/themeCatalog';

export interface ThemeLookBuilderProps {
  looks: ThemeLooks;
  draft: LookDraft;
  onChange: (d: LookDraft) => void;
  /** A premade was picked; `name` is its label (the caller decides whether to use it). */
  onPreset?: (name: string | undefined) => void;
  /** A stable Office-compatible fallback identity for the portrait API. */
  character: OfficeCharacterName;
  /** Whether the caller also presents an Office-character picker. */
  officeCharacterVisible?: boolean;
}

const label = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)', textTransform: 'uppercase' as const };
const chip = (active: boolean) => ({
  padding: 4, border: 'none', cursor: 'pointer',
  background: active ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
  boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
  display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 2,
});

/** The front frame of the draft, large: the live preview of the floor sprite. */
function FramePreview({ looks, draft, scale }: { looks: ThemeLooks; draft: LookDraft; scale: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { frameWidth: fw, frameHeight: fh, rows } = looks.sprite;
  const r = resolveLook(looks.builder, looks.columns, draftToLook(draft), '');
  const key = [r.body.id, r.colors.skin, r.colors.shirt, r.colors.hair].join('|');
  useEffect(() => {
    const g = ref.current?.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    g.drawImage(lookColumn(looks, r.body, r.colors), 0, rows.down * fh, fw, fh, 0, 0, fw * scale, fh * scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, looks, scale]);
  return <canvas ref={ref} width={fw * scale} height={fh * scale} style={{ width: fw * scale, height: fh * scale, imageRendering: 'pixelated' }} />;
}

/** The theme's character builder: body, colours, presets, with a live preview.
 *  Add and Edit save its draft the same way. */
export function ThemeLookBuilder({ looks, draft, onChange, onPreset, character, officeCharacterVisible = true }: ThemeLookBuilderProps) {
  const b = looks.builder, cols = looks.columns;
  const bodies = bodiesOf(b, cols);
  const body = bodies.find((x) => x.id === draft.bodyId) ?? bodies[0];
  const parts = LOOK_PARTS.filter((p) => body.parts?.[p]);
  const custom = b?.customColours !== false;
  const partLabel: Record<LookPart, string> = { skin: 'Skin', shirt: 'Shirt', hair: 'Hair' };

  return (
    <div data-look-builder={looks.themeId} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
      <div>
        <div style={label}>{`Look on ${looks.label}`}</div>
        <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
          {officeCharacterVisible ? 'Only this theme uses it. The Office character above is kept.' : 'Choose this agent’s TES look.'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }} aria-label="Preview">
          <FramePreview looks={looks} draft={draft} scale={3} />
          <SpritePortrait draft={draft} character={character} themeId={looks.themeId} scale={2} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: 1 }}>
          <div>
            <div style={label}>Body</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {bodies.map((x) => (
                <button key={x.id} type="button" style={chip(x.id === draft.bodyId)} aria-pressed={x.id === draft.bodyId}
                  onClick={() => onChange(pickBody(b, cols, draft, x.id))}>
                  <SpritePortrait draft={pickBody(b, cols, draft, x.id)} character={character} themeId={looks.themeId} scale={1.5} />
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{x.label}</span>
                </button>
              ))}
            </div>
          </div>
          {parts.length > 0 && (
            <div>
              <div style={label}>Colours</div>
              {parts.map((p) => {
                const sw = Object.entries(b?.swatches?.[p] ?? {});
                return (
                  <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    <span style={{ fontSize: 11, width: 44, color: 'var(--cth-ink-700)' }}>{partLabel[p]}</span>
                    {sw.map(([n, c]) => (
                      <button key={n} type="button" title={n} aria-label={`${partLabel[p]}: ${n}`} aria-pressed={draft.colors[p] === c}
                        onClick={() => onChange(setColour(b, cols, draft, p, c))}
                        style={{ width: 20, height: 20, border: 'none', cursor: 'pointer', background: c,
                          boxShadow: draft.colors[p] === c ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)' : 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                    ))}
                    {custom && (
                      <input type="color" aria-label={`${partLabel[p]}: Custom colour`} title="Custom colour"
                        value={/^#[0-9a-f]{6}$/i.test(draft.colors[p]) ? draft.colors[p] : '#000000'}
                        onChange={(e) => onChange(setColour(b, cols, draft, p, e.target.value))}
                        style={{ width: 28, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!!b?.presets?.length && (
            <div>
              <div style={label}>Presets</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {b.presets.map((p) => {
                  const picked = pickPreset(b, cols, draft, p.id);
                  return (
                    <button key={p.id} type="button" style={chip(draft.presetId === p.id)} aria-pressed={draft.presetId === p.id}
                      onClick={() => { onChange(picked.draft); onPreset?.(picked.name); }}>
                      <SpritePortrait draft={picked.draft} character={character} themeId={looks.themeId} scale={1.5} />
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{p.label ?? p.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
