/**
 * UI-FONTS-LOCAL: the release drop's faces, embedded so the drop makes no font request.
 *
 * The drop is a sandboxed srcdoc iframe with an opaque origin, so it cannot load the app's
 * bundled font files by URL; each face goes in as a data: URI instead (the frame's CSP
 * already allows `font-src data:`). The `?datauri` build plugin (electron.vite.config.ts,
 * fontDataUri) turns the upstream file, byte for byte, into `data:font/woff2;base64,...`.
 *
 * Same faces as the Google stylesheet the drop used to link: Geist 400/500/600 and
 * JetBrains Mono 400/500/600/700, one @font-face per weight, so a weight between them
 * (the drop's 620 and 680) still picks the nearest listed face as it did before.
 * Geist 1.9.2 (vercel/geist-font) and JetBrains Mono 2.304, both SIL OFL 1.1: see
 * assets/fonts/<family>/OFL.txt and assets/ATTRIBUTION.md.
 */
import geist400 from './assets/fonts/geist/Geist-Regular.woff2?datauri';
import geist500 from './assets/fonts/geist/Geist-Medium.woff2?datauri';
import geist600 from './assets/fonts/geist/Geist-SemiBold.woff2?datauri';
import jbm400 from './assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?datauri';
import jbm500 from './assets/fonts/jetbrains-mono/JetBrainsMono-Medium.woff2?datauri';
import jbm600 from './assets/fonts/jetbrains-mono/JetBrainsMono-SemiBold.woff2?datauri';
import jbm700 from './assets/fonts/jetbrains-mono/JetBrainsMono-Bold.woff2?datauri';
import { dropFontFaceCss, type DropFontFace } from '../../shared/releaseDrop';

export const DROP_FONT_FACES: readonly DropFontFace[] = [
  { family: 'Geist', weight: 400, dataUri: geist400 },
  { family: 'Geist', weight: 500, dataUri: geist500 },
  { family: 'Geist', weight: 600, dataUri: geist600 },
  { family: 'JetBrains Mono', weight: 400, dataUri: jbm400 },
  { family: 'JetBrains Mono', weight: 500, dataUri: jbm500 },
  { family: 'JetBrains Mono', weight: 600, dataUri: jbm600 },
  { family: 'JetBrains Mono', weight: 700, dataUri: jbm700 }
];

/** The @font-face block buildDropSrcDoc puts in the frame's head. */
export const DROP_FONT_CSS = dropFontFaceCss(DROP_FONT_FACES);
