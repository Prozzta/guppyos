# Asset attribution

The office tilesets and Tiled maps in this directory are vendored from
[`shahar061/the-office`](https://github.com/shahar061/the-office) (project code: ISC).

## Pixel art from LimeZu (licensed)

The tilesets (`tilesets/*.png`) are from **Modern Interiors - RPG Tileset [16X16]** by
[LimeZu](https://limezu.itch.io/moderninteriors), used under the **Complete Version licence**
purchased on 2026-08-20 (see `tilesets/LIMEZUASSETS-LICENSE.txt`):

- ✅ May be **edited and used in any commercial or non-commercial project**.
- ❌ May not be resold, or edited and resold.
- ❌ May not be **distributed to others** as an asset. It ships only inside this app, drawn on the
  office floor; the tileset files must not be offered for download or reuse on their own.
- ⚠️ **Credits are required**, linking to <https://limezu.itch.io/>. This obligation is live.
  Today the credit lives in the repository README: the Asset licensing note under "License" and
  the LimeZu line under "Acknowledgements". The app itself has no about/credits surface that
  shows it yet. Removing the README credit breaks the licence.

The three bundled tilesets are `interiors.png`, `office-tileset.png` and
`a5-office-floors-walls.png`. Each one is imported by `scene/office/themeRegistry.ts` and actually
drawn on the office floor. Nothing else in this directory is LimeZu art.

## The Office cast is *not* LimeZu art

Every character, meaning the card portraits and the walking sprites on the office floor, is drawn
procedurally in [`scene/office/portraitArt.ts`](../scene/office/portraitArt.ts) from per-character
recipes. These are original, fully custom-drawn busts, not recolours of anyone else's sprites, and
they carry no third-party licence.

This was not always true. The cast was once recoloured from LimeZu's `Adam/Alex/Amelia/Bob` walk
sheets; those sheets were deleted on 2026-08-20 once nothing referenced them any more. If you are
reading old commits or an old copy of this file, that is the change you are looking at.

## Tiled map

`maps/office.tmj` and `maps/brooklyn99.tmj` are Tiled JSON maps built on the LimeZu tilesets
above. Both are imported by `themeRegistry.ts`; a map that nothing imports is not shipped, and
should be deleted rather than left to imply an asset is in use.

## Terminal font: Martian Mono

`fonts/martian-mono/` holds Martian Mono 1.1.0, Standard width, Regular and Bold
(`MartianMono-StdRg.woff2`, `MartianMono-StdBd.woff2`), taken unmodified from the official release
asset `martian-mono-1.1.0-woff2.zip` at https://github.com/evilmartians/mono (tag v1.1.0).
Copyright 2021 The Martian Mono Project Authors, licensed under the SIL Open Font License 1.1; the
licence text (`OFL.txt` from the repo at v1.1.0) ships beside the files as `fonts/martian-mono/OFL.txt`.
It is bundled so the terminal never fetches a font from the network (TERM-FONT-105); it is declared
in `design/fonts.css` and offered in the terminal's font selector (`components/terminalFont.ts`),
where JetBrains Mono is the default.

## UI monospace font: JetBrains Mono

`fonts/jetbrains-mono/` holds JetBrains Mono 2.304 (Regular, Medium, Bold as woff2), taken unmodified
from the official release at https://github.com/JetBrains/JetBrainsMono. Copyright 2020 The JetBrains
Mono Project Authors, licensed under the SIL Open Font License 1.1; the licence text ships beside the
files as `fonts/jetbrains-mono/OFL.txt`. It serves the UI's `--cth-font-mono` labels (`design/tokens.css`),
so they no longer need a font from the network (TERM-FONT-105); it is declared in `design/fonts.css`.
Its Regular and Bold are also the terminal's default face (`components/terminalFont.ts`).
SemiBold (`JetBrainsMono-SemiBold.woff2`, same release) was added for the release drop (UI-FONTS-LOCAL).

## UI font: Inter

`fonts/inter/` holds Inter 4.1, the static text cuts Regular, Medium, SemiBold and Bold
(`web/Inter-*.woff2`), taken unmodified from the official release asset `Inter-4.1.zip` at
https://github.com/rsms/inter (tag v4.1, zip SHA-256 9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e).
Copyright (c) 2016 The Inter Project Authors, licensed under the SIL Open Font License 1.1; the
licence text (the zip's `LICENSE.txt`, unmodified) ships beside the files as `fonts/inter/OFL.txt`.
It is the UI's `--cth-font-ui` face, bundled so the app never fetches it from Google Fonts
(UI-FONTS-LOCAL); it is declared in `design/fonts.css`.

## Brand display font: Press Start 2P

`fonts/press-start-2p/` holds Press Start 2P 3.000 (`PressStart2P-Regular.ttf`) and its `OFL.txt`,
taken unmodified from https://github.com/google/fonts at `ofl/pressstart2p/` (commit
dbd72d6ef9ebea750d33c02c7189633e972d6a40). Copyright 2012 The Press Start 2P Project Authors
(cody@zone38.net), with Reserved Font Name "Press Start 2P", licensed under the SIL Open Font
License 1.1. It is distributed unmodified under its own name, as the licence requires. It is the
UI's `--cth-font-display` face, bundled so the app never fetches it from Google Fonts
(UI-FONTS-LOCAL); it is declared in `design/fonts.css`.

## Release drop font: Geist

`fonts/geist/` holds Geist 1.9.2, Regular, Medium and SemiBold (`Geist/webfonts/Geist-*.woff2`), taken
unmodified from the official release asset `geist-font-v1.9.2.zip` at https://github.com/vercel/geist-font
(tag v1.9.2, zip SHA-256 15f066d58dcb99fb10014a49913009fdaf41e464cfb8851a44b44e593c95d3d8). Copyright 2026
The Geist Project Authors, licensed under the SIL Open Font License 1.1; the licence text (the zip's
`OFL.txt`) ships beside the files as `fonts/geist/OFL.txt`. It is the release drop's sans face, embedded
in the drop's frame as data: URIs (`dropFonts.ts`) so the drop never fetches it (UI-FONTS-LOCAL).

