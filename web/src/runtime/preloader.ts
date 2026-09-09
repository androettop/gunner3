import type { ImageSource } from 'excalibur';
import type { GameData } from '../data/loader';
import { sourceOf } from './bitmaps';

export interface Progress {
  loaded: number;
  total: number;
  label: string;
}

/**
 * Decodes the whole image bank before the game starts.
 *
 * The pictures are already in hand: the package was unzipped into memory, so nothing is fetched.
 * What is left is turning PNG bytes into something the graphics card can be handed, which is
 * what `createImageBitmap` is for. It decodes off the main thread, many at once, and gives back
 * a bitmap that stays decoded.
 *
 * The obvious alternative, an `<img>` per picture, is what this used to do, and it was slower
 * twice over. Loading one means making a blob URL, handing it to an image element and waiting,
 * which for this game's 2611 sprites took twelve seconds against half of one. Worse, an image
 * element that has loaded has not necessarily been decoded: browsers put that off until the
 * picture is first drawn, and may throw the result away again, which is why scenery used to
 * arrive a moment after it should have when a level scrolled quickly.
 */
/**
 * How many pictures are decoded at once.
 *
 * Asking for all of them together is a little quicker still, but a browser under memory pressure
 * answers some of those with "could not be decoded" rather than queueing them, and a sprite that
 * never arrives is worse than a load that takes another moment.
 */
const AT_ONCE = 512;

export class Preloader {
  constructor(private readonly data: GameData, private readonly concurrency = AT_ONCE) {}

  async loadAll(onProgress: (p: Progress) => void): Promise<Map<number, ImageSource>> {
    const images = new Map<number, ImageSource>();
    const handles = [...this.data.images.keys()];
    const total = handles.length;
    let loaded = 0;

    const report = (label: string) => onProgress({ loaded, total, label });
    report('Loading sprites');

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < handles.length) {
        const handle = handles[next++];
        try {
          images.set(handle, sourceOf(await this.decode(handle), `images/${handle}.png`));
        } catch (e) {
          console.warn(`image ${handle}: ${e}`);
        }
        loaded++;
        // Repainting on every single image costs more than it communicates.
        if (loaded % 64 === 0 || loaded === total) report('Loading sprites');
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, total) }, worker));

    report('Ready');
    return images;
  }

  /** Decodes one picture, and gives a refusal one more go before letting it stand. */
  private async decode(handle: number): Promise<ImageBitmap> {
    const bytes = this.data.imageBytes(handle);
    const blob = new Blob([bytes.slice()], { type: 'image/png' });
    // The renderer premultiplies as it uploads, the way it does for an image element, so the
    // bitmap has to arrive with that not yet done or it is applied twice.
    const options: ImageBitmapOptions = { premultiplyAlpha: 'none' };
    try {
      return await createImageBitmap(blob, options);
    } catch {
      return await createImageBitmap(blob, options);
    }
  }
}
