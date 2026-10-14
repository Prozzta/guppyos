/**
 * Monaco bootstrap for the Electron renderer (electron-vite / Vite).
 *
 * Two things have to be true for Monaco to work in a bundled Electron app:
 *
 *  1. Workers must be SELF-HOSTED, not fetched from a CDN. We import each
 *     language worker through Vite's `?worker` suffix, which emits a real
 *     bundled worker chunk and a constructor. `MonacoEnvironment.getWorker`
 *     hands Monaco the right one per language. This is the electron-vite-safe
 *     equivalent of the classic `getWorkerUrl` CDN dance — it works offline and
 *     inside the packaged `app.asar` because the worker URL is resolved by Vite
 *     at build time (relative `base: './'`).
 *
 *  2. `@monaco-editor/react` must use THIS bundled `monaco` instance rather than
 *     its default behaviour of lazy-loading monaco from a CDN via AMD. We pin it
 *     with `loader.config({ monaco })`.
 *
 * Import this module once (for its side effects) before any editor mounts.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { subscribeUiTokens, uiPalette } from '@/design/uiTheme';
import { monacoPaletteColours } from '@/design/uiTokens';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  }
};

let themesDefined = false;

/** Register the CTH light/dark Monaco themes (idempotent), and re-register them when the UI tokens change. */
function defineThemes(m: typeof monaco): void {
  if (themesDefined) return;
  themesDefined = true;
  registerThemes(m);
  // A floor theme's tokens changed: redefine, then re-apply so open editors repaint.
  subscribeUiTokens(() => { registerThemes(m); m.editor.setTheme(CTH_MONACO_THEME); });
}

/** Light in both app themes, as before; ground, ink, gutter and selection come from the light UI palette. */
function registerThemes(m: typeof monaco): void {
  const c = monacoPaletteColours(uiPalette('light'));
  m.editor.defineTheme('cth-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: c.rules.foreground, background: c.rules.background },
      { token: 'comment', foreground: c.rules.comment, fontStyle: 'italic' },
      { token: 'keyword', foreground: '8B5CF6' },
      { token: 'string', foreground: '3FA45B' },
      { token: 'number', foreground: 'D94F4F' },
      { token: 'type', foreground: '2A9D94' },
      { token: 'function', foreground: 'C2603A' },
      { token: 'variable', foreground: c.rules.foreground },
      { token: 'delimiter', foreground: c.rules.delimiter }
    ],
    colors: {
      ...c.colors,
      'editorCursor.foreground': '#FF6B6B',
      'diffEditor.insertedTextBackground': '#6BCF7F33',
      'diffEditor.removedTextBackground': '#FF6B6B33',
      'diffEditor.insertedLineBackground': '#6BCF7F22',
      'diffEditor.removedLineBackground': '#FF6B6B22'
    }
  });
}

let configured = false;

/** Pin @monaco-editor/react to the bundled monaco + register themes. Idempotent. */
export function setupMonaco(): typeof monaco {
  if (!configured) {
    configured = true;
    loader.config({ monaco });
  }
  defineThemes(monaco);
  return monaco;
}

export const CTH_MONACO_THEME = 'cth-light';

/** Map a filename to a Monaco language id (used to set the model language). */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'md':
    case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'c':
    case 'h': return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp': return 'cpp';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'sh':
    case 'bash':
    case 'zsh': return 'shell';
    case 'html':
    case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'yml':
    case 'yaml': return 'yaml';
    case 'toml': return 'ini';
    case 'xml': return 'xml';
    case 'sql': return 'sql';
    case 'dockerfile': return 'dockerfile';
    default:
      if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
      return 'plaintext';
  }
}
