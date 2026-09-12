import { GlobalCoordinates, Vector } from 'excalibur';
import type { Engine, PointerEvent } from 'excalibur';

/**
 * Where the pointer is, whichever pointer the player is actually using.
 *
 * Excalibur numbers pointers by where their native id falls among the ids it has seen and not
 * yet seen the end of, and the game is handed the first of them. That list only ever loses an
 * id on a release. A touch the browser takes away for a gesture of its own is cancelled rather
 * than released, and a cancelled id stays in the list for good: every finger after it is then
 * the second pointer, and a game watching the first never hears from a thumb again. The
 * highlight stays wherever that touch was and nothing can be pressed — one cancelled touch is
 * enough, and it is the menu after a level, which is all pointer, where it shows.
 *
 * So the runtime keeps the pointer itself, out of the events the receiver raises for every
 * pointer rather than out of the one it calls primary. Whichever pointer moved last is the one
 * the game follows, which is what a game written for a single mouse means by "the mouse" and
 * what a player with one finger on the screen means by it too.
 *
 * The position is kept as the page saw it and turned into the game's own coordinates on the way
 * out, the way Excalibur keeps its own: a camera that moves under a pointer that has not moved
 * puts it somewhere else in the frame.
 */
export class GamePointer {
  private page: Vector | null = null;

  /** What the frame that is playing is told, which is set by whoever is running the game. */
  onDown: () => void = () => {};
  onUp: () => void = () => {};
  /** A press the browser took away: nothing was let go of on purpose, and nothing was chosen. */
  onCancel: () => void = () => {};

  constructor(private readonly engine: Engine) {
    const pointers = engine.input.pointers;
    pointers.on('move', this.moved);
    pointers.on('down', this.down);
    pointers.on('up', this.up);
    pointers.on('cancel', this.cancel);
  }

  /** Where the pointer is in the frame, or null until something has pointed at it. */
  position(): { x: number; y: number } | null {
    if (!this.page) return null;
    const world = GlobalCoordinates.fromPagePosition(this.page, this.engine).worldPos;
    return { x: world.x, y: world.y };
  }

  stop(): void {
    const pointers = this.engine.input.pointers;
    pointers.off('move', this.moved);
    pointers.off('down', this.down);
    pointers.off('up', this.up);
    pointers.off('cancel', this.cancel);
  }

  // Where a press landed counts as a move, as it does for a mouse: a finger arrives at a place
  // without ever having travelled to it.
  private readonly moved = (event: PointerEvent): void => {
    this.page = new Vector(event.pagePos.x, event.pagePos.y);
  };

  private readonly down = (event: PointerEvent): void => {
    this.moved(event);
    this.onDown();
  };

  private readonly up = (): void => {
    this.onUp();
  };

  private readonly cancel = (): void => {
    this.onCancel();
  };
}
