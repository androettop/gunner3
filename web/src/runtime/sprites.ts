import {
  type Graphic, GraphicsGroup, type GraphicsGrouping, ImageSource, Sprite, Vector,
} from 'excalibur';
import type { GameData } from '../data/loader';
import { type CounterData, TILED_FILL } from '../data/types';
import { paint } from './bitmaps';

/** The glyphs a counter's images stand for, in the order the counter stores them. */
const COUNTER_GLYPHS = '0123456789-+.e';

function rowKey(handles: number[], text: string): string {
  return `${handles.join(',')}|${text}`;
}

/** Sprite cache over the game's pictures, and the graphics the runtime builds out of them. */
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
    const fill = detail.fillType === TILED_FILL
      ? this.tiled(detail.image, width, height)
      : this.ramp(detail, width, height);

    // A shape can carry a border of its own, drawn inside its box: four strips of one colour,
    // which is one pixel stretched four ways rather than four more pictures.
    const border = Math.min(Math.round(detail.borderSize ?? 0), Math.floor(Math.min(width, height) / 2));
    // A tile that is not decoded yet is not a backdrop that has none: leaving it uncached asks
    // again on the next frame, as everything else waiting on a picture does.
    if (!fill && detail.fillType === TILED_FILL) return null;

    const graphic = border > 0 && fill
      ? this.bordered([{ graphic: fill, offset: Vector.Zero }],
        detail.borderColor ?? '#000000', width, height, border)
      : fill;

    this.quickBackdrops.set(objectId, graphic);
    return graphic;
  }

  /** The tile itself, drawn over a box as many times its size as it takes to fill it. */
  private tiled(image: number, width: number, height: number): Sprite | null {
    const source = this.sources.get(image);
    if (!source?.isLoaded()) return null;

    // A box wider than the tile is more than one of it because the texture repeats, which the
    // picture was marked for when it was decoded. It cannot be asked for here: the tile is very
    // often an ordinary backdrop block as well, and by the time a level wants the fill the card
    // is holding a texture that was uploaded to draw one of those, which no amount of asking
    // will re-sample. Left to that, the fill is the tile's edge pixel drawn the width of a level.
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
  ): Sprite | null {
    // Fill 2 is the only one that ramps: the rest are the one colour, and a shape that carries
    // just the one leaves the second at white, which drawn as a ramp fades the bar out to
    // nothing.
    const flat = detail.fillType !== 2 || detail.color1 === detail.color2;
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

  private readonly barFills = new Map<number, Sprite | null>();

  /**
   * A counter drawn as a bar rather than as a number.
   *
   * The bar is the counter's own shape, filled as far as the reading has got: across for a
   * horizontal one, upwards for a vertical one, and from the other end for one marked inverse.
   * The border, where there is one, is drawn around the whole box however little of it is full.
   *
   * The fill is cut down rather than painted again, so a bar that moves every frame costs
   * nothing to move: what changes is which part of a picture already on the card is drawn.
   */
  counterBar(objectId: number, counter: CounterData, part: number): Graphic | null {
    const shape = counter.shape;
    if (!shape) return null;
    const width = Math.max(1, Math.round(counter.width ?? 0));
    const height = Math.max(1, Math.round(counter.height ?? 0));

    let fill = this.barFills.get(objectId);
    if (fill === undefined) {
      fill = shape.fillType === TILED_FILL
        ? this.tiled(counter.image ?? 0, width, height)
        : this.ramp(shape, width, height);
      // A tile still being decoded is asked for again next frame rather than remembered as a
      // bar with no fill.
      if (!fill && shape.fillType === TILED_FILL) return null;
      this.barFills.set(objectId, fill);
    }
    if (!fill) return null;

    const shown = Math.max(0, Math.min(1, part));
    const across = counter.display === 3;
    const view = fill.sourceView;
    const cut = fill.clone();
    if (across) {
      const seen = view.width * shown;
      cut.sourceView = { ...view, x: view.x + (counter.inverse ? view.width - seen : 0), width: seen };
      cut.width = width * shown;
      cut.height = height;
    } else {
      const seen = view.height * shown;
      cut.sourceView = { ...view, y: view.y + (counter.inverse ? 0 : view.height - seen), height: seen };
      cut.width = width;
      cut.height = height * shown;
    }

    // The filled part sits at the end the bar fills from; the rest of the box stays empty.
    const at = across
      ? new Vector(counter.inverse ? width - width * shown : 0, 0)
      : new Vector(0, counter.inverse ? 0 : height - height * shown);

    const inside: GraphicsGrouping[] = shown > 0 ? [{ graphic: cut, offset: at }] : [];
    const border = Math.min(Math.round(shape.borderSize ?? 0), Math.floor(Math.min(width, height) / 2));
    return border > 0
      ? this.bordered(inside, shape.borderColor ?? '#000000', width, height, border)
      : group(inside, width, height);
  }

  /** The given contents with a border of that thickness drawn inside the box. */
  private bordered(
    inside: GraphicsGrouping[], color: string, width: number, height: number, thickness: number,
  ): Graphic {
    const source = paint(1, 1, `quick backdrop border ${color}`, (context) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    });
    if (!source) return group(inside, width, height);

    const strip = (w: number, h: number, x: number, y: number) => ({
      graphic: new Sprite({ image: source, destSize: { width: w, height: h } }),
      offset: new Vector(x, y),
    });
    return new GraphicsGroup({
      useAnchor: false,
      members: [
        ...inside,
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

  /**
   * A counter's reading drawn as a row of its own glyph images, in one picture.
   *
   * Composing it as a group of sprites is the obvious alternative, but the group's own bounds
   * then decide how much of each glyph survives; a single image is drawn like any other.
   *
   * A reading is built the first time it is shown and kept, which is cheap enough to do in front
   * of the player: the glyphs are already decoded, and what is drawn is a picture a few dozen
   * pixels wide.
   */
  digitRow(handles: number[], text: string): Sprite | null {
    const key = rowKey(handles, text);
    const cached = this.digitRows.get(key);
    if (cached !== undefined) return cached;

    const glyphs: { source: ImageSource; width: number; height: number }[] = [];
    for (const glyph of text) {
      const index = COUNTER_GLYPHS.indexOf(glyph);
      const handle = index >= 0 ? handles[index] : undefined;
      const source = handle === undefined ? undefined : this.sources.get(handle);
      const meta = handle === undefined ? undefined : this.data.images.get(handle);
      // A glyph the reading needs and the counter has not got is a row that cannot be drawn.
      // Nothing is cached for it: a picture may still be on its way, and a gap kept is kept for
      // good.
      if (!source?.isLoaded() || !meta) return null;
      glyphs.push({ source, width: meta.width, height: meta.height });
    }

    let sprite: Sprite | null = null;
    if (glyphs.length) {
      const width = glyphs.reduce((sum, glyph) => sum + glyph.width, 0);
      const height = glyphs.reduce((tallest, glyph) => Math.max(tallest, glyph.height), 0);
      const row = paint(width, height, `counter "${text}"`, (context) => {
        let x = 0;
        for (const glyph of glyphs) {
          context.drawImage(glyph.source.image, x, 0);
          x += glyph.width;
        }
      });
      if (row) {
        sprite = row.toSprite();
        sprite.width = width;
        sprite.height = height;
      }
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

/**
 * Graphics laid out inside a box, placed from its top left rather than around its middle.
 *
 * A group with nothing in it still has to stand for the box, or an empty bar would be a graphic
 * of no size and the frame would have nowhere to put it.
 */
function group(members: GraphicsGrouping[], width: number, height: number): Graphic {
  return new GraphicsGroup({ useAnchor: false, members, width, height });
}
