'use strict';
require('./tools/own-job.cjs');
/**
 * UI-FONTS-LOCAL (god 249216, 691c20): the UI's faces (Inter, Press Start 2P) and the release
 * drop's faces (Geist, JetBrains Mono) ship with the app, so nothing in it asks Google Fonts
 * for a font. Every file is the unmodified upstream release (sha256 pinned), with its OFL text.
 * The packaged probe (no fonts.googleapis/gstatic request at run time) is evidence beside this
 * suite; here the sources are pinned so the zero cannot quietly come back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const FONTS = path.join(RENDERER, 'src', 'assets', 'fonts');
const GOOGLE = /fonts\.(googleapis|gstatic)\.com/;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const { buildDropSrcDoc, dropFontFaceCss } = loadTs('src/shared/releaseDrop.ts');

/** dropFonts.ts as the build sees it: each `?datauri` import becomes the file's data: URI. */
function dropFacesFromSource() {
  const src = read(RENDERER, 'src', 'dropFonts.ts');
  const imports = Object.fromEntries([...src.matchAll(/^import (\w+) from '\.\/(assets\/fonts\/[^']+)\?datauri';$/gm)]
    .map(([, name, rel]) => [name, path.join(RENDERER, 'src', rel)]));
  const faces = [...src.matchAll(/\{ family: '([^']+)', weight: (\d+), dataUri: (\w+) \}/g)].map(([, family, weight, name]) => {
    assert.ok(imports[name], `${name} is a ?datauri import`);
    return { family, weight: Number(weight), file: imports[name],
      dataUri: `data:font/woff2;base64,${fs.readFileSync(imports[name]).toString('base64')}` };
  });
  assert.match(src, /export const DROP_FONT_CSS = dropFontFaceCss\(DROP_FONT_FACES\);/);
  return faces;
}

test('no source the app ships names fonts.googleapis.com or fonts.gstatic.com', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'assets') walk(p); continue; }
      if (/\.(ts|tsx|js|cjs|mjs|css|html|json)$/.test(e.name) && GOOGLE.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(hits, []);
});

test("index.html links no font stylesheet; its CSP allows fonts from 'self' and data: only, styles from 'self'", () => {
  const html = read(RENDERER, 'index.html');
  assert.doesNotMatch(html, GOOGLE);
  assert.doesNotMatch(html, /rel="(stylesheet|preconnect)"/);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  // data: because the release drop's srcdoc frame INHERITS this policy (a srcdoc document takes its
  // embedder's CSP), and its faces are data: URIs; without it the drop renders in fallback faces.
  assert.match(csp, /(^|; )font-src 'self' data:;/);
  assert.match(csp, /(^|; )style-src 'self' 'unsafe-inline';/);
});

test('fonts.css declares the UI faces locally, at the weights Google served (Inter 400-700, Press Start 2P 400)', () => {
  const css = read(RENDERER, 'src', 'design', 'fonts.css');
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  const want = [['Inter', 400, 'inter/Inter-Regular.woff2'], ['Inter', 500, 'inter/Inter-Medium.woff2'],
    ['Inter', 600, 'inter/Inter-SemiBold.woff2'], ['Inter', 700, 'inter/Inter-Bold.woff2'],
    ['Press Start 2P', 400, 'press-start-2p/PressStart2P-Regular.ttf']];
  for (const [family, weight, file] of want) {
    const f = faces.find((b) => b.includes(`font-family: "${family}";`) && b.includes(`font-weight: ${weight};`));
    assert.ok(f, `${family} ${weight}`);
    assert.equal(f.match(/url\('([^']+)'\)/)[1], `../assets/fonts/${file}`);
    assert.match(f, /font-display: swap;/, 'as Google\'s display=swap');
  }
  assert.equal(faces.filter((b) => /font-family: "(Inter|Press Start 2P)";/.test(b)).length, want.length);
  // Loaded before global.css, the same place the terminal face comes from.
  const main = read(RENDERER, 'src', 'main.tsx');
  assert.ok(main.includes("import './design/fonts.css'"));
});

test('every bundled face is the unmodified upstream file, with its OFL text and an ATTRIBUTION entry', () => {
  // sha256 of the files inside each upstream release (see ATTRIBUTION.md for the sources).
  const pinned = {
    inter: {
      'Inter-Regular.woff2': 'e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085',
      'Inter-Medium.woff2': '0ff3e94614e1493eb556314fd247ae6c4a85a7783b4cc86be539940cf83f2a48',
      'Inter-SemiBold.woff2': '5cb7103e4e605989afebc03d989c79201e54b21b5183db33981f70db9178a301',
      'Inter-Bold.woff2': 'fa888127b6da015b65569f0351f3b5c391ad928904951f1c20e9f8462a8d95ea',
      'OFL.txt': '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a'
    },
    'press-start-2p': {
      'PressStart2P-Regular.ttf': '034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d',
      'OFL.txt': '705960c3281a5765ecc0b59bd4ed7ca59eed165748076bc2fc3e8fdbfeb944b0'
    },
    geist: {
      'Geist-Regular.woff2': '9b2554b1bab7a16b7e592f24a2928776ee337c1038739f6d09be95e16afcd5aa',
      'Geist-Medium.woff2': '5f0af5c55a6853b550e5b70bac054fb70aca977a1d7a3195f5c6953b6b19d553',
      'Geist-SemiBold.woff2': 'adde6a779fb07a4fd4b52bc93d61cdcc8e3a466e6216de8ba7a84ff93fe02068',
      'OFL.txt': '021caa749f89fecd7c2e40a50499de29e84d2bc19251659b47d499c2fbfffc17'
    },
    'jetbrains-mono': {
      'JetBrainsMono-Regular.woff2': 'a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2',
      'JetBrainsMono-Medium.woff2': '086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353',
      'JetBrainsMono-SemiBold.woff2': '918edad542a1da608fd2ba8daebaff9ac802309103fe760eed465b8b4e47faf1',
      'JetBrainsMono-Bold.woff2': 'c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2'
    }
  };
  for (const [dir, files] of Object.entries(pinned)) {
    for (const [f, want] of Object.entries(files)) assert.equal(sha(fs.readFileSync(path.join(FONTS, dir, f))), want, `${dir}/${f}`);
    const listed = fs.readdirSync(path.join(FONTS, dir)).sort();
    assert.deepEqual(listed, [...new Set([...Object.keys(files), 'OFL.txt'])].sort(), dir);
  }
  assert.match(read(FONTS, 'inter', 'OFL.txt'), /^Copyright \(c\) 2016 The Inter Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read(FONTS, 'press-start-2p', 'OFL.txt'), /^Copyright 2012 The Press Start 2P Project Authors[\s\S]*Reserved Font Name "Press Start 2P"[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read(FONTS, 'geist', 'OFL.txt'), /^Copyright 2026 The Geist Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
  const attr = read(RENDERER, 'src', 'assets', 'ATTRIBUTION.md');
  assert.match(attr, /## UI font: Inter[\s\S]*Inter 4\.1[\s\S]*rsms\/inter[\s\S]*SIL Open Font License 1\.1/);
  assert.match(attr, /## Brand display font: Press Start 2P[\s\S]*3\.000[\s\S]*google\/fonts[\s\S]*SIL Open Font[\s\S]*License 1\.1/);
  assert.match(attr, /## Release drop font: Geist[\s\S]*1\.9\.2[\s\S]*vercel\/geist-font[\s\S]*SIL Open Font License 1\.1/);
  assert.match(attr, /JetBrainsMono-SemiBold\.woff2/);
});

test('the release drop embeds its faces: Geist 400/500/600 and JetBrains Mono 400-700, as Google served them', () => {
  const faces = dropFacesFromSource();
  assert.deepEqual(faces.map((f) => `${f.family} ${f.weight}`), [
    'Geist 400', 'Geist 500', 'Geist 600',
    'JetBrains Mono 400', 'JetBrains Mono 500', 'JetBrains Mono 600', 'JetBrains Mono 700'
  ]);
  const doc = buildDropSrcDoc('<h1>Launch</h1>', dropFontFaceCss(faces));
  assert.doesNotMatch(doc, GOOGLE, 'the srcdoc names no Google host');
  assert.doesNotMatch(doc, /<link\b/i, 'the frame links nothing');
  const rules = [...doc.matchAll(/@font-face \{ font-family: "([^"]+)"; font-style: normal; font-weight: (\d+); font-display: swap; src: url\(data:font\/woff2;base64,([A-Za-z0-9+/]+=*)\) format\("woff2"\); \}/g)];
  assert.equal(rules.length, faces.length);
  for (const [i, [, family, weight, b64]] of rules.entries()) {
    assert.equal(`${family} ${weight}`, `${faces[i].family} ${faces[i].weight}`);
    assert.equal(sha(Buffer.from(b64, 'base64')), sha(fs.readFileSync(faces[i].file)), 'byte-identical to the bundled file');
  }
  // Faces sit before the frame's own CSS, which names them in --font-sans / --font-mono.
  assert.ok(doc.indexOf('@font-face') < doc.indexOf('--font-mono: "JetBrains Mono"'));
  assert.match(doc, /--font-sans: "Geist"/);
  const csp = doc.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(csp, /font-src [^;]*data:/, 'the CSP admits the data: faces');
});

test('a face that is not an inline woff2 data: URI throws instead of rendering in a fallback', () => {
  for (const dataUri of ['', '/assets/Geist-Regular-abc123.woff2', 'https://fonts.gstatic.com/s/geist/v5/x.woff2', 'data:font/ttf;base64,AAAA']) {
    assert.throws(() => dropFontFaceCss([{ family: 'Geist', weight: 400, dataUri }]), /not an inline woff2 data: URI/, dataUri || '(empty)');
  }
});

test('the ?datauri build plugin inlines woff2 faces and is wired into the renderer build', () => {
  const cfg = read(ROOT, 'electron.vite.config.ts');
  assert.match(cfg, /function fontDataUri\(\)/);
  assert.match(cfg, /plugins: \[react\(\), fontDataUri\(\)\]/);
  assert.match(cfg, /enforce: 'pre'/, 'runs before vite:asset, which would emit a URL');
  assert.match(read(RENDERER, 'src', 'fontDataUri.d.ts'), /declare module '\*\.woff2\?datauri'/);
});

test('ReleaseDrop builds the frame with the embedded faces', () => {
  const tsx = read(RENDERER, 'src', 'components', 'ReleaseDrop.tsx');
  assert.match(tsx, /import \{ DROP_FONT_CSS \} from '\.\.\/dropFonts';/);
  assert.match(tsx, /buildDropSrcDoc\(html, DROP_FONT_CSS\)/);
});
