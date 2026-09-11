import type { KeyCode } from '../keys';
import { WEAPON_KEYS, WEAPON_OWNED } from '../touch/layout';

/**
 * What a gamepad does, and on which frames.
 *
 * A pad plays a game two different ways. On a level it is the controls: the sticks and the
 * buttons are the keys the game already reads, as the touch controls are. On everything else
 * there is nothing to steer and the game is asking to be clicked on, so the left stick moves a
 * cursor instead and the south button presses it.
 *
 * Which is which is data, as the touch layouts are: a layout names the frames it covers and the
 * keys each part of the pad stands for, and a frame no layout names is one the pad points at
 * rather than plays.
 *
 * The default at the bottom is this game's. A different game is a different list.
 */

/**
 * A button by where the thumb finds it, not by what is printed on it.
 *
 * The letters move between pads: the button under the right thumb is A on one and X on another,
 * and B on one is where circle is on another. The position is what a hand knows, so that is
 * what a layout names, and the browser has already put whatever pad is held into that order.
 */
export type PadButton = 'south' | 'east' | 'west' | 'north' | 'l1' | 'r1' | 'l2' | 'r2';

/** The keys a stick asks for, by the way it is pushed. A direction left out is not read. */
export interface PadSteering {
  left?: KeyCode[];
  right?: KeyCode[];
  up?: KeyCode[];
  down?: KeyCode[];
}

/**
 * Buttons that walk the weapons the player is carrying, one weapon per press.
 *
 * A game of this age reads one key per weapon rather than a next and a previous, so a pair of
 * shoulders has to walk the list itself. `owned` names, per key, an object of the game's whose
 * reading says whether that weapon has been picked up; an empty name is one the player always
 * has. `selected` names the object that says which weapon is in hand, counting from one, which
 * is what keeps the shoulders in step with a weapon chosen by its own key or by a thumb.
 */
export interface PadWeapons {
  previous: PadButton;
  next: PadButton;
  keys: KeyCode[];
  owned?: string[];
  selected?: string;
}

/** The frames a layout covers, and what the pad is while they are playing. */
export interface PadLayout {
  /** The frames this layout is for. */
  frames: number[];
  /** The left stick and the d-pad, which are read as one thing. */
  steer?: PadSteering;
  /** The right stick. */
  aim?: PadSteering;
  /** Held down for as long as the button is. */
  buttons?: Partial<Record<PadButton, KeyCode[]>>;
  weapons?: PadWeapons;
}

/**
 * Gunner 3, as a pad plays it.
 *
 * Its levels are frames 4 to 11; everything else it puts on screen is a menu, a load screen or
 * a map, and every one of those is worked with the mouse.
 *
 * The Gunner walks with left and right and aims with up and down, all four on the same arrows,
 * so the left stick and the d-pad carry the lot and the right stick carries the aim on its own:
 * a thumb that walks and a thumb that aims, for a player who would rather not do both with one.
 *
 * The east button is left out of a level on purpose. It is Escape on every other frame, which is
 * how the game's own screens are left, and the button beside the one that jumps is not where a
 * player wants to find a way out of the level they are playing.
 *
 * The weapons are the same list the touch arrows walk, since it is the same game's weapons in
 * the order it reads them.
 */
export const DEFAULT_PAD_LAYOUTS: PadLayout[] = [
  {
    frames: [4, 5, 6, 7, 8, 9, 10, 11],
    steer: {
      left: ['ArrowLeft'],
      right: ['ArrowRight'],
      up: ['ArrowUp'],
      down: ['ArrowDown'],
    },
    // Up and down and nothing else: pushing the aiming thumb sideways is not a step sideways.
    aim: {
      up: ['ArrowUp'],
      down: ['ArrowDown'],
    },
    buttons: {
      south: ['ShiftLeft'],
      west: ['ControlLeft'],
      north: ['KeyZ'],
    },
    weapons: {
      previous: 'l1',
      next: 'r1',
      keys: WEAPON_KEYS,
      owned: WEAPON_OWNED,
      selected: 'Weapon',
    },
  },
];
