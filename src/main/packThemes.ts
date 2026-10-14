/// <reference types="vite/client" />
// The bundled theme packs (themes/<dir>/theme.json) as project themes, so main accepts a pack id wherever it accepts a
// built-in one (the per-project theme map, the theme switch, a new project) and seeds a blank project from the pack's
// projectDefaults.orchestrator. Imported first by index.ts: registration runs before any config is read.
import { packThemeEntries, registerPackThemes } from '../shared/projectTheme';

const MANIFESTS = import.meta.glob('../../themes/*/theme.json', { eager: true, import: 'default' }) as Record<string, unknown>;

registerPackThemes(packThemeEntries(MANIFESTS));
