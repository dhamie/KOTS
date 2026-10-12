# The city map

## Editing the map
The whole city is one character grid in `packages/content/src/map/grid.ts`. North is up; it's drawn isometrically.

| Character | Meaning |
|---|---|
| `A`–`Z` | A territory: its `code` in `packages/content/src/map/territories.ts` |
| `~` | Water |
| `=` | Bridge. Each connected run is named in `BRIDGES` by any one of its tiles |

To add or reshape a territory:
1. Edit the grid.
2. Add or edit its entry in `TERRITORIES`. That entry holds its code, slug, name, district, kind, base income and upkeep, and description.
3. Run `npm test`. The map checks will fail if:
   - a character is unknown or the grid isn't rectangular;
   - a territory is split into pieces or has fewer than 6 tiles;
   - a district can't be reached over land or bridges;
   - a bridge doesn't join two districts;
   - the map's edge isn't water.
4. Run `npm run db:seed`. It upserts districts and territories by slug and never touches ownership. It reports territories that are in the database but no longer in content, and doesn't delete them, because they may be owned.

Never rename a slug once it's live: slugs are the public IDs used in the API and in `#t=<slug>` links.

Real Lagos places are setting only. All organisations, people and events in the game are fictional.

## How it's drawn (`apps/client/src/map/`)
- **What the client and server each provide:** the client draws shapes and positions straight from `packages/content`. The API sends only state that changes: `GET /api/map/districts` (counts) and `GET /api/map/territories?district=` (owners). The client fetches districts as they come into view (`mapData.ts`) and refetches after 60 s.
- **Static layers are baked once.** Water, ground, borders, bridges and blocks go into a texture at load (`bakeStaticLayers`), plus a half-size copy that's drawn when zoomed out below 0.75×. Drawing thousands of vector shapes every frame was the bottleneck. Sampling a large texture far below its size was the other one, and the half-size copy acts as a two-level mipmap that fixes it.
- **Frame rate:** 60 FPS while you interact or the camera moves, and 12 FPS when idle, which is enough for the water shimmer. Frame-rate changes are applied outside the game loop. Calling Phaser's `setFPSLimit` from inside a frame leaves two loops running (see `queueFpsChange`).
- **Zoom levels:**
  - **City zoom:** one marker per district.
  - **Above 1.6× the fit-to-screen zoom:** one marker per territory, with an icon letter by kind.
  - **Territory names:** shown from camera zoom 0.5.

  Markers and labels keep a constant size on screen.
- **React and Phaser communicate through `bus.ts`.** React never draws the map, and Phaser never fetches data.
- **Test hook:** `window.__lagosMap` is a read-only hook used by the browser tests. It reports the mode, zoom, selection, loop step count and marker screen positions.

## Measured (software-rendered Chromium in the Playwright container, 1280×720)
| Version | Map ready | Idle frame rate |
|---|---|---|
| First baked version (one full-size texture) | 16.1 s | 1.6 FPS |
| Two-level texture + idle throttle | 4.5 s | 14.5 FPS (an empty Phaser scene: 18) |

These are a worst case on a CPU-only renderer. Performance on real GPUs and phones hasn't been measured yet; that's Phase 10.
