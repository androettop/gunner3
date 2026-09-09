import { ImageSource, ImageSourceAttributeConstants } from 'excalibur';

/**
 * Pictures the runtime makes for itself, and pictures it decodes, as something drawable.
 *
 * Excalibur takes an image element and decodes it for you. Neither suits a runtime that already
 * holds every picture as bytes and paints a few of its own: an element has to be loaded through
 * a URL, and it is decoded when it is first drawn rather than when it is loaded, so a picture
 * arrives late and can be thrown away and decoded again later. A bitmap is decoded once, stays
 * decoded, and is what the graphics layer wants to be handed anyway.
 */

/**
 * Dresses a bitmap as the image the rest of the engine draws.
 *
 * Two things are read off a picture that a bitmap does not carry: the natural size an image
 * element reports, and a handful of attributes saying how its texture is to be sampled. Given
 * those, it is drawn and uploaded like any other picture.
 */
export function sourceOf(bitmap: ImageBitmap, path: string): ImageSource {
  const attributes = new Map<string, string>();
  const element = Object.assign(bitmap, {
    naturalWidth: bitmap.width,
    naturalHeight: bitmap.height,
    src: path,
    // Named in the warnings the graphics layer prints, and read whether or not it has anything
    // to say, so a picture without one takes the whole load down with it.
    dataset: { originalSrc: path },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  }) as unknown as HTMLImageElement;

  const source = ImageSource.fromHtmlImageElement(element);
  // Left unsaid, a picture is sampled the way the application asks for. Naming it per image
  // would override that, and whether this game is smoothed is the application's to decide.
  element.removeAttribute(ImageSourceAttributeConstants.Filtering);
  return source;
}
