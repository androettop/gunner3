/**
 * What the on-screen controls are, and where they sit.
 *
 * A layout is data, not code: a set of round buttons and at most one steering area, each placed
 * as a fraction of the screen so it lands in the same place whatever size the game is drawn at.
 * Which frames a layout covers is part of it, so a game can have one set of controls on a level
 * and another on a menu, and a frame named by no layout has no controls at all.
 *
 * The default at the bottom is this game's. A different game is a different list.
 */

/** A key as `KeyboardEvent.code` names it, which is what Excalibur reads. */
export type KeyCode = string;

/**
 * The picture on a button.
 *
 * `sprite` is a silhouette of one of the game's own images, named by its handle: the game draws
 * its own actions better than any icon from outside could, and using them copies nothing into
 * the runtime. The rest are drawn here, since no game has a sprite of an arrow.
 */
export type TouchIcon =
  | { kind: 'sprite'; image: number; flip?: boolean }
  | { kind: 'triangle'; towards: 'left' | 'right' }
  | { kind: 'caret'; towards: 'left' | 'right' }
  /** Four corners, which turn inwards once the screen is already full. */
  | { kind: 'fullscreen' }
  /** A picture within a screen, redrawn to match whichever way the game is being fitted. */
  | { kind: 'display-mode' };

/** What a button does to the page rather than to the game. */
export type TouchAction = 'fullscreen' | 'display-mode';

export interface TouchButton {
  id: string;
  /** Held down for as long as the button is, or struck once if `tap` is set. */
  keys: KeyCode[];
  /**
   * A tap sends one press and release however long the finger stays down, for the things that
   * count presses rather than reading the key each frame.
   */
  tap?: boolean;
  /**
   * Struck in turn, one per tap, instead of `keys`. `-1` walks the list backwards. This is how
   * a pair of arrows cycles a game whose own controls are one key per weapon.
   */
  cycle?: { keys: KeyCode[]; step: 1 | -1 };
  /** Works the page instead of the game. */
  action?: TouchAction;
  icon: TouchIcon;
  /**
   * Centre of the button, as a fraction of the screen: 0 is left/top, 1 is right/bottom. A
   * button is held clear of the edges whatever this says, so a corner button is in the corner
   * rather than half off the screen.
   */
  x: number;
  y: number;
  /**
   * Diameter, as a fraction of the largest a button may be. That largest is a quarter of the
   * screen's height or a sixth of its width, whichever is smaller, so a button is round, big
   * enough for a thumb, and never big enough to be in the way.
   */
  size: number;
}

export interface TouchSteering {
  /** The part of the screen that steers, as fractions of it. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * How far the finger has to travel from where it landed before it steers at all, as a
   * fraction of the screen's shorter side. Without it a resting thumb twitches the character.
   */
  deadzone: number;
  left: KeyCode[];
  right: KeyCode[];
  up: KeyCode[];
  down: KeyCode[];
}

export interface TouchLayout {
  /** The frames this layout is for. */
  frames: number[];
  steering?: TouchSteering;
  buttons: TouchButton[];
}

/**
 * The buttons that are up on every frame of every game, whether or not it is being played by
 * touch.
 *
 * How the game is fitted to the screen is a property of the page and not of the frame, and it is
 * as worth reaching on a desktop as on a phone. These sit in a row in the top corner, in the
 * order given, so `x` and `y` are not read for them. These sit in a row in the top corner, in the
 * order given, so `x` and `y` are not read for them.
 */
export const DEFAULT_CHROME: TouchButton[] = [
  { id: 'fullscreen', keys: [], action: 'fullscreen', icon: { kind: 'fullscreen' },
    x: 0, y: 0, size: 0.45 },
  { id: 'display-mode', keys: [], action: 'display-mode', icon: { kind: 'display-mode' },
    x: 0, y: 0, size: 0.45 },
];

/** Gunner 3 reads one key per weapon, in this order, so a pair of arrows walks the list. */
const WEAPON_KEYS: KeyCode[] = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Digit0',
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP',
  'KeyA', 'KeyS',
];

/**
 * Gunner 3's own controls, as this game plays them.
 *
 * Its eight levels take the whole set; its load screen takes nothing but a way back out. The
 * image handles are frames of the game's own animations: the Gunner mid-jump, mid-roll, and one
 * of the guns his arm carries.
 */
export const DEFAULT_LAYOUTS: TouchLayout[] = [
  {
    frames: [4, 5, 6, 7, 8, 9, 10, 11],
    // The whole left half steers, with nothing drawn on it: a thumb that has to find a stick is
    // a thumb watching the controls instead of the game.
    steering: {
      x: 0,
      y: 0,
      width: 0.5,
      height: 1,
      deadzone: 0.05,
      left: ['ArrowLeft'],
      right: ['ArrowRight'],
      up: ['ArrowUp'],
      down: ['ArrowDown'],
    },
    buttons: [
      { id: 'shoot', keys: ['ControlLeft'], icon: { kind: 'sprite', image: 277 },
        x: 0.9, y: 0.52, size: 1 },
      { id: 'jump', keys: ['ShiftLeft'], icon: { kind: 'sprite', image: 24 },
        x: 0.9, y: 0.84, size: 1 },
      { id: 'roll', keys: ['KeyZ'], icon: { kind: 'sprite', image: 2017 },
        x: 0.66, y: 0.87, size: 0.82 },
      { id: 'weapon-previous', keys: [], cycle: { keys: WEAPON_KEYS, step: -1 },
        icon: { kind: 'triangle', towards: 'left' }, x: 0.78, y: 0.12, size: 0.58 },
      { id: 'weapon-next', keys: [], cycle: { keys: WEAPON_KEYS, step: 1 },
        icon: { kind: 'triangle', towards: 'right' }, x: 0.92, y: 0.12, size: 0.58 },
    ],
  },
  {
    // The load screen leaves by the same key a keyboard leaves it by, from the corner a level
    // keeps its weapon arrows in.
    frames: [2],
    buttons: [
      { id: 'back', keys: ['Escape'], tap: true, icon: { kind: 'caret', towards: 'left' },
        x: 0.92, y: 0.12, size: 0.58 },
    ],
  },
];
