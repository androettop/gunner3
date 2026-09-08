import { ImageSource, Sprite } from 'excalibur';
import type { GameData } from '../data/loader';

/**
 * Sprite cache over the dumped PNGs.
 *
 * The dump has 2611 images and a single level references only a few hundred, so images are
 * loaded on demand per frame rather than all upfront.
 */
/** The glyphs a counter's images stand for, in the order the counter stores them. */
const COUNTER_GLYPHS = '0123456789-+.e';

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

  /**
   * A counter's reading drawn as a row of its own glyph images, rasterised into one sprite.
   *
   * Composing it as a group of sprites is the obvious alternative, but the group's own bounds
   * then decide how much of each glyph survives; a single image is drawn like any other.
   */
  digitRow(handles: number[], text: string): Sprite | null {
    const key = `${handles.join(',')}|${text}`;
    const cached = this.digitRows.get(key);
    if (cached !== undefined) return cached;

    const glyphs: { source: ImageSource; width: number; height: number }[] = [];
    for (const glyph of text) {
      const index = COUNTER_GLYPHS.indexOf(glyph);
      const handle = index >= 0 ? handles[index] : undefined;
      const source = handle === undefined ? undefined : this.sources.get(handle);
      const meta = handle === undefined ? undefined : this.data.images.get(handle);
      // A glyph still loading means the whole row waits; caching a gap would keep it forever.
      if (!source?.isLoaded() || !meta) return null;
      glyphs.push({ source, width: meta.width, height: meta.height });
    }
    if (!glyphs.length) {
      this.digitRows.set(key, null);
      return null;
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
        void source.load().catch((e) => console.warn(`counter digits decode: ${e}`));
        sprite = source.toSprite();
        sprite.width = width;
        sprite.height = height;
      }
    } catch (e) {
      console.warn(`counter digits "${text}": ${e}`);
    }

    this.digitRows.set(key, sprite);
    return sprite;
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
