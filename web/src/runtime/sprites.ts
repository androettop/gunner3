import {
  type Graphic, GraphicsGroup, ImageSource, ImageSourceAttributeConstants, ImageWrapping, Sprite,
  Vector,
} from 'excalibur';
import type { GameData } from '../data/loader';
import { isCommon } from '../data/types';
import { paint } from './bitmaps';

/**
 * Sprite cache over the dumped PNGs.
 *
 * The dump has 2611 images and a single level references only a few hundred, so images are
 * loaded on demand per frame rather than all upfront.
 */
/** The glyphs a counter's images stand for, in the order the counter stores them. */
const COUNTER_GLYPHS = '0123456789-+.e';

/** How many readings of one counter are worth building ahead of being asked for. */
const MOST_READINGS = 1000;

function rowKey(handles: number[], text: string): string {
  return `${handles.join(',')}|${text}`;
}

export class SpriteStore {
  private readonly sprites = new Map<number, Sprite>();

  constructor(
    private readonly data: GameData,
    private readonly sources: Map<number, ImageSource>,
  ) {}

  /** The decoded image behind a handle, for the things that need the picture and not a sprite. */
  source(handle: number): ImageSource | undefined {
    return this.sources.get(handle);
  }

  private readonly alphas = new Map<number, Uint8Array | null>();
  private readonly quickBackdrops = new Map<number, Graphic | null>();

  /**
   * Builds the graphic for a quick backdrop, which is not a plain sprite.
   *
   * Fill type 3 tiles an image across the object's box; anything else is one colour, or a ramp
   * between two of them, over the whole of it. The image field is ignored in that second case,
   * so drawing the raw handle gives the wrong picture there and a single undersized copy of the
   * tile in the first: a level's sky and its long ground strips are both quick backdrops.
   *
   * Neither is painted at the size it is drawn at. This game's ground is 6016x1536, which is a
   * 37 MB picture to build, encode, decode and hand to the graphics card, and past 4096 across
   * some cards will not take it at all and draw black. Both are things the card does for
   * nothing instead: a tiled fill is the tile, drawn over a box that many times its width, and
   * a ramp is a single pixel wide, or one tall, stretched over the box, which is exactly what a
   * linear ramp is.
   */
  quickBackdrop(
    objectId: number,
    detail: {
      width: number; height: number; fillType: number; image: number;
      color1: string; color2: string;
      verticalGradient?: boolean; borderSize?: number; borderColor?: string;
    },
  ): Graphic | null {
    const cached = this.quickBackdrops.get(objectId);
    if (cached !== undefined) return cached;

    const width = Math.max(1, Math.round(detail.width));
    const height = Math.max(1, Math.round(detail.height));
    const fill = detail.fillType === 3
      ? this.tiled(detail.image, width, height)
      : this.ramp(detail, width, height);

    // A shape can carry a border of its own, drawn inside its box: four strips of one colour,
    // which is one pixel stretched four ways rather than four more pictures.
    const border = Math.min(Math.round(detail.borderSize ?? 0), Math.floor(Math.min(width, height) / 2));
    // A tile that is not decoded yet is not a backdrop that has none: leaving it uncached asks
    // again on the next frame, as everything else waiting on a picture does.
    if (!fill && detail.fillType === 3) return null;

    const graphic = border > 0 && fill
      ? this.bordered(fill, detail.borderColor ?? '#000000', width, height, border)
      : fill;

    this.quickBackdrops.set(objectId, graphic);
    return graphic;
  }

  /** The tile itself, drawn over a box as many times its size as it takes to fill it. */
  private tiled(image: number, width: number, height: number): Graphic | null {
    const source = this.sources.get(image);
    if (!source?.isLoaded()) return null;

    // A texture is clamped at its edge unless it is asked to repeat, which is what turns a box
    // wider than the tile into more than one of it. The tile may be on the card already from
    // being drawn as an ordinary sprite, so the upload is asked for again with it.
    const element = source.image as unknown as HTMLImageElement;
    element.setAttribute(ImageSourceAttributeConstants.WrappingX, ImageWrapping.Repeat);
    element.setAttribute(ImageSourceAttributeConstants.WrappingY, ImageWrapping.Repeat);
    element.setAttribute('forceUpload', 'true');

    return new Sprite({
      image: source,
      sourceView: { x: 0, y: 0, width, height },
      destSize: { width, height },
    });
  }

  /** One colour, or a ramp between two, as the thinnest picture that says it. */
  private ramp(
    detail: { fillType: number; color1: string; color2: string; verticalGradient?: boolean },
    width: number,
    height: number,
  ): Graphic | null {
    const flat = detail.color1 === detail.color2;
    // The shape says which way its ramp runs; a flat colour runs neither way.
    const down = detail.verticalGradient !== false;
    const source = paint(
      flat || down ? 1 : width,
      flat || !down ? 1 : height,
      `quick backdrop ${detail.color1}-${detail.color2}`,
      (context) => {
        if (flat) {
          context.fillStyle = detail.color1;
        } else {
          const ramp = down
            ? context.createLinearGradient(0, 0, 0, height)
            : context.createLinearGradient(0, 0, width, 0);
          ramp.addColorStop(0, detail.color1);
          ramp.addColorStop(1, detail.color2);
          context.fillStyle = ramp;
        }
        context.fillRect(0, 0, width, height);
      },
    );
    return source ? new Sprite({ image: source, destSize: { width, height } }) : null;
  }

  /** The fill with a border of the given thickness drawn inside its box. */
  private bordered(
    fill: Graphic, color: string, width: number, height: number, thickness: number,
  ): Graphic {
    const source = paint(1, 1, `quick backdrop border ${color}`, (context) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    });
    if (!source) return fill;

    const strip = (w: number, h: number, x: number, y: number) => ({
      graphic: new Sprite({ image: source, destSize: { width: w, height: h } }),
      offset: new Vector(x, y),
    });
    return new GraphicsGroup({
      useAnchor: false,
      members: [
        { graphic: fill, offset: Vector.Zero },
        strip(width, thickness, 0, 0),
        strip(width, thickness, 0, height - thickness),
        strip(thickness, height - thickness * 2, 0, thickness),
        strip(thickness, height - thickness * 2, width - thickness, thickness),
      ],
    });
  }

  /**
   * One byte per pixel, non-zero where the image is opaque. Used to build the frame's obstacle
   * mask; decoded once per image through an offscreen canvas and cached.
   */
  alphaMap(handle: number): Uint8Array | null {
    const cached = this.alphas.get(handle);
    if (cached !== undefined) return cached;

    const source = this.sources.get(handle);
    const meta = this.data.images.get(handle);
    if (!source || !source.isLoaded() || !meta || meta.width <= 0 || meta.height <= 0) {
      this.alphas.set(handle, null);
      return null;
    }

    let alpha: Uint8Array | null = null;
    try {
      const canvas = new OffscreenCanvas(meta.width, meta.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(source.image, 0, 0);
        const pixels = context.getImageData(0, 0, meta.width, meta.height).data;
        alpha = new Uint8Array(meta.width * meta.height);
        for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = pixels[p] > 0 ? 1 : 0;
      }
    } catch (e) {
      console.warn(`alpha map for image ${handle}: ${e}`);
    }

    this.alphas.set(handle, alpha);
    return alpha;
  }

  private readonly digitRows = new Map<string, Sprite | null>();
  /** Rows being built, so that one is not started again on every frame that asks for it. */
  private readonly buildingRows = new Map<string, Promise<void>>();

  /**
   * A counter's reading drawn as a row of its own glyph images, rasterised into one sprite.
   *
   * Composing it as a group of sprites is the obvious alternative, but the group's own bounds
   * then decide how much of each glyph survives; a single image is drawn like any other.
   */
  digitRow(handles: number[], text: string): Sprite | null {
    const key = rowKey(handles, text);
    const cached = this.digitRows.get(key);
    if (cached !== undefined) return cached;

    // A row is rasterised into an image, and an image is not decoded on the spot. Handing back
    // one that is not decoded yet gets it silently dropped by the renderer and complained about
    // on the way, so nothing is handed back until it can actually be drawn: the caller draws no
    // reading this frame and asks again on the next, which is what it already does for a glyph
    // that has not loaded.
    if (!this.buildingRows.has(key)) this.buildingRows.set(key, this.buildRow(key, handles, text));
    // A row that needs nothing at all is settled before the first await inside the build.
    return this.digitRows.get(key) ?? null;
  }

  /**
   * Builds every reading the game's counters can show, before any of them is asked for.
   *
   * The readings are predictable: a counter that draws digits declares the range it clamps
   * itself to, so the whole of what it can show is known from the game's own data. Building
   * them up front is what keeps a counter that changes every frame, like a percentage counting
   * up, from waiting on a decode each time it moves.
   */
  async warmCounters(onProgress?: (built: number, total: number) => void): Promise<void> {
    const rows = new Map<string, { handles: number[]; text: string }>();
    for (const object of this.data.objects.values()) {
      const counter = isCommon(object.detail) ? object.detail.counter : null;
      // Display type 1 is "digits"; the rest of the counters draw no glyphs.
      if (counter?.display !== 1 || !counter.frames?.length) continue;
      const span = counter.maximum - counter.minimum + 1;
      // A counter with a range too wide to be worth holding is left to build as it goes.
      if (span < 1 || span > MOST_READINGS) continue;
      for (let value = counter.minimum; value <= counter.maximum; value++) {
        const text = String(value);
        rows.set(rowKey(counter.frames, text), { handles: counter.frames, text });
      }
    }

    let built = 0;
    const total = rows.size;
    onProgress?.(0, total);
    await Promise.all([...rows.values()].map(async ({ handles, text }) => {
      this.digitRow(handles, text);
      await this.buildingRows.get(rowKey(handles, text));
      onProgress?.(++built, total);
    }));
  }

  private async buildRow(key: string, handles: number[], text: string): Promise<void> {
    const glyphs: { source: ImageSource; width: number; height: number }[] = [];
    for (const glyph of text) {
      const index = COUNTER_GLYPHS.indexOf(glyph);
      const handle = index >= 0 ? handles[index] : undefined;
      const source = handle === undefined ? undefined : this.sources.get(handle);
      const meta = handle === undefined ? undefined : this.data.images.get(handle);
      // A glyph still loading means the whole row waits; caching a gap would keep it forever.
      if (!source?.isLoaded() || !meta) {
        this.buildingRows.delete(key);
        return;
      }
      glyphs.push({ source, width: meta.width, height: meta.height });
    }
    if (!glyphs.length) {
      this.digitRows.set(key, null);
      this.buildingRows.delete(key);
      return;
    }

    const width = glyphs.reduce((sum, g) => sum + g.width, 0);
    const height = glyphs.reduce((tallest, g) => Math.max(tallest, g.height), 0);

    let sprite: Sprite | null = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      const context = canvas.getContext('2d');
      if (context) {
        let x = 0;
        for (const glyph of glyphs) {
          context.drawImage(glyph.source.image, x, 0);
          x += glyph.width;
        }
        const source = new ImageSource(canvas.toDataURL());
        await source.load();
        sprite = source.toSprite();
        sprite.width = width;
        sprite.height = height;
      }
    } catch (e) {
      console.warn(`counter digits "${text}": ${e}`);
    }

    this.digitRows.set(key, sprite);
    this.buildingRows.delete(key);
  }

  sprite(handle: number): Sprite | null {
    const cached = this.sprites.get(handle);
    if (cached) return cached;

    const source = this.sources.get(handle);
    if (!source || !source.isLoaded()) return null;

    const sprite = source.toSprite();
    this.sprites.set(handle, sprite);
    return sprite;
  }

  /**
   * Offset from an instance's stored position to the centre of its image, which is where
   * Excalibur draws.
   *
   * Fusion places an active object by its hotspot but a backdrop by the top-left of its image.
   */
  centreOffset(handle: number, topLeftAnchored = false): { x: number; y: number } {
    const meta = this.data.images.get(handle);
    if (!meta) return { x: 0, y: 0 };
    if (topLeftAnchored) return { x: meta.width / 2, y: meta.height / 2 };
    return { x: meta.width / 2 - meta.hotspotX, y: meta.height / 2 - meta.hotspotY };
  }
}
