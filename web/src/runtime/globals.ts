import type { FusionInstance } from './instance';
import type { ObjectDef } from '../data/types';

/**
 * Alterable values kept for objects marked global.
 *
 * A global object is one object across the whole application rather than one per frame: what it
 * holds survives leaving a frame and comes back when the next frame places it again. Games carry
 * their state this way: a load screen fills a set of counters from a save file and jumps to the
 * level, which expects to find them still filled.
 *
 * Counters are covered by the same mechanism, since a counter's reading is its first alterable
 * value.
 */
export class GlobalValues {
  private readonly saved = new Map<number, number[]>();

  /**
   * Whether an object is global.
   *
   * The flag lives in the object's header, not in the preferences of its common chunk: those
   * carry a bit of the same name that is on by default and says nothing about intent: it is set
   * on 303 of this game's 375 objects, the player's health among them. The header flag is set on
   * 23, and they are exactly the counters a save file is made of: the weapons collected, the
   * level reached and the weapon count. Reading the preference instead carried the health across
   * frames too, so dying once left the player dead in every level that followed.
   */
  static isGlobal(def: ObjectDef): boolean {
    return def.headerFlags?.['GlobalObject'] === true;
  }

  /** Hands a newly placed instance whatever its object was last left holding. */
  restore(instance: FusionInstance): void {
    if (!GlobalValues.isGlobal(instance.def)) return;
    const values = this.saved.get(instance.def.id);
    if (values) instance.values = values.slice();
  }

  /**
   * Records what the frame's global objects hold, as it ends. One instance speaks for its
   * object: Fusion stores this per object, not per instance.
   */
  capture(instances: readonly FusionInstance[]): void {
    for (const instance of instances) {
      if (!GlobalValues.isGlobal(instance.def)) continue;
      if (this.saved.has(instance.def.id) && instance.destroyed) continue;
      this.saved.set(instance.def.id, instance.values.slice());
    }
  }
}
