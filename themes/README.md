# Theme packs

Each folder here that has a `theme.json` is a theme pack. It is bundled into
the app at build time (`src/renderer/src/scene/themes/packSources.ts`). A pack
is data only: a manifest, a Tiled map, its tilesets and pictures. It never
contains code. The built-in Office (`office`) is always available, and it is
what the floor shows whenever a pack cannot be used. The reason is logged and
shown in a note on the floor.

## theme.json

```jsonc
{
  "schema": 1,
  "id": "my-deck",              // lower-case a-z, 0-9 and "-", at most 40 characters; never "office"
  "label": "My Deck",
  "sceneKind": "stations",      // the host-vetted renderer that draws it
  "map": "deck.tmx",            // .tmx (external .tsx tilesets) or .tmj, a path inside the pack
  "palette": { "background": "#101418" },
  "stations": {
    "layer": "Stations",        // the object layer that holds the station points and the entrance
    "entrance": "Spawn",        // where people arrive
    "captain": "Bridge",        // optional: the orchestrator's station
    "seatOrder": ["Bridge", "Helm", "Chair1"],   // the fill order; stations not listed are never assigned
    "exclude": ["Coffee"],      // points in that layer that are not stations
    "seats": { "Chair1": { "facing": "up", "role": "ops" } }   // optional; facing else the point's map property, else down
  },
  "navigation": { "walkGrid": 4, "wanderZone": "wander", "zonesLayer": "zones" },
  "spriteRenderer": {
    "kind": "sheet", "sheet": "pictures/crew.png", "frameWidth": 32, "frameHeight": 32,
    "rows": { "down": 0, "up": 1, "left": 4, "right": 6, "sitDown": 2, "sitUp": 3, "sitLeft": 5, "sitRight": 7 }
  },
  "builder": {
    "bodies": [{ "id": "light", "label": "Light", "column": 0 }],
    "presets": [{ "id": "pilot", "label": "Pilot", "bodyId": "light", "seat": "Helm" }]   // seat: this preset's station first
  },
  "projectDefaults": { "orchestrator": { "name": "Lead", "appearance": { "bodyId": "light" } } }
}
```

## How stations are handed out

Every agent gets a station when it joins.

- The orchestrator takes `captain`.
- An agent made from a preset with a `seat` takes that seat. If a generic agent
  already holds it, that agent moves to the next free station in `seatOrder`
  and walks there.
- Everyone else takes the first free station in `seatOrder`, never the
  captain's.
- When every station is taken, an arriving agent waits and gets the first
  station that frees up.
- Busy agents sit at their station. Idle agents wander, but they never stop
  on a station.

## The map

The pack names the layers the engine needs. The rest follow Tiled's own
stacking:

| Layer | Treatment |
| --- | --- |
| `collision`, `collision-shapes` | Solid. Hiding the layer switches it off. |
| `Floor*`, `Walls*` | Off the floor is solid. A wall's drawn pixels are solid. |
| Tile layers named `rail`, lower or front walls, and tile layers above the first sorted object layer | Sorted with people row by row. |
| `below*` | Drawn under everyone. |
| `above*` | Drawn over everyone. |
| Other object layers | Sorted with people by their foot line. |

Tile objects can override their placement with the properties
`depth: below | above | sort` and `sortOffset`.
