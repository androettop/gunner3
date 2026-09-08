/**
 * Per-pixel obstacle mask for a frame.
 *
 * Fusion decides "collides with the background" against the pixels of every backdrop marked as
 * an obstacle, not their bounding boxes: the terrain in this game is tiled with sloped edges,
 * so boxes would leave the player floating. One bit per pixel keeps even the largest frame
 * (6000x2300) around 1.7 MB.
 *
 * The mask is not limited to the frame rectangle. Backdrops are placed by their own coordinates
 * and are free to sit outside it, which is how a level walls itself in: the frames here each
 * carry a tall obstacle just past the left edge and another just past the right, so the player's
 * side sensors meet scenery instead of open air. Sizing the mask to the frame silently dropped
 * those two, and walking left ran off the level into a fall. So the mask carries an origin and
 * grows to take in whatever is stamped into it.
 */

/** Ceiling on the mask's area, so a stray coordinate cannot ask for an enormous allocation. */
const MAX_PIXELS = 64 * 1024 * 1024;

export class ObstacleMask {
  private bits: Uint8Array;
  private stride: number;
  private originX = 0;
  private originY = 0;
  private w: number;
  private h: number;

  constructor(width: number, height: number) {
    this.w = Math.max(0, width);
    this.h = Math.max(0, height);
    this.stride = (this.w + 7) >> 3;
    this.bits = new Uint8Array(this.stride * this.h);
  }

  /** Leftmost and topmost pixel the mask covers; negative once an obstacle sits off-frame. */
  get left(): number { return this.originX; }
  get top(): number { return this.originY; }
  get width(): number { return this.w; }
  get height(): number { return this.h; }

  set(x: number, y: number): void {
    this.grow(x, y, x + 1, y + 1);
    const lx = x - this.originX;
    const ly = y - this.originY;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return;
    this.bits[ly * this.stride + (lx >> 3)] |= 0x80 >> (lx & 7);
  }

  test(x: number, y: number): boolean {
    const lx = x - this.originX;
    const ly = y - this.originY;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return false;
    return (this.bits[ly * this.stride + (lx >> 3)] & (0x80 >> (lx & 7))) !== 0;
  }

  /** True if any solid pixel falls inside the rectangle. Bounds are clamped to the mask. */
  testRect(left: number, top: number, right: number, bottom: number): boolean {
    const x0 = Math.max(0, Math.floor(left) - this.originX);
    const y0 = Math.max(0, Math.floor(top) - this.originY);
    const x1 = Math.min(this.w - 1, Math.ceil(right) - 1 - this.originX);
    const y1 = Math.min(this.h - 1, Math.ceil(bottom) - 1 - this.originY);
    if (x1 < x0 || y1 < y0) return false;

    for (let y = y0; y <= y1; y++) {
      const row = y * this.stride;
      // Whole-byte spans first, so wide rectangles do not cost a test per pixel.
      let x = x0;
      while (x <= x1 && (x & 7) !== 0) {
        if ((this.bits[row + (x >> 3)] & (0x80 >> (x & 7))) !== 0) return true;
        x++;
      }
      while (x + 7 <= x1) {
        if (this.bits[row + (x >> 3)] !== 0) return true;
        x += 8;
      }
      while (x <= x1) {
        if ((this.bits[row + (x >> 3)] & (0x80 >> (x & 7))) !== 0) return true;
        x++;
      }
    }
    return false;
  }

  /** Count of solid pixels, for diagnostics. */
  solidCount(): number {
    let total = 0;
    for (const byte of this.bits) {
      let b = byte;
      while (b) { total += b & 1; b >>= 1; }
    }
    return total;
  }

  /** Stamps an alpha map (one byte per pixel, non-zero = solid) at a frame position. */
  stamp(alpha: Uint8Array, imgWidth: number, imgHeight: number, atX: number, atY: number): void {
    this.grow(atX, atY, atX + imgWidth, atY + imgHeight);
    for (let y = 0; y < imgHeight; y++) {
      const destY = atY + y - this.originY;
      if (destY < 0 || destY >= this.h) continue;
      const row = destY * this.stride;
      const srcRow = y * imgWidth;
      for (let x = 0; x < imgWidth; x++) {
        if (alpha[srcRow + x] === 0) continue;
        const destX = atX + x - this.originX;
        if (destX < 0 || destX >= this.w) continue;
        this.bits[row + (destX >> 3)] |= 0x80 >> (destX & 7);
      }
    }
  }

  /** Fills a solid rectangle, for shape-only quick backdrops that have no image. */
  fillRect(left: number, top: number, width: number, height: number): void {
    this.grow(left, top, left + width, top + height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) this.set(left + x, top + y);
  }

  /**
   * Widens the mask so it takes in the given rectangle, keeping what it already holds.
   *
   * Rectangles that would push the mask past its size ceiling are left clipped, which is what
   * the mask did with everything outside the frame before it could grow at all.
   */
  private grow(left: number, top: number, right: number, bottom: number): void {
    const x0 = Math.min(this.originX, Math.floor(left));
    const y0 = Math.min(this.originY, Math.floor(top));
    const x1 = Math.max(this.originX + this.w, Math.ceil(right));
    const y1 = Math.max(this.originY + this.h, Math.ceil(bottom));
    if (x0 === this.originX && y0 === this.originY &&
        x1 === this.originX + this.w && y1 === this.originY + this.h) return;

    const width = x1 - x0;
    const height = y1 - y0;
    if (width * height > MAX_PIXELS) return;

    const stride = (width + 7) >> 3;
    const bits = new Uint8Array(stride * height);

    const dx = this.originX - x0;
    const dy = this.originY - y0;
    for (let y = 0; y < this.h; y++) {
      const oldRow = y * this.stride;
      const newRow = (y + dy) * stride;
      for (let b = 0; b < this.stride; b++) {
        const byte = this.bits[oldRow + b];
        // Empty bytes are the common case by far; skipping them keeps a regrow of a full
        // 6000x2000 mask down to the pixels that are actually solid.
        if (byte === 0) continue;
        for (let k = 0; k < 8; k++) {
          if ((byte & (0x80 >> k)) === 0) continue;
          const x = (b << 3) + k + dx;
          bits[newRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }

    this.originX = x0;
    this.originY = y0;
    this.w = width;
    this.h = height;
    this.stride = stride;
    this.bits = bits;
  }
}
