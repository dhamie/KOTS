import { BRIDGE, CITY, TERRITORY_KINDS, WATER, neighbours, type TerritoryKind, type TerritoryLayout } from "@kots/content";
import { createRng, nextInt } from "@kots/rules";
import type { TerritoryState } from "@kots/shared";
import Phaser from "phaser";
import { mapBus } from "./bus";
import { districtsInView, markerMode, TILE_H, TILE_W, tileBoundsToWorld, tileCentre, tileToWorld, type MarkerMode, type Point, type Rect } from "./iso";
import { familyColour, KIND_STYLE, PALETTE, shade } from "./palette";

const HALF_W = TILE_W / 2;
const HALF_H = TILE_H / 2;
/** Pointer travel (screen px) beyond which a press is a drag rather than a click. */
const DRAG_THRESHOLD = 6;
const MAX_ZOOM = 2;
const FOCUS_MS = 600;
/** Open water drawn beyond the grid, in tiles, so the city doesn't end at a hard edge. */
const WATER_MARGIN = 6;
/** Room above the top row for block heights, in world px. */
const BLOCK_HEADROOM = 40;
/** Static layers are baked at world resolution: sharp enough up to MAX_ZOOM, and ~20 MB rather than ~30 MB at 1.25×. */
const BAKE_SCALE = 1;
/** Frame rate while nothing is moving: enough for the water shimmer, a fraction of the cost of 60 FPS. */
const IDLE_FPS = 12;
/** How long after the last interaction or camera movement the map stays at full frame rate. */
const ACTIVE_MS = 1500;
/** Below this camera zoom the half-resolution copy of the static layers is drawn (a two-level mipmap). */
const LOD_ZOOM = 0.75;
/** Territory names show only from this camera zoom, when tiles are big enough on screen to fit them. */
const LABEL_ZOOM = 0.5;

type Edge = [Point, Point];

/** The four corners of a tile's diamond, from its top corner. */
function corners(tx: number, ty: number) {
  const p = tileToWorld(tx, ty);
  return {
    top: p,
    right: { x: p.x + HALF_W, y: p.y + HALF_H },
    bottom: { x: p.x, y: p.y + TILE_H },
    left: { x: p.x - HALF_W, y: p.y + HALF_H },
  };
}

/** The diamond edge a tile shares with its neighbour in direction i of `neighbours()` (east, west, south, north). */
function sharedEdge(tx: number, ty: number, i: number): Edge {
  const c = corners(tx, ty);
  return ([[c.right, c.bottom], [c.top, c.left], [c.bottom, c.left], [c.top, c.right]] as Edge[])[i]!;
}

/** Draws world-space shapes into a Graphics positioned for baking: offset to `area` and scaled. */
class Painter {
  constructor(
    readonly g: Phaser.GameObjects.Graphics,
    readonly area: Rect,
    readonly scale: number,
  ) {}

  private v(p: Point): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2((p.x - this.area.x) * this.scale, (p.y - this.area.y) * this.scale);
  }

  poly(points: Point[], colour: number, alpha = 1): void {
    this.g.fillStyle(colour, alpha);
    this.g.fillPoints(points.map((p) => this.v(p)), true);
  }

  tile(tx: number, ty: number, colour: number, inset = 1): void {
    const c = tileCentre(tx, ty);
    this.poly(
      [
        { x: c.x, y: c.y - HALF_H * inset },
        { x: c.x + HALF_W * inset, y: c.y },
        { x: c.x, y: c.y + HALF_H * inset },
        { x: c.x - HALF_W * inset, y: c.y },
      ],
      colour,
    );
  }

  line(a: Point, b: Point, width: number, colour: number, alpha: number): void {
    const va = this.v(a);
    const vb = this.v(b);
    this.g.lineStyle(width * this.scale, colour, alpha);
    this.g.lineBetween(va.x, va.y, vb.x, vb.y);
  }
}

const cellAt = (x: number, y: number): string => CITY.cells[y]?.[x] ?? WATER;
const isLand = (cell: string) => cell !== WATER && cell !== BRIDGE;
const districtOf = (cell: string) => CITY.territories.get(cell)?.district;

/** City view and district view of the map. Reads state from the bus; never fetches. */
export class CityScene extends Phaser.Scene {
  private fitZoom = 1;
  private world!: Rect;
  private mode: MarkerMode = "districts";
  private lastZoom = -1;
  private lastViewKey = "";
  private selected: string | null = null;
  private filter: ReadonlySet<TerritoryKind> = new Set(TERRITORY_KINDS);
  private states: ReadonlyMap<string, TerritoryState> = new Map();

  private territoryMarkers = new Map<string, { container: Phaser.GameObjects.Container; disc: Phaser.GameObjects.Arc }>();
  private territoryLabels = new Map<string, Phaser.GameObjects.Text>();
  private districtMarkers = new Map<string, Phaser.GameObjects.Container>();
  private districtLabels: Phaser.GameObjects.Text[] = [];
  private bridgeLabels: Phaser.GameObjects.Text[] = [];
  private highlight!: Phaser.GameObjects.Graphics;
  private staticHigh!: Phaser.GameObjects.Image;
  private staticLow!: Phaser.GameObjects.Image;
  private pulse?: Phaser.Tweens.Tween;

  private press: { x: number; y: number; moved: boolean } | null = null;
  private activeUntil = 0;
  private throttled = false;
  private fpsChangeQueued = false;
  private torn = false;
  private pinchDistance: number | null = null;
  private unsubscribe: (() => void)[] = [];

  constructor() {
    super("city");
  }

  create(): void {
    this.bakeStaticLayers();
    this.highlight = this.add.graphics().setDepth(4);
    this.createLabels();
    this.placeLabels();
    this.createMarkers();
    this.setUpCamera();
    this.setUpInput();

    this.unsubscribe.push(
      ...(["territory:select", "map:focus", "territories:state", "markers:filter"] as const).map((e) => mapBus.on(e, () => this.wake())),
      mapBus.on("territory:select", (sel) => this.select(sel?.slug ?? null)),
      mapBus.on("map:focus", (f) => (f.kind === "territory" ? this.focusTerritory(f.slug) : this.focusDistrict(f.slug))),
      mapBus.on("territories:state", (states) => {
        this.states = states;
        this.refreshMarkers();
      }),
      mapBus.on("markers:filter", (kinds) => {
        this.filter = kinds;
        this.applyMode();
      }),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
    this.applyMode();
    this.exposeTestHook();
    mapBus.emit("map:ready", undefined);
  }

  override update(): void {
    const cam = this.cameras.main;
    if (cam.panEffect.isRunning || cam.zoomEffect.isRunning) this.wake();
    else if (!this.throttled && performance.now() > this.activeUntil) {
      this.throttled = true;
      this.queueFpsChange();
    }
    if (cam.zoom !== this.lastZoom) {
      this.lastZoom = cam.zoom;
      // Markers and labels keep a constant on-screen size.
      const s = 1 / cam.zoom;
      for (const m of this.territoryMarkers.values()) m.container.setScale(s * (m.container.getData("pulse") ?? 1));
      for (const m of this.districtMarkers.values()) m.setScale(s);
      for (const t of [...this.territoryLabels.values(), ...this.districtLabels, ...this.bridgeLabels]) t.setScale(s);
      this.staticLow.setVisible(cam.zoom < LOD_ZOOM);
      this.staticHigh.setVisible(cam.zoom >= LOD_ZOOM);
      this.mode = markerMode(cam.zoom, this.fitZoom);
      this.applyMode();
    }
    this.clampCamera();
    const view = cam.worldView;
    const districts = districtsInView(CITY, { x: view.x, y: view.y, width: view.width, height: view.height });
    const key = `${this.mode}|${districts.join(",")}`;
    if (key !== this.lastViewKey) {
      this.lastViewKey = key;
      mapBus.emit("viewport:changed", { districts, mode: this.mode });
    }
  }

  /** Back to full frame rate for a while (input, camera movement, new state). */
  private wake(): void {
    this.activeUntil = performance.now() + ACTIVE_MS;
    if (this.throttled) {
      this.throttled = false;
      this.queueFpsChange();
    }
  }

  /**
   * Applies the frame-rate limit outside the game loop. Phaser's setFPSLimit restarts the requestAnimationFrame
   * loop; called from inside a frame, the old loop also schedules its next frame, leaving two loops running.
   */
  private queueFpsChange(): void {
    if (this.fpsChangeQueued) return;
    this.fpsChangeQueued = true;
    setTimeout(() => {
      this.fpsChangeQueued = false;
      if (this.torn) return;
      const limit = this.throttled ? IDLE_FPS : 0;
      if (this.game.loop.fpsLimit !== limit) this.game.loop.setFPSLimit(limit);
    }, 0);
  }

  // ── Drawing (once) ───────────────────────────────────────────────────────

  /** Fills a tile's diamond (world coordinates). Used for the live highlight layer. */
  private fillTile(g: Phaser.GameObjects.Graphics, tx: number, ty: number, colour: number, inset = 1, alpha = 1): void {
    const c = tileCentre(tx, ty);
    g.fillStyle(colour, alpha);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(c.x, c.y - HALF_H * inset),
        new Phaser.Math.Vector2(c.x + HALF_W * inset, c.y),
        new Phaser.Math.Vector2(c.x, c.y + HALF_H * inset),
        new Phaser.Math.Vector2(c.x - HALF_W * inset, c.y),
      ],
      true,
    );
  }

  /**
   * Draws everything that never changes (water, ground, borders, bridges, blocks) once into textures.
   * Thousands of vector shapes would otherwise be re-processed every frame.
   */
  private bakeStaticLayers(): void {
    const area = tileBoundsToWorld({ minX: -WATER_MARGIN, minY: -WATER_MARGIN, maxX: CITY.width - 1 + WATER_MARGIN, maxY: CITY.height - 1 + WATER_MARGIN });
    area.y -= BLOCK_HEADROOM;
    area.height += BLOCK_HEADROOM;
    const maxTexture = this.renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer ? this.renderer.getMaxTextureSize() : 4096;
    const scale = Math.min(BAKE_SCALE, (maxTexture - 2) / area.width, (maxTexture - 2) / area.height);
    const p = new Painter(this.add.graphics(), area, scale);

    this.paintWater(p);
    this.paintGround(p);
    this.paintBridges(p);
    this.paintBlocks(p);
    this.paintBorders(p);
    this.staticHigh = this.bake(p, "city-static").setDepth(1);
    // Zoomed out, sampling the full-size texture is slow (and shimmers); a half-size copy is drawn instead.
    this.staticLow = this.downsample("city-static", "city-static-low", p.area).setDepth(1);

    const glint = new Painter(this.add.graphics(), area, scale / 2);
    this.paintWaterGlint(glint);
    const glintImage = this.bake(glint, "city-glint").setDepth(1.5);
    this.tweens.add({ targets: glintImage, alpha: { from: 0.15, to: 0.55 }, duration: 2400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  }

  private bake(p: Painter, key: string): Phaser.GameObjects.Image {
    if (this.textures.exists(key)) this.textures.remove(key);
    p.g.generateTexture(key, Math.ceil(p.area.width * p.scale), Math.ceil(p.area.height * p.scale));
    p.g.destroy();
    return this.add.image(p.area.x, p.area.y, key).setOrigin(0).setScale(1 / p.scale);
  }

  private downsample(fromKey: string, key: string, area: Rect): Phaser.GameObjects.Image {
    const src = this.textures.get(fromKey).getSourceImage() as HTMLCanvasElement;
    if (this.textures.exists(key)) this.textures.remove(key);
    const low = this.textures.createCanvas(key, Math.ceil(src.width / 2), Math.ceil(src.height / 2))!;
    const ctx = low.getContext();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, low.width, low.height);
    low.refresh();
    return this.add
      .image(area.x, area.y, key)
      .setOrigin(0)
      .setScale(area.width / low.width, area.height / low.height);
  }

  private paintWater(p: Painter): void {
    for (let ty = -WATER_MARGIN; ty < CITY.height + WATER_MARGIN; ty++) {
      for (let tx = -WATER_MARGIN; tx < CITY.width + WATER_MARGIN; tx++) {
        if (!isLand(cellAt(tx, ty))) p.tile(tx, ty, PALETTE.water);
      }
    }
  }

  private paintWaterGlint(p: Painter): void {
    const rng = createRng(7);
    for (let ty = -WATER_MARGIN; ty < CITY.height + WATER_MARGIN; ty++) {
      for (let tx = -WATER_MARGIN; tx < CITY.width + WATER_MARGIN; tx++) {
        if (!isLand(cellAt(tx, ty)) && nextInt(rng, 0, 99) < 12) p.tile(tx, ty, PALETTE.waterLight, 0.6);
      }
    }
  }

  private paintGround(p: Painter): void {
    for (let ty = 0; ty < CITY.height; ty++) {
      for (let tx = 0; tx < CITY.width; tx++) {
        const cell = cellAt(tx, ty);
        if (!isLand(cell)) continue;
        const kind = CITY.territories.get(cell)!.kind;
        const rng = createRng(tx * 7919 + ty * 104729);
        p.tile(tx, ty, shade(KIND_STYLE[kind].ground, 0.94 + nextInt(rng, 0, 12) / 100));
      }
    }
  }

  private paintBorders(p: Painter): void {
    for (let ty = 0; ty < CITY.height; ty++) {
      for (let tx = 0; tx < CITY.width; tx++) {
        const cell = cellAt(tx, ty);
        if (!isLand(cell)) continue;
        neighbours(tx, ty).forEach(([nx, ny], i) => {
          const other = cellAt(nx, ny);
          if (other === cell) return;
          const [a, b] = sharedEdge(tx, ty, i);
          if (!isLand(other)) p.line(a, b, 2, 0xc9b58a, 0.45); // shoreline
          else if (districtOf(other) !== districtOf(cell)) p.line(a, b, 3, PALETTE.districtBorder, 0.9);
          else p.line(a, b, 1.5, PALETTE.territoryBorder, 0.8);
        });
      }
    }
  }

  private paintBridges(p: Painter): void {
    for (const bridge of CITY.bridges) {
      for (const [tx, ty] of bridge.tiles) p.tile(tx, ty, PALETTE.bridge, 0.7);
      const [mx, my] = bridge.tiles[Math.floor(bridge.tiles.length / 2)]!;
      const c = tileCentre(mx, my);
      this.bridgeLabels.push(
        this.add
          .text(c.x, c.y - 14, bridge.name, { fontFamily: "system-ui, sans-serif", fontSize: "11px", fontStyle: "italic", color: "#d6c3a0", stroke: "#000", strokeThickness: 3 })
          .setOrigin(0.5)
          .setDepth(5),
      );
    }
  }

  /** Placeholder buildings: extruded blocks, deterministic per tile, painted back to front. */
  private paintBlocks(p: Painter): void {
    const anchors = new Set([...CITY.territories.values()].map((t) => `${t.anchor[0]},${t.anchor[1]}`));
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < CITY.height; ty++) for (let tx = 0; tx < CITY.width; tx++) tiles.push([tx, ty]);
    tiles.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);

    for (const [tx, ty] of tiles) {
      const cell = cellAt(tx, ty);
      if (!isLand(cell) || anchors.has(`${tx},${ty}`)) continue;
      const style = KIND_STYLE[CITY.territories.get(cell)!.kind];
      const rng = createRng(tx * 92821 + ty * 68917 + 1);
      if (nextInt(rng, 0, 99) >= style.buildChance * 100) continue;
      const inset = nextInt(rng, 50, 78) / 100;
      const h = nextInt(rng, style.height[0], style.height[1]);
      const c = tileCentre(tx, ty);
      const w = HALF_W * inset;
      const d = HALF_H * inset;
      // Left face, right face, then roof.
      p.poly([{ x: c.x - w, y: c.y }, { x: c.x, y: c.y + d }, { x: c.x, y: c.y + d - h }, { x: c.x - w, y: c.y - h }], shade(style.building, 0.62));
      p.poly([{ x: c.x, y: c.y + d }, { x: c.x + w, y: c.y }, { x: c.x + w, y: c.y - h }, { x: c.x, y: c.y + d - h }], shade(style.building, 0.8));
      p.poly([{ x: c.x, y: c.y - d - h }, { x: c.x + w, y: c.y - h }, { x: c.x, y: c.y + d - h }, { x: c.x - w, y: c.y - h }], style.building);
    }
  }

  private createLabels(): void {
    for (const d of CITY.districts.values()) {
      const c = tileCentre(...d.anchor);
      this.districtLabels.push(
        this.add
          .text(c.x, c.y, d.name.toUpperCase(), { fontFamily: "system-ui, sans-serif", fontSize: "18px", fontStyle: "bold", color: PALETTE.label, stroke: PALETTE.labelShadow, strokeThickness: 4 })
          .setDepth(5),
      );
    }
    for (const t of CITY.territories.values()) {
      const c = tileCentre(...t.anchor);
      this.territoryLabels.set(
        t.slug,
        this.add
          .text(c.x, c.y, t.name, { fontFamily: "system-ui, sans-serif", fontSize: "12px", color: PALETTE.label, stroke: PALETTE.labelShadow, strokeThickness: 3 })
          .setDepth(5),
      );
    }
  }

  /** Offsets are expressed through the origin, so they stay constant on screen while labels are counter-scaled. */
  private placeLabels(): void {
    for (const l of this.districtLabels) l.setOrigin(0.5, 1 + 30 / l.height); // bottom 30 px above the marker centre
    for (const l of this.territoryLabels.values()) l.setOrigin(0.5, -16 / l.height); // top 16 px below the marker centre
  }

  private createMarkers(): void {
    for (const t of CITY.territories.values()) {
      const c = tileCentre(...t.anchor);
      const disc = this.add.circle(0, 0, 12, PALETTE.neutralMarker).setStrokeStyle(2, PALETTE.markerRing);
      const glyph = this.add
        .text(0, 0, KIND_STYLE[t.kind].glyph, { fontFamily: "system-ui, sans-serif", fontSize: "13px", fontStyle: "bold", color: "#14110f" })
        .setOrigin(0.5);
      const container = this.add.container(c.x, c.y, [disc, glyph]).setDepth(6);
      this.territoryMarkers.set(t.slug, { container, disc });
    }
    for (const d of CITY.districts.values()) {
      const c = tileCentre(...d.anchor);
      const disc = this.add.circle(0, 0, 22, 0x3b3226, 0.95).setStrokeStyle(3, PALETTE.districtBorder);
      const count = this.add
        .text(0, 0, String(d.territories.length), { fontFamily: "system-ui, sans-serif", fontSize: "18px", fontStyle: "bold", color: PALETTE.label })
        .setOrigin(0.5);
      this.districtMarkers.set(d.slug, this.add.container(c.x, c.y, [disc, count]).setDepth(6));
    }
  }

  // ── State-driven updates ─────────────────────────────────────────────────

  private applyMode(): void {
    const territories = this.mode === "territories";
    const labels = territories && this.cameras.main.zoom >= LABEL_ZOOM;
    for (const [slug, m] of this.territoryMarkers) {
      const shown = territories && this.filter.has(CITY.territories.get(slug)!.kind);
      m.container.setVisible(shown);
      this.territoryLabels.get(slug)!.setVisible(shown && labels);
    }
    for (const m of this.districtMarkers.values()) m.setVisible(!territories);
    for (const l of this.districtLabels) l.setAlpha(territories ? 0.45 : 1);
    for (const l of this.bridgeLabels) l.setVisible(territories);
  }

  private refreshMarkers(): void {
    for (const [slug, m] of this.territoryMarkers) {
      const state = this.states.get(slug);
      m.disc.setFillStyle(state?.owner ? familyColour(state.owner.id) : PALETTE.neutralMarker);
      // A battle is being fought over it: a thick red ring.
      m.disc.setStrokeStyle(state?.battleId ? 4 : 2, state?.battleId ? PALETTE.contested : PALETTE.markerRing);
    }
  }

  private select(slug: string | null): void {
    this.selected = slug && CITY.territories.has(slug) ? slug : null;
    this.highlight.clear();
    this.pulse?.stop();
    for (const m of this.territoryMarkers.values()) {
      m.container.setData("pulse", 1);
      m.container.setScale(1 / this.cameras.main.zoom);
    }
    if (!this.selected) return;

    const t = CITY.territories.get(this.selected)!;
    for (const [tx, ty] of t.tiles) this.fillTile(this.highlight, tx, ty, PALETTE.highlight, 1, 0.16);
    for (const [tx, ty] of t.tiles) {
      neighbours(tx, ty).forEach(([nx, ny], i) => {
        if (cellAt(nx, ny) === t.slug) return;
        const [a, b] = sharedEdge(tx, ty, i);
        this.highlight.lineStyle(3, PALETTE.highlight, 1);
        this.highlight.lineBetween(a.x, a.y, b.x, b.y);
      });
    }

    const marker = this.territoryMarkers.get(this.selected)!.container;
    this.pulse = this.tweens.addCounter({
      from: 1,
      to: 1.35,
      duration: 650,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
      onUpdate: (tw) => {
        marker.setData("pulse", tw.getValue());
        marker.setScale((tw.getValue() ?? 1) / this.cameras.main.zoom);
      },
    });
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  private worldRect(): Rect {
    const r = tileBoundsToWorld({ minX: 0, minY: 0, maxX: CITY.width - 1, maxY: CITY.height - 1 });
    const pad = 48;
    return { x: r.x - pad, y: r.y - pad - 40, width: r.width + pad * 2, height: r.height + pad * 2 + 40 };
  }

  private setUpCamera(): void {
    const cam = this.cameras.main;
    this.world = this.worldRect();
    const r = this.world;
    cam.setBackgroundColor(PALETTE.background);
    const fit = () => {
      this.wake();
      this.fitZoom = Math.min(cam.width / r.width, cam.height / r.height);
      cam.setZoom(Phaser.Math.Clamp(cam.zoom, this.minZoom(), MAX_ZOOM));
      this.lastZoom = -1;
    };
    fit();
    // Start by showing the whole city, but on tall narrow screens fill more of the height (up to 2× closer).
    cam.setZoom(Phaser.Math.Clamp(Math.min(cam.height / r.height, this.fitZoom * 2), this.fitZoom, MAX_ZOOM));
    cam.centerOn(r.x + r.width / 2, r.y + r.height / 2);
    this.scale.on(Phaser.Scale.Events.RESIZE, fit);
    this.unsubscribe.push(() => this.scale.off(Phaser.Scale.Events.RESIZE, fit));
  }

  /**
   * Keeps the view over the city: the camera centre stays within the map, and when the whole map fits
   * on screen in one direction it is centred in that direction (Phaser's bounds would pin it to an edge).
   */
  private clampCamera(): void {
    const cam = this.cameras.main;
    const r = this.world;
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
    const mx = cam.scrollX + cam.width / 2;
    const my = cam.scrollY + cam.height / 2;
    const cx = r.width > 2 * halfW ? Phaser.Math.Clamp(mx, r.x + halfW, r.x + r.width - halfW) : r.x + r.width / 2;
    const cy = r.height > 2 * halfH ? Phaser.Math.Clamp(my, r.y + halfH, r.y + r.height - halfH) : r.y + r.height / 2;
    if (cx !== mx || cy !== my) cam.setScroll(cx - cam.width / 2, cy - cam.height / 2);
  }

  private minZoom(): number {
    return this.fitZoom * 0.9;
  }

  /** Zooms keeping the world point under screen position (sx, sy) fixed. */
  private zoomAt(sx: number, sy: number, zoom: number): void {
    const cam = this.cameras.main;
    const z = Phaser.Math.Clamp(zoom, this.minZoom(), MAX_ZOOM);
    const wx = cam.scrollX + cam.width / 2 + (sx - cam.width / 2) / cam.zoom;
    const wy = cam.scrollY + cam.height / 2 + (sy - cam.height / 2) / cam.zoom;
    cam.setZoom(z);
    cam.setScroll(wx - (sx - cam.width / 2) / z - cam.width / 2, wy - (sy - cam.height / 2) / z - cam.height / 2);
  }

  focusTerritory(slug: string): void {
    const t = CITY.territories.get(slug);
    if (!t) return;
    const c = tileCentre(...t.anchor);
    const cam = this.cameras.main;
    cam.pan(c.x, c.y, FOCUS_MS, "Sine.easeInOut", true);
    cam.zoomTo(Math.min(MAX_ZOOM, Math.max(cam.zoom, this.fitZoom * 2.4)), FOCUS_MS, "Sine.easeInOut", true);
  }

  focusDistrict(slug: string): void {
    const d = CITY.districts.get(slug);
    if (!d) return;
    const r = tileBoundsToWorld(d.bounds);
    const cam = this.cameras.main;
    const zoom = Math.min((cam.width / r.width) * 0.85, (cam.height / r.height) * 0.85);
    cam.pan(r.x + r.width / 2, r.y + r.height / 2, FOCUS_MS, "Sine.easeInOut", true);
    cam.zoomTo(Phaser.Math.Clamp(zoom, this.fitZoom * 1.7, MAX_ZOOM), FOCUS_MS, "Sine.easeInOut", true);
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private setUpInput(): void {
    this.input.addPointer(1); // second finger for pinch
    const cam = this.cameras.main;

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      this.wake();
      if (!this.press) this.press = { x: p.x, y: p.y, moved: false };
    });

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      const a = this.input.pointer1;
      const b = this.input.pointer2;
      if (a.isDown && b.isDown) {
        const dist = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
        if (this.pinchDistance) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, cam.zoom * (dist / this.pinchDistance));
        this.pinchDistance = dist;
        if (this.press) this.press.moved = true;
        this.wake();
        return;
      }
      this.pinchDistance = null;
      if (!p.isDown || !this.press) return;
      this.wake();
      if (!this.press.moved && Phaser.Math.Distance.Between(p.x, p.y, this.press.x, this.press.y) > DRAG_THRESHOLD) this.press.moved = true;
      if (this.press.moved) {
        cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
        cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
      }
    });

    this.input.on(Phaser.Input.Events.POINTER_UP, (p: Phaser.Input.Pointer) => {
      const press = this.press;
      if (this.input.pointer1.isDown || this.input.pointer2.isDown) return; // a finger is still down
      this.press = null;
      this.pinchDistance = null;
      if (press && !press.moved) this.click(p.x, p.y);
    });

    this.input.on(Phaser.Input.Events.POINTER_WHEEL, (p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      this.wake();
      this.zoomAt(p.x, p.y, cam.zoom * Math.exp(-dy * 0.0015));
    });
  }

  private click(sx: number, sy: number): void {
    const cam = this.cameras.main;
    const w = cam.getWorldPoint(sx, sy);
    if (this.mode === "districts") {
      for (const d of CITY.districts.values()) {
        const c = tileCentre(...d.anchor);
        if (Phaser.Math.Distance.Between(w.x, w.y, c.x, c.y) * cam.zoom <= 26) return this.focusDistrict(d.slug);
      }
    } else {
      // Markers sit above the ground, so a click on one wins over the tile beneath it.
      for (const [slug, m] of this.territoryMarkers) {
        if (m.container.visible && Phaser.Math.Distance.Between(w.x, w.y, m.container.x, m.container.y) * cam.zoom <= 14) {
          return mapBus.emit("territory:clicked", { slug });
        }
      }
    }
    const tile = this.tileAt(w.x, w.y);
    mapBus.emit("territory:clicked", tile ? { slug: tile.slug } : null);
  }

  private tileAt(wx: number, wy: number): TerritoryLayout | undefined {
    // Ground tiles are flat; the block above a tile doesn't change which territory it belongs to.
    const a = wx / HALF_W;
    const b = wy / HALF_H;
    const tx = Math.floor((a + b) / 2);
    const ty = Math.floor((b - a) / 2);
    return CITY.territories.get(cellAt(tx, ty));
  }

  // ── Testing and teardown ─────────────────────────────────────────────────

  /** Read-only hook for browser tests: where a marker is on the page, and the current zoom mode. */
  private exposeTestHook(): void {
    const cam = this.cameras.main;
    const canvas = this.game.canvas;
    (window as unknown as { __lagosMap?: unknown }).__lagosMap = {
      mode: () => this.mode,
      relativeZoom: () => cam.zoom / this.fitZoom,
      selected: () => this.selected,
      /** Game-loop steps so far; lets tests check the idle frame rate (and that only one loop runs). */
      steps: () => this.game.loop.frame,
      contested: (slug: string) => this.territoryMarkers.get(slug)?.disc.strokeColor === PALETTE.contested,
      markerScreenPosition: (slug: string) => {
        const t = CITY.territories.get(slug);
        if (!t) return null;
        const c = tileCentre(...t.anchor);
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + (c.x - cam.worldView.x) * cam.zoom, y: rect.top + (c.y - cam.worldView.y) * cam.zoom };
      },
    };
  }

  private teardown(): void {
    this.torn = true;
    for (const off of this.unsubscribe.splice(0)) off();
    delete (window as unknown as { __lagosMap?: unknown }).__lagosMap;
  }
}
