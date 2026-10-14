/// <reference types="vite/client" />
// The bundled theme packs (themes/<dir>/theme.json) as project themes, so main accepts a pack id wherever it accepts a
// built-in one (the per-project theme map, the theme switch, a new project) and seeds a blank project from the pack's
// projectDefaults.orchestrator. Imported first by index.ts: registration runs before any config is read. Only packs the
// renderer would accept are registered (validatedPackThemeEntries: the renderer's validateManifest).
import { registerPackThemes } from '../shared/projectTheme';
import { validatedPackThemeEntries } from './packThemeEntries';

const MANIFESTS = import.meta.glob('../../themes/*/theme.json', { eager: true, import: 'default' }) as Record<string, unknown>;

registerPackThemes(validatedPackThemeEntries(MANIFESTS));
