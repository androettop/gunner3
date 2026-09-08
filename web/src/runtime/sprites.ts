import { ImageSource, Sprite } from 'excalibur';
import type { GameData } from '../data/loader';
import { isCommon } from '../data/types';

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
  private readonly quickBackdrops = new Map<number, Sprite | null>();

  /**
   * Builds the graphic for a quick backdrop, which is not a plain sprite.
   *
   * Fill type 2 paints a colour ramp between the object's two colours and ignores its image
   * field entirely; fill type 3 tiles the image across the object's box. Drawing the raw image
   * handle instead gives the wrong picture in the first case and an untiled, undersized one in
   * the second: the level's sky and its long ground strips are both quick backdrops.
   */
  quickBackdrop(
    objectId: number,
    detail: {
      width: number; height: number; fillType: number; image: number;
      color1: string; color2: string;
      verticalGradient?: boolean; borderSize?: number; borderColor?: string;
    },
  ): Sprite | null {
    const cached = this.quickBackdrops.get(objectId);
    if (cached !== undefined) return cached;

    const width = Math.max(1, Math.round(detail.width));
    const height = Math.max(1, Math.round(detail.height));
    let sprite: Sprite | null = null;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context) {
        if (detail.fillType === 3) {
          const source = this.sources.get(detail.image);
          if (source?.isLoaded()) {
            const pattern = context.createPattern(source.image, 'repeat');
            if (pattern) {
              context.fillStyle = pattern;
              context.fillRect(0, 0, width, height);
            }
          }
        } else {
          if (detail.color1 === detail.color2) {
            context.fillStyle = detail.color1;
          } else {
            // The shape says which way its gradient runs. Every one in this game happens to run
            // downwards, so drawing them all that way was right by luck rather than by reading
            // the field.
            const across = detail.verticalGradient === false;
            const ramp = across
              ? context.createLinearGradient(0, 0, width, 0)
              : context.createLinearGradient(0, 0, 0, height);
            ramp.addColorStop(0, detail.color1);
            ramp.addColorStop(1, detail.color2);
            context.fillStyle = ramp;
          }
          context.fillRect(0, 0, width, height);
        }

        // A shape can carry a border of its own, drawn inside its box.
        const border = detail.borderSize ?? 0;
        if (border > 0) {
          context.strokeStyle = detail.borderColor ?? '#000000';
          context.lineWidth = border;
          context.strokeRect(border / 2, border / 2,
            Math.max(0, width - border), Math.max(0, height - border));
        }
        const source = new ImageSource(canvas.toDataURL());
        // Nothing decodes a data URL on its own: without this the sprite stays empty and the
        // sky gradient and tiled ground simply never appear.
        void source.load().catch((e) => console.warn(`quick backdrop ${objectId} decode: ${e}`));
        sprite = source.toSprite();
        sprite.width = width;
        sprite.height = height;
      }
    } catch (e) {
      console.warn(`quick backdrop ${objectId}: ${e}`);
    }

    this.quickBackdrops.set(objectId, sprite);
    return sprite;
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
