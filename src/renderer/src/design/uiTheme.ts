/**
 * Floor-theme UI tokens: a theme's colour overrides, applied app-wide.
 *
 * The renderer is styled through the `--cth-*` tokens (tokens.css), so a floor theme recolours the UI by overriding
 * them under a root attribute: this module stamps `data-floor-theme` on <html> and writes the theme's whitelisted
 * `uiTokens.light/dark` into one <style> element (see uiTokenCss). With no theme tokens it removes both, and Office
 * looks exactly as before. Layout, type and spacing tokens are never touched.
 *
 * xterm, Monaco and CodeMirror take literal colours, so they read the resolved palette through `uiPalette()` /
 * `useUiPalette()` and re-theme when it changes (same subscribable pattern as design/theme.ts).
 */
import { useSyncExternalStore } from 'react';
import {
  isFloorThemeId, resolveUiPalette, sanitizeUiTokens, uiTokenCss,
  type UiMode, type UiTokenName, type UiTokenOverrides
} from './uiTokens';

const STYLE_ID = 'cth-floor-ui-tokens';

let current: { themeId: string | null; overrides: UiTokenOverrides } = { themeId: null, overrides: {} };
let version = 0;
const subscribers = new Set<() => void>();

/**
 * Apply a floor theme's UI tokens (`uiTokens` from its manifest; unknown names and non-colour values are dropped).
 * Pass a null id, or no tokens, to go back to the Office values.
 */
export function applyFloorUiTokens(themeId: string | null, uiTokens?: unknown): void {
  const id = isFloorThemeId(themeId) ? themeId : null;
  const overrides = id ? sanitizeUiTokens(uiTokens) : {};
  const css = id ? uiTokenCss(id, overrides) : '';
  try {
    const root = document.documentElement;
    if (id) root.dataset.floorTheme = id; else delete root.dataset.floorTheme;
    let el = document.getElementById(STYLE_ID);
    if (css) {
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el); }
      if (el.textContent !== css) el.textContent = css;
    } else el?.remove();
  } catch { /* SSR/tests */ }
  const same = current.themeId === id && JSON.stringify(current.overrides) === JSON.stringify(overrides);
  current = { themeId: id, overrides };
  if (same) return;
  version++;
  subscribers.forEach((fn) => fn());
}

/**
 * Apply the active floor theme's UI tokens (ThemeConfig.uiTokens). A theme without them (Office and the TV themes)
 * clears any applied tokens and stamps nothing, so the app looks exactly as before. App.tsx calls this at boot and
 * whenever the active theme changes.
 */
export function applyThemeUiTokens(theme: { id: string; uiTokens?: unknown }): void {
  applyFloorUiTokens(theme.uiTokens ? theme.id : null, theme.uiTokens);
}

/** The floor theme whose UI tokens are applied, or null for Office. */
export function floorUiTheme(): string | null {
  return current.themeId;
}

const palettes = new Map<string, Record<UiTokenName, string>>();

/** The resolved palette for one mode: Office values with the applied theme's overrides on top. The same object until
 *  the tokens change, so it is safe as an effect/memo dependency. */
export function uiPalette(mode: UiMode): Record<UiTokenName, string> {
  const key = `${version}:${mode}`;
  let p = palettes.get(key);
  if (!p) { palettes.clear(); p = resolveUiPalette(mode, current.overrides); palettes.set(key, p); }
  return p;
}

export function subscribeUiTokens(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Re-renders when the applied UI tokens change; returns the palette for `mode`. */
export function useUiPalette(mode: UiMode): Record<UiTokenName, string> {
  useSyncExternalStore(subscribeUiTokens, () => version);
  return uiPalette(mode);
}
