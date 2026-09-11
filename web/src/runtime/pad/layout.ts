/**
 * What a gamepad does, and on which frames.
 *
 * A pad plays a game two different ways. On a level it is the controls: a stick steers and the
 * buttons are the keys the game already reads, as the touch controls are. On everything else
 * there is nothing to steer and the game is asking to be clicked on, so the stick moves a
 * cursor instead and a button presses it.
 *
 * Which is which is data, as the touch layouts are: a layout names the frames it covers, and a
 * frame no layout names is one the pad points at rather than plays.
 *
 * The default at the bottom is this game's. A different game is a different list.
 */

/** The frames a layout covers and what the pad does on them. */
export interface PadLayout {
  /** The frames this layout is for. */
  frames: number[];
}

/**
 * Gunner 3's levels are its frames 4 to 11; everything else it puts on screen is a menu, a load
 * screen or a map, and every one of those is worked with the mouse.
 */
export const DEFAULT_PAD_LAYOUTS: PadLayout[] = [
  { frames: [4, 5, 6, 7, 8, 9, 10, 11] },
];
