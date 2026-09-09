/**
 * The array extension's storage.
 *
 * Each array object holds its own numbered slots, and the game uses them to carry things a
 * frame at a time and between frames: an inventory is filled on one screen and read back on
 * another, so the store outlives any single scene and the host hands the same one to each.
 *
 * Only the single-dimension form is kept. The extension offers three, but a slot addressed by
 * one number is what this game writes and reads, and a second dimension nobody uses would be a
 * shape invented for it here.
 */
export class ArrayStore {
  private readonly slots = new Map<number, Map<number, number | string>>();

  write(object: number, index: number, value: number | string): void {
    let array = this.slots.get(object);
    if (!array) this.slots.set(object, (array = new Map()));
    array.set(index, value);
  }

  read(object: number, index: number): number {
    return Number(this.slots.get(object)?.get(index)) || 0;
  }

  readString(object: number, index: number): string {
    const value = this.slots.get(object)?.get(index);
    return value === undefined ? '' : String(value);
  }

  /** "Clear the array": every slot of one object at once. */
  clear(object: number): void {
    this.slots.delete(object);
  }
}
