import type { ImageSource } from 'excalibur';
import type { KeyCode, TouchButton, TouchIcon, TouchLayout, TouchSteering } from './layout';

/**
 * The parts of the page a button can work, as opposed to the parts of the game.
 *
 * The overlay does not know what a display mode is or how a browser goes fullscreen; it knows
 * that a button was pressed and hands that on.
 */
export interface Shell {
  isFullscreen(): boolean;
  toggleFullscreen(): Promise<void>;
  /** Moves to the next way of fitting the game to the screen, and says which that is. */
  cycleDisplayMode(): string;
  displayMode(): string;
}

/**
 * Touch controls, over the screen.
 *
 * The game is played by keyboard: its own event tables ask whether a key is down, so the shortest
 * way to hand it a thumb is to give it the keys it already reads. Everything here is HTML sitting
 * over the page, and what it produces is `keydown` and `keyup` on the window, which is where
 * Excalibur listens. Nothing in the game knows it is being played by touch.
 *
 * The controls are placed against the screen rather than against the canvas. A game drawn at its
 * own fixed size leaves bands of empty page around it on a phone, and a thumb reaches the corner
 * of the screen far more easily than the corner of a letterboxed picture.
 *
 * The controls are only up on the frames a layout names, so a level is played with a thumb and
 * a menu is not covered by buttons it has no use for.
 */
export class ControlOverlay {
  private readonly root: HTMLDivElement;
  private readonly layouts: TouchLayout[];
  /** Which key each pointer is currently holding, so releasing one lets go of exactly its own. */
  private readonly held = new Map<number, KeyCode[]>();
  private readonly down = new Map<KeyCode, number>();
  /**
   * Where each cycle has got to, kept by the list rather than by the button, so that a pair of
   * arrows walking the same list walks it together.
   */
  private readonly cycles = new Map<string, number>();
  private steering: { pointer: number; from: { x: number; y: number }; keys: Set<KeyCode> } | null =
    null;
  private frame = -1;

  constructor(
    layouts: TouchLayout[],
    private readonly chrome: TouchButton[],
    private readonly silhouette: (handle: number) => string | null,
    private readonly shell: Shell,
  ) {
    this.layouts = layouts;
    this.root = document.createElement('div');
    this.root.className = 'fusion-touch';
    // Without a game to play by thumb, the buttons left are page furniture rather than
    // controls, and furniture does not need to be the size of a thumb.
    if (layouts.length === 0) this.root.classList.add('is-lean');
    // Without a game to play by thumb, the two buttons left are page furniture rather than
    // controls, and furniture does not need to be the size of a thumb.
    if (layouts.length === 0) this.root.classList.add('is-lean');
    this.root.append(style());
    document.body.append(this.root);

    this.place();
    window.addEventListener('resize', this.place);
    window.addEventListener('orientationchange', this.place);
  }

  /** Puts up the layout for a frame, or takes the controls down if no layout covers it. */
  show(frame: number): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.releaseAll();
    for (const child of Array.from(this.root.children)) {
      if (child.tagName !== 'STYLE') child.remove();
    }

    // The steering area goes down first: it covers half the screen, and a button under it would
    // be a button the pad answers for. The chrome is up whatever the frame is; the game's own
    // controls are up only where a layout says they belong.
    const layout = this.layouts.find((l) => l.frames.includes(frame));
    if (layout?.steering) this.root.append(this.steeringPad(layout.steering));

    // The chrome is a row in the corner rather than a set of places on the screen: two buttons
    // that belong together should sit together, on a phone and on a monitor alike.
    const chrome = document.createElement('div');
    chrome.className = 'fusion-touch-chrome';
    for (const button of this.chrome) chrome.append(this.button(button, true));
    this.root.append(chrome);

    for (const button of layout?.buttons ?? []) this.root.append(this.button(button));
    this.place();
  }

  destroy(): void {
    this.releaseAll();
    window.removeEventListener('resize', this.place);
    window.removeEventListener('orientationchange', this.place);
    this.root.remove();
  }

  /** Redraws the two buttons that show a state rather than only causing one. */
  private readonly place = (): void => {
    const full = this.shell.isFullscreen();
    for (const icon of Array.from(this.root.querySelectorAll('.is-fullscreen'))) {
      icon.classList.toggle('is-inside', full);
    }
    const mode = this.shell.displayMode();
    for (const icon of Array.from(this.root.querySelectorAll('.is-display-mode'))) {
      icon.querySelector('.inner')?.setAttribute('d', INNER_SCREEN[mode] ?? INNER_SCREEN.Fixed);
    }
  };

  private get width(): number {
    return this.root.clientWidth || window.innerWidth;
  }

  private get height(): number {
    return this.root.clientHeight || window.innerHeight;
  }

  private steeringPad(steering: TouchSteering): HTMLElement {
    const pad = document.createElement('div');
    pad.className = 'fusion-touch-pad';
    pad.style.left = `${steering.x * 100}%`;
    pad.style.top = `${steering.y * 100}%`;
    pad.style.width = `${steering.width * 100}%`;
    pad.style.height = `${steering.height * 100}%`;

    pad.addEventListener('pointerdown', (e) => {
      try {
        pad.setPointerCapture(e.pointerId);
      } catch {
        // Steering reads the moves either way; capture only keeps them coming off the pad.
      }
      this.steering = { pointer: e.pointerId, from: { x: e.clientX, y: e.clientY }, keys: new Set() };
      e.preventDefault();
    });

    pad.addEventListener('pointermove', (e) => {
      const steer = this.steering;
      if (!steer || steer.pointer !== e.pointerId) return;
      // The finger steers by where it has moved to, not by where it landed: it is the offset
      // from the first touch that says which way to go, and it keeps saying so while it rests.
      const unit = Math.min(this.width, this.height);
      const dead = steering.deadzone * unit;
      const dx = e.clientX - steer.from.x;
      const dy = e.clientY - steer.from.y;

      const wanted = new Set<KeyCode>();
      if (dx <= -dead) for (const k of steering.left) wanted.add(k);
      if (dx >= dead) for (const k of steering.right) wanted.add(k);
      if (dy <= -dead) for (const k of steering.up) wanted.add(k);
      if (dy >= dead) for (const k of steering.down) wanted.add(k);

      for (const key of steer.keys) if (!wanted.has(key)) this.release(key);
      for (const key of wanted) if (!steer.keys.has(key)) this.press(key);
      steer.keys = wanted;
      e.preventDefault();
    });

    const lift = (e: PointerEvent) => {
      const steer = this.steering;
      if (!steer || steer.pointer !== e.pointerId) return;
      for (const key of steer.keys) this.release(key);
      this.steering = null;
    };
    pad.addEventListener('pointerup', lift);
    pad.addEventListener('pointercancel', lift);
    return pad;
  }

  private button(button: TouchButton, inRow = false): HTMLElement {
    const element = document.createElement('button');
    element.className = inRow ? 'fusion-touch-button is-chrome' : 'fusion-touch-button';
    element.type = 'button';
    element.setAttribute('aria-label', button.id);
    // The size is a share of the largest a button may be, and the position is clamped so that
    // whatever the layout asks for, the button stays a padded distance inside the screen.
    element.style.setProperty('--asked', `calc(var(--button) * ${button.size})`);
    element.style.setProperty('--x', `${button.x * 100}%`);
    element.style.setProperty('--y', `${button.y * 100}%`);
    element.append(this.icon(button.icon));

    element.addEventListener('pointerdown', (e) => {
      // Capture keeps a finger that slides off the button still owned by it. A browser that
      // refuses is no reason for the button not to work.
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is gone already; the lift handlers still run.
      }
      element.classList.add('is-down');

      if (button.action === 'fullscreen') {
        void this.shell.toggleFullscreen().then(this.place);
      } else if (button.action === 'display-mode') {
        this.shell.cycleDisplayMode();
        this.place();
      } else if (button.cycle) {
        // A cycle keeps its own place in the list: the game selects a weapon by its own key and
        // never says which one it has, so the arrows walk the list rather than follow the game.
        const { keys, step } = button.cycle;
        const list = keys.join(',');
        const cursor = ((this.cycles.get(list) ?? 0) + step + keys.length) % keys.length;
        this.cycles.set(list, cursor);
        this.strike(keys[cursor]);
      } else if (button.tap) {
        for (const key of button.keys) this.strike(key);
      } else {
        for (const key of button.keys) this.press(key);
        this.held.set(e.pointerId, button.keys);
      }
      e.preventDefault();
    });

    const lift = (e: PointerEvent) => {
      element.classList.remove('is-down');
      const keys = this.held.get(e.pointerId);
      if (!keys) return;
      this.held.delete(e.pointerId);
      for (const key of keys) this.release(key);
    };
    element.addEventListener('pointerup', lift);
    element.addEventListener('pointercancel', lift);
    return element;
  }

  private icon(icon: TouchIcon): Element {
    if (icon.kind === 'sprite') {
      // The silhouette is made from the sprite the game already has in hand, so the button shows
      // the game's own drawing of the thing the button does.
      const url = this.silhouette(icon.image);
      const element = document.createElement('span');
      element.className = 'fusion-touch-icon';
      if (url) {
        element.style.maskImage = `url(${url})`;
        element.style.webkitMaskImage = `url(${url})`;
        if (icon.flip) element.style.transform = 'scaleX(-1)';
      }
      return element;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'fusion-touch-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    if (icon.kind === 'display-mode') {
      // A screen with the game inside it, drawn the way the game is currently being fitted.
      svg.classList.add('is-display-mode');
      const screen = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      screen.setAttribute('fill', 'none');
      screen.setAttribute('stroke', 'currentColor');
      screen.setAttribute('stroke-width', '9');
      screen.setAttribute('stroke-linejoin', 'round');
      screen.setAttribute('d', 'M10 20 H90 V80 H10 Z');
      path.setAttribute('class', 'inner');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('d', INNER_SCREEN.Fixed);
      svg.append(screen, path);
      return svg;
    }

    if (icon.kind === 'fullscreen') {
      // Four corners pointing out, and the same four turned in once the screen is already full.
      svg.classList.add('is-fullscreen');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '12');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', 'M34 12 H12 V34 M66 12 H88 V34 M88 66 V88 H66 M34 88 H12 V66');
      svg.append(path);
      return svg;
    }

    const back = icon.towards === 'left';
    if (icon.kind === 'triangle') {
      path.setAttribute('d', back ? 'M70 22 L70 78 L28 50 Z' : 'M30 22 L30 78 L72 50 Z');
    } else {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '11');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', back ? 'M62 22 L34 50 L62 78' : 'M38 22 L66 50 L38 78');
    }
    svg.append(path);
    return svg;
  }

  /** One press and release, for the things the game counts rather than reads. */
  private strike(key: KeyCode): void {
    this.press(key);
    this.release(key);
  }

  /**
   * Two fingers can want the same key, so it is counted rather than flagged: it goes down on the
   * first and only comes up on the last.
   */
  private press(key: KeyCode): void {
    const count = this.down.get(key) ?? 0;
    this.down.set(key, count + 1);
    if (count === 0) send('keydown', key);
  }

  private release(key: KeyCode): void {
    const count = this.down.get(key) ?? 0;
    if (count <= 1) {
      this.down.delete(key);
      send('keyup', key);
    } else {
      this.down.set(key, count - 1);
    }
  }

  private releaseAll(): void {
    for (const key of [...this.down.keys()]) send('keyup', key);
    this.down.clear();
    this.held.clear();
    this.steering = null;
  }
}

/**
 * Excalibur listens for keys on the window and reads `code`, so that is what is sent. The events
 * are the real thing, which means anything else the page has bound sees them too.
 */
function send(type: 'keydown' | 'keyup', code: KeyCode): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
}

function style(): HTMLStyleElement {
  const element = document.createElement('style');
  element.textContent = `
.fusion-touch {
  position: fixed;
  inset: 0;
  z-index: 10;
  --button: min(25vh, 16.6667vw);
  /* One measure for the edge of the screen and for the space between buttons, taken from the
     width both times so that it is the same distance across as it is down. A share of the
     screen while it is played by thumb, and a fixed step when the buttons are only furniture. */
  --gap: 1.75vw;
  /* No cap while the game is being played by thumb: a button is as big as the screen allows. */
  --cap: 100000px;
  /* The overlay is a frame for the controls and nothing else. Everything that is not a button
     or the steering area passes straight through it to the game underneath, so the menus are
     still worked with a mouse or a finger while the controls are up. */
  pointer-events: none;
  -webkit-user-select: none;
  user-select: none;
}
.fusion-touch.is-lean {
  --gap: 16px;
  --cap: 60px;
}
/* The row is a place to put buttons, not a surface: only the buttons in it take a touch. */
.fusion-touch-chrome {
  pointer-events: none;
}
.fusion-touch-pad {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
}
.fusion-touch-chrome {
  position: absolute;
  left: var(--pad);
  top: var(--pad);
  display: flex;
  gap: calc(var(--button) * 0.16);
}
.fusion-touch-button.is-chrome {
  position: relative;
  left: auto;
  top: auto;
  transform: none;
}
.fusion-touch-button.is-chrome.is-down { transform: scale(0.94); }
.fusion-touch-chrome {
  position: absolute;
  left: var(--gap);
  top: var(--gap);
  display: flex;
  gap: var(--gap);
}
.fusion-touch-button.is-chrome {
  position: relative;
  left: auto;
  top: auto;
  transform: none;
}
.fusion-touch-button.is-chrome.is-down { transform: scale(0.94); }
.fusion-touch-button {
  position: absolute;
  /* A button is as wide as it is tall, never taller than a quarter of the screen nor wider than
     a sixth of it, and never closer to an edge than the padding. */
  --size: min(var(--asked), var(--cap));
  --size: min(var(--asked), var(--cap));
  width: var(--size);
  height: var(--size);
  left: clamp(calc(var(--gap) + var(--size) / 2), var(--x), calc(100% - var(--gap) - var(--size) / 2));
  top: clamp(calc(var(--gap) + var(--size) / 2), var(--y), calc(100% - var(--gap) - var(--size) / 2));
  transform: translate(-50%, -50%);
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.17);
  color: rgba(12, 14, 20, 0.42);
  display: grid;
  place-items: center;
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 80ms linear, transform 80ms linear;
}
.fusion-touch-button.is-down {
  background: rgba(255, 255, 255, 0.32);
  color: rgba(12, 14, 20, 0.6);
  transform: translate(-50%, -50%) scale(0.94);
}
.fusion-touch-icon {
  width: 58%;
  height: 58%;
  color: inherit;
  fill: currentColor;
  /* A sprite arrives as a mask, so what shows is its shape in the button's own colour. */
  background: currentColor;
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  /* The silhouette comes from pixel art and is enlarged in whole pixels, so it stays pixel art
     rather than turning into a smudge of it. */
  image-rendering: pixelated;
}
svg.fusion-touch-icon { background: none; }
.fusion-touch-icon.is-fullscreen { width: 52%; height: 52%; }
/* Full already: the same corners, turned inwards. */
.fusion-touch-icon.is-fullscreen.is-inside { transform: rotate(180deg); }
`;
  return element;
}

/** What the game looks like inside the screen, one shape per way of fitting it. */
const INNER_SCREEN: Record<string, string> = {
  Fixed: 'M38 40 H62 V60 H38 Z',
  FitScreen: 'M22 32 H78 V68 H22 Z',
};

/** How wide a silhouette is drawn before the button scales it, in whole sprite pixels. */
const SILHOUETTE_WIDTH = 256;

/**
 * A sprite, as one flat shape.
 *
 * The game's images are already decoded and on hand, so the silhouette is taken from the sprite
 * itself: its own pixels say what shape the action has, and the colour is thrown away so the
 * button can wear it in whatever colour it likes.
 */
export function silhouetteFrom(source: ImageSource | undefined): string | null {
  const image = source?.image;
  if (!image?.width || !image.height) return null;

  // Blown up in whole pixels before it is ever scaled by anything else. A mask is resized
  // smoothly by the browser, and a sprite of thirty pixels across resized smoothly to the width
  // of a thumb is a blur; enlarged first, with the smoothing off, the blocks stay blocks.
  const scale = Math.max(1, Math.ceil(SILHOUETTE_WIDTH / image.width));
  const canvas = document.createElement('canvas');
  canvas.width = image.width * scale;
  canvas.height = image.height * scale;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Everything the sprite drew becomes solid; everything it did not stays empty.
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}
