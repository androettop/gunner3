/**
 * What the game is being played with, at this moment.
 *
 * Three things can play it and none of them is a setting to be chosen: a player picks up a pad,
 * puts it down and reaches for the mouse, or turns the phone over in their hands, and what is
 * drawn over the game has to follow them rather than wait to be told. So the runtime watches
 * what actually arrives and says when it changes.
 *
 * Only a hand counts. The touch controls send keys of their own and the pad sends a pointer of
 * its own, and a watcher that took those for a player would answer its own echo and never leave
 * the mode it was in; every one of them is untrusted, which is the browser saying exactly that.
 */

/**
 * Mouse covers the keyboard as well: they are the same player, sitting at the same desk, and
 * the game was built for the pair of them.
 */
export type InputMode = 'mouse' | 'touch' | 'pad';

export class InputWatcher {
  private current: InputMode;

  /**
   * The id the machine's own mouse arrives under, for anything that wants to arrive as it.
   *
   * Browsers do not agree on what it is, so it is taken from the first real pointer rather
   * than assumed.
   */
  mouseId = 1;

  constructor(
    private readonly onChange: (mode: InputMode) => void,
    /** What to assume until something arrives; the machine is the only clue there is. */
    initial: InputMode = 'mouse',
  ) {
    this.current = initial;
    // Caught on the way down, and on the window rather than on the canvas: a thumb on the
    // controls drawn over the game is as much a thumb as one on the game itself.
    window.addEventListener('pointerdown', this.pointer, true);
    window.addEventListener('pointermove', this.pointer, true);
    window.addEventListener('keydown', this.key, true);
  }

  get mode(): InputMode {
    return this.current;
  }

  /** Says what is being played with now, and tells whoever is listening if that is news. */
  use(mode: InputMode): void {
    if (mode === this.current) return;
    this.current = mode;
    this.onChange(mode);
  }

  stop(): void {
    window.removeEventListener('pointerdown', this.pointer, true);
    window.removeEventListener('pointermove', this.pointer, true);
    window.removeEventListener('keydown', this.key, true);
  }

  private readonly pointer = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    if (event.pointerType === 'touch') {
      this.use('touch');
      return;
    }
    if (typeof event.pointerId === 'number') this.mouseId = event.pointerId;
    this.use('mouse');
  };

  private readonly key = (event: KeyboardEvent): void => {
    if (event.isTrusted) this.use('mouse');
  };
}

/**
 * What the machine looks like it is, for the moment before anything has been played with.
 *
 * A phone or a tablet says so in its user agent, and iPads since iOS 13 say they are desktops
 * and give themselves away by the number of fingers they accept instead. It is only ever the
 * first answer: the first thing a player actually does settles it.
 */
export function looksLikeTouch(): boolean {
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini|Mobile/i.test(agent)) {
    return true;
  }
  // An iPad since iOS 13 calls itself a Mac; a Mac that takes a finger is one.
  return /Macintosh/.test(agent) && navigator.maxTouchPoints > 0;
}
