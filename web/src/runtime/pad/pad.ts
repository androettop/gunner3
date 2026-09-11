import type { KeyCode } from '../keys';
import { sendKey } from '../keys';
import type { PadButton, PadLayout, PadSteering, PadWeapons } from './layout';

/** What a control asks the game, which is one object's reading at a time. */
export type Reading = (objectName: string) => number | null;

/**
 * A gamepad, playing the game.
 *
 * Nothing in the game knows what a gamepad is: its event tables ask whether a key is down and
 * where the mouse is, so that is what a pad is turned into. Keys go to the window as real
 * KeyboardEvents, the way the touch controls send theirs, and the cursor goes to the canvas as
 * real PointerEvents, which is where Excalibur reads the mouse from. The runtime is not told
 * that any of it came from a pad.
 *
 * On the frames a layout covers, a level, the pad is the controls: the sticks and the d-pad
 * hold down the keys the game steers by, the buttons hold down the rest, and the shoulders walk
 * the weapons the player is carrying. Everywhere else, a menu or a load screen or a map, there
 * is nothing to steer and the game is waiting to be clicked on: the left stick moves a cursor of
 * the runtime's own drawing, and the south button presses it.
 *
 * A pad is polled rather than listened to, which is all the browser offers, so this runs off
 * the animation frame rather than off the game's clock: a stick is read where it stands at the
 * moment the picture is drawn, and a cursor that moves with the picture is a cursor that moves
 * smoothly however fast or slowly the game's own logic is ticking.
 */

/**
 * Where the buttons are on a pad the browser calls "standard", which is every pad worth the
 * name: the browser has already put whatever it is holding into that order.
 *
 * The names are the positions, not the letters printed on them, because the letters move: the
 * button under the right thumb is A on one pad and X on another, and it is the position that
 * the player's thumb knows.
 */
const SOUTH = 0;
const EAST = 1;
const BUTTONS: Record<PadButton, number> = {
  south: SOUTH, east: EAST, west: 2, north: 3, l1: 4, r1: 5, l2: 6, r2: 7,
};
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

/** The sticks, as the standard mapping orders the axes. */
const LEFT_X = 0;
const LEFT_Y = 1;
const RIGHT_X = 2;
const RIGHT_Y = 3;

/**
 * How far a stick has to be pushed before it counts as pushed at all.
 *
 * A stick at rest does not read zero, and a worn one is further out than that. Below this the
 * reading is noise, and a cursor that drifts across the screen on its own is worse than no
 * cursor.
 */
const DEADZONE = 0.18;

/**
 * How fast the cursor crosses the game, as a share of the picture's height each second at full
 * push.
 *
 * Measured against the picture rather than the page, so the cursor takes the same time to cross
 * the game whether it is drawn in a corner of a monitor or blown up to a whole screen.
 */
const CURSOR_SPEED = 0.85;

/**
 * How far a stick goes before it holds a key down, and how far back it comes before it lets go.
 *
 * A key is down or it is not, and a stick held near the line between them would otherwise
 * chatter: pressed and released and pressed again several times a second, which the game reads
 * as a player tapping a direction rather than walking in it. Letting go further back than it
 * takes to press settles that, and the gap is wide enough to cover a stick the player is
 * holding still by hand.
 */
const PUSH = 0.55;
const RELEASE = 0.35;

/** How far a stick has to move between two readings to be a hand rather than a stick settling. */
const STIR = 0.15;

/** A pointer id of its own, so the cursor is never confused with the player's real mouse. */
const POINTER_ID = 9001;

export class PadControl {
  private readonly cursor: HTMLDivElement;
  private readonly layouts: PadLayout[];
  private frame = -1;

  /**
   * Where the cursor is, in the page's own coordinates, or null before a pad has ever moved it.
   *
   * Kept across frames: a player who leaves a menu for a level and comes back finds the cursor
   * where they left it rather than in the middle again.
   */
  private at: { x: number; y: number } | null = null;

  /** Buttons that were down when the pad was last read, for telling a press from a hold. */
  private pressed = new Set<number>();

  /** Keys the pad is holding down, so that letting go of one lets go of exactly its own. */
  private readonly holding = new Set<KeyCode>();

  /**
   * Which weapon the shoulders last asked for, for a game that does not say which it is on.
   *
   * A layout that names the object holding the answer never reads this: the game itself is the
   * better witness, since a weapon can also be chosen by its own key or by a thumb.
   */
  private weaponAt = 0;

  /** Set while dispatching, so the cursor does not mistake its own pointer for a real one. */
  private sending = false;

  private visible = false;

  /**
   * Whether the pad is the thing being played with, which the page's own cursor is asked to
   * keep out of the way of.
   *
   * A mouse pointer sitting over a game nobody is pointing with is in the way of the game, and
   * on a level, where the pad draws no cursor of its own, it is the only thing on screen still
   * claiming there is a mouse. It goes as soon as a pad is touched and comes back the moment
   * the mouse is moved, which is the same hand-over the drawn cursor makes in the other
   * direction.
   */
  private driving = false;

  /** The pad as it was last read, for telling a hand moving it from a stick that leans. */
  private wasAt: number[] | null = null;
  private wasDown = 0;

  private polling = 0;
  private lastPoll = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    layouts: PadLayout[],
    /** What the game says about itself, which is how the shoulders know what it is carrying. */
    private readonly reading: Reading = () => null,
  ) {
    this.layouts = layouts;
    this.cursor = document.createElement('div');
    this.cursor.className = 'fusion-pad-cursor';
    this.cursor.append(style());
    this.cursor.insertAdjacentHTML('beforeend', ARROW);
    // Down until a pad moves it. Most players have no pad at all, and an arrow parked in the
    // corner of the page for every one of them is the runtime drawing on a game it was asked
    // to play.
    this.cursor.style.display = 'none';
    document.body.append(this.cursor);

    // A real mouse takes the screen back: two cursors on one page, only one of which answers
    // the hand moving it, is a game that looks broken. The pad shows its own again as soon as
    // it is touched.
    this.canvas.addEventListener('pointermove', this.realPointer);
    window.addEventListener('gamepaddisconnected', this.hide);

    this.polling = requestAnimationFrame(this.poll);
  }

  /** Which frame is playing, since a level is played and everything else is pointed at. */
  show(frame: number): void {
    if (frame === this.frame) return;
    this.frame = frame;
    // Whatever the pad was holding belongs to the frame that has just gone: a key still down
    // across a jump is a player walking into the next level.
    this.releaseAll();
    if (this.layout) this.hide();
  }

  /** Takes the cursor off the page and stops reading the pad. */
  stop(): void {
    cancelAnimationFrame(this.polling);
    this.canvas.removeEventListener('pointermove', this.realPointer);
    window.removeEventListener('gamepaddisconnected', this.hide);
    this.releaseAll();
    this.canvas.style.cursor = '';
    this.cursor.remove();
  }

  /** The layout for the frame being played, or nothing on a frame the pad only points at. */
  private get layout(): PadLayout | undefined {
    return this.layouts.find((layout) => layout.frames.includes(this.frame));
  }

  private readonly poll = (now: number): void => {
    this.polling = requestAnimationFrame(this.poll);

    // The first frame after a wait has no elapsed time worth trusting, and a tab that was away
    // for a minute must not throw the cursor across the screen on the frame it comes back.
    const elapsed = this.lastPoll ? Math.min((now - this.lastPoll) / 1000, 0.1) : 0;
    this.lastPoll = now;

    const pad = connectedPad();
    // A pad unplugged mid-game leaves whatever it was holding down held, which is a player
    // walking into a wall for ever.
    if (!pad) {
      this.releaseAll();
      this.hide();
      return;
    }

    if (this.stirred(pad)) this.drive();

    const layout = this.layout;
    if (layout) {
      this.hide();
      this.play(pad, layout);
    } else {
      this.aimCursor(pad, elapsed);
      this.cursorButtons(pad);
    }
  };

  /**
   * The pad as the game's own controls.
   *
   * What the pad is asking for is worked out from scratch each time it is read, as a set of
   * keys, and the difference against what it was holding a moment ago is what is sent. A key
   * wanted by two things at once, the aim on the right stick and the aim on the left, is one
   * key held once, and it stays down until neither asks for it any more.
   */
  private play(pad: Gamepad, layout: PadLayout): void {
    const wanted = new Set<KeyCode>();

    // The d-pad reads as a stick pushed the whole way, so a player need not know which of the
    // two the pad in their hands steers with.
    if (layout.steer) {
      this.directions(wanted, layout.steer,
        pushed(stick(pad, LEFT_X), pad, DPAD_RIGHT, DPAD_LEFT),
        pushed(stick(pad, LEFT_Y), pad, DPAD_DOWN, DPAD_UP));
    }
    if (layout.aim) {
      this.directions(wanted, layout.aim, stick(pad, RIGHT_X), stick(pad, RIGHT_Y));
    }
    for (const [name, keys] of Object.entries(layout.buttons ?? {})) {
      if (down(pad, BUTTONS[name as PadButton])) for (const key of keys) wanted.add(key);
    }

    this.hold(wanted);
    this.shoulders(pad, layout.weapons);
  }

  /** The keys a stick pushed this way asks for, with the ones it already holds held on to. */
  private directions(into: Set<KeyCode>, steering: PadSteering, x: number, y: number): void {
    const pushed = (value: number, keys: KeyCode[] | undefined): boolean => {
      if (!keys?.length) return false;
      // A key already down comes up further back than it went down, so a stick held near the
      // line between the two does not chatter.
      return value >= (keys.some((key) => this.holding.has(key)) ? RELEASE : PUSH);
    };
    if (pushed(-x, steering.left)) for (const key of steering.left!) into.add(key);
    if (pushed(x, steering.right)) for (const key of steering.right!) into.add(key);
    if (pushed(-y, steering.up)) for (const key of steering.up!) into.add(key);
    if (pushed(y, steering.down)) for (const key of steering.down!) into.add(key);
  }

  /** Holds down exactly the keys asked for, and lets go of everything else. */
  private hold(wanted: Set<KeyCode>): void {
    for (const key of this.holding) {
      if (!wanted.has(key)) { this.holding.delete(key); sendKey('keyup', key); }
    }
    for (const key of wanted) {
      if (!this.holding.has(key)) { this.holding.add(key); sendKey('keydown', key); }
    }
  }

  /**
   * The shoulders, which walk the weapons one press at a time.
   *
   * A game of this age has a key per weapon rather than a next and a previous, so the walking
   * is done here: where the game says it is now, one step on in the asked-for direction, over
   * everything it has not picked up, and the key for what it lands on is struck once.
   */
  private shoulders(pad: Gamepad, weapons: PadWeapons | undefined): void {
    if (!weapons) return;
    const pressed = new Set<number>();
    for (const button of [BUTTONS[weapons.previous], BUTTONS[weapons.next]]) {
      if (down(pad, button)) pressed.add(button);
    }
    for (const button of pressed) {
      if (this.pressed.has(button)) continue;
      this.weapon(weapons, button === BUTTONS[weapons.next] ? 1 : -1);
    }
    this.pressed = pressed;
  }

  private weapon(weapons: PadWeapons, step: 1 | -1): void {
    // The game is the better witness of what is in hand, since a weapon can also be chosen by
    // its own key or by a thumb on the touch controls; without one, what was last asked for.
    const selected = weapons.selected ? this.reading(weapons.selected) : null;
    const from = selected && selected > 0 ? selected - 1 : this.weaponAt;

    const { keys, owned } = weapons;
    for (let moved = 1; moved <= keys.length; moved++) {
      const at = (((from + step * moved) % keys.length) + keys.length) % keys.length;
      const name = owned?.[at];
      // Stepped over unless the game says it is being carried. A name left empty is one the
      // player always has, which is the weapon they start the game holding.
      if (name && (this.reading(name) ?? 0) <= 0) continue;
      this.weaponAt = at;
      sendKey('keydown', keys[at]);
      sendKey('keyup', keys[at]);
      return;
    }
  }

  /**
   * Moves the cursor by where the stick is.
   *
   * The d-pad reads as a stick pushed the whole way, so one or the other steers and a player
   * need not know which the pad they picked up has. The push is squared, keeping its sign, so
   * that the far end of the stick is the speed above and the near end is fine enough to pick
   * one button out of a column.
   */
  private aimCursor(pad: Gamepad, elapsed: number): void {
    const x = pushed(axis(pad, LEFT_X), pad, DPAD_RIGHT, DPAD_LEFT);
    const y = pushed(axis(pad, LEFT_Y), pad, DPAD_DOWN, DPAD_UP);
    if (!x && !y) return;

    const picture = this.canvas.getBoundingClientRect();
    if (!picture.width || !picture.height) return;

    // Placed in the middle of the picture the first time a pad asks for it, since a cursor has
    // to start somewhere and the middle is the shortest way to anywhere.
    if (!this.at) this.at = { x: picture.left + picture.width / 2, y: picture.top + picture.height / 2 };

    const speed = picture.height * CURSOR_SPEED * elapsed;
    // The cursor stays on the game. Everything it can ask for is drawn there, and a cursor lost
    // on the black around a letterboxed picture is a cursor the player has to hunt for.
    this.at.x = clamp(this.at.x + curve(x) * speed, picture.left, picture.right - 1);
    this.at.y = clamp(this.at.y + curve(y) * speed, picture.top, picture.bottom - 1);

    this.draw();
    this.point('pointermove');
  }

  /** Presses and releases, from the buttons that changed since the pad was last read. */
  private cursorButtons(pad: Gamepad): void {
    const now = new Set<number>();
    for (let button = 0; button < pad.buttons.length; button++) {
      if (pad.buttons[button]?.pressed) now.add(button);
    }

    // The cursor is what the south button presses, so it has to be somewhere first: a button
    // struck before the stick has ever been pushed puts it up in the middle of the picture
    // rather than clicking on nothing.
    if (now.size && !this.at) this.aimCursor(pad, 0);

    for (const button of now) if (!this.pressed.has(button)) this.down(button);
    for (const button of this.pressed) if (!now.has(button)) this.up(button);
    this.pressed = now;
  }

  private down(button: number): void {
    if (button === SOUTH) { this.draw(); this.point('pointerdown'); }
    // The one button that is a key rather than a press: the game leaves its own screens by
    // Escape, and the button under the right thumb's thumb is where a player looks for "back".
    else if (button === EAST) sendKey('keydown', 'Escape');
  }

  private up(button: number): void {
    if (button === SOUTH) this.point('pointerup');
    else if (button === EAST) sendKey('keyup', 'Escape');
  }

  /** Lets go of everything the pad was holding, wherever the game is going next. */
  private releaseAll(): void {
    for (const button of this.pressed) this.up(button);
    this.pressed.clear();
    this.hold(new Set());
  }

  /**
   * Hands the cursor to the game as a mouse.
   *
   * Dispatched at the canvas, which is where Excalibur listens, and no further: the page's own
   * listeners are not told that a pointer went down when no hand put one there.
   */
  private point(type: 'pointermove' | 'pointerdown' | 'pointerup'): void {
    if (!this.at) return;
    const event = new PointerEvent(type, {
      pointerId: POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: this.at.x,
      clientY: this.at.y,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' ? 1 : 0,
      bubbles: false,
      cancelable: true,
    });
    // Excalibur works out where on the game a pointer landed from the page coordinates, and an
    // event built rather than raised does not fill those in everywhere.
    Object.defineProperty(event, 'pageX', { value: this.at.x + window.scrollX });
    Object.defineProperty(event, 'pageY', { value: this.at.y + window.scrollY });

    this.sending = true;
    this.canvas.dispatchEvent(event);
    this.sending = false;
  }

  private draw(): void {
    if (!this.at) return;
    this.cursor.style.transform = `translate(${this.at.x}px, ${this.at.y}px)`;
    if (!this.visible) {
      this.visible = true;
      this.cursor.style.display = '';
    }
  }

  private readonly hide = (): void => {
    if (!this.visible) return;
    this.visible = false;
    this.cursor.style.display = 'none';
  };

  /**
   * Whether a hand has just done something to the pad.
   *
   * Asked of what changed rather than of where things are, because a pad at rest is not at
   * zero: a stick can lean, and a worn one can lean the whole way. Taking a leaning stick for a
   * hand on the pad would hide the page's pointer and never give it back, since every mouse
   * move handing it over would be undone on the very next reading.
   */
  private stirred(pad: Gamepad): boolean {
    let down = 0;
    for (let button = 0; button < Math.min(pad.buttons.length, 32); button++) {
      if (pad.buttons[button]?.pressed) down |= 1 << button;
    }
    // The first reading is what the pad looks like left alone, not something anybody did.
    const before = this.wasAt;
    const moved = before !== null &&
      pad.axes.some((value, at) => Math.abs((value ?? 0) - (before[at] ?? 0)) >= STIR);
    const struck = down !== 0 && down !== this.wasDown;

    this.wasAt = [...pad.axes];
    this.wasDown = down;
    return moved || struck;
  }

  /** The pad has the game: the page's own pointer is not wanted over it. */
  private drive(): void {
    if (this.driving) return;
    this.driving = true;
    this.canvas.style.cursor = 'none';
  }

  /** The mouse has it back, drawn cursor down and the page's own pointer up. */
  private readonly realPointer = (): void => {
    if (this.sending) return;
    this.hide();
    if (!this.driving) return;
    this.driving = false;
    this.canvas.style.cursor = '';
  };
}

/**
 * The pad being played on, which is the first one with anything to say.
 *
 * A machine can have several plugged in, and the ones nobody is holding still report: a wheel,
 * a dance mat, a pad left in a drawer. Taking the first that is connected and standard is what
 * a player expects, since the pad in their hands is the one they just picked up.
 */
function connectedPad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  for (const pad of pads) if (pad?.connected) return pad;
  return null;
}

/** A stick reading as it stands, for the thresholds that decide whether a key is down. */
function stick(pad: Gamepad, index: number): number {
  return pad.axes[index] ?? 0;
}

/**
 * The d-pad and the stick as one push.
 *
 * A d-pad is pressed or it is not, so when it is pressed it is the whole answer. Reading the
 * stick first and the pad only if the stick says zero leaves the pad unread: a stick at rest
 * hardly ever reads exactly zero, and a thousandth of a push is enough to stand in front of a
 * d-pad held the whole way. That thousandth steers nothing itself, being far inside the
 * deadzone, so the two together read as a d-pad that does nothing at all.
 */
function pushed(reading: number, pad: Gamepad, plus: number, minus: number): number {
  const keyed = held(pad, plus) - held(pad, minus);
  return keyed !== 0 ? keyed : reading;
}

/** Whether a button a layout names is down, for a pad that may not have it at all. */
function down(pad: Gamepad, button: number): boolean {
  return pad.buttons[button]?.pressed ?? false;
}

/** A stick reading, with the rest around the middle taken out. */
function axis(pad: Gamepad, index: number): number {
  const value = pad.axes[index] ?? 0;
  if (Math.abs(value) < DEADZONE) return 0;
  // Measured from the edge of the deadzone rather than from the middle, so the first movement
  // past it is the slowest one rather than a jump to a fifth of full speed.
  return (value - Math.sign(value) * DEADZONE) / (1 - DEADZONE);
}

function held(pad: Gamepad, button: number): number {
  return pad.buttons[button]?.pressed ? 1 : 0;
}

/** Squared, sign kept: the far end of the stick is fast and the near end is precise. */
function curve(value: number): number {
  return value * Math.abs(value);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The cursor, drawn rather than borrowed.
 *
 * The page's own cursor cannot be moved by a page, so the pad brings one of its own: white with
 * a dark edge, which is the one shape that stays visible over a game whatever colour the game
 * is. Its point is the top-left corner of the picture, so where it is put is where it points.
 */
const ARROW = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M1 0.5 L1 17.5 L5.4 13.6 L8.3 20.4 L11.4 19.1 L8.5 12.5 L14.2 12.4 Z"
        fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round" />
</svg>`;

function style(): HTMLStyleElement {
  const element = document.createElement('style');
  element.textContent = `
.fusion-pad-cursor {
  position: fixed;
  left: 0;
  top: 0;
  /* Over the game and over the touch controls, since it is what is being pointed with. */
  z-index: 11;
  /* It is drawn, not reached for: a cursor that answers a click is a cursor in the way. */
  pointer-events: none;
  /* Big enough to find on a television, small enough not to cover what it is pointing at. */
  width: clamp(18px, 3.4vh, 34px);
  height: clamp(18px, 3.4vh, 34px);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55));
}
.fusion-pad-cursor svg {
  width: 100%;
  height: 100%;
  display: block;
}
`;
  return element;
}
