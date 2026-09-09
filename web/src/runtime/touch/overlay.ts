import type { ImageSource } from 'excalibur';
import type {
  KeyCode, TouchButton, TouchCorner, TouchIcon, TouchLayout, TouchSteering,
} from './layout';

/** The corners a button can be pinned to, in the order their stacks are built. */
const CORNERS: TouchCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * The parts of the page a button can work, as opposed to the parts of the game.
 *
 * The overlay does not know what a display mode is or how a browser goes fullscreen; it knows
 * that a button was pressed and hands that on.
 */
/**
 * What the game is holding, for the controls that need to know.
 *
 * Reading an object of the game's by name rather than by handle keeps a layout legible, and
 * keeps the overlay out of the business of knowing what any of it means: it asks for a number
 * and steps over the keys whose number is zero.
 */
export type Reading = (objectName: string) => number | null;

export interface Shell {
  isFullscreen(): boolean;
  toggleFullscreen(): Promise<void>;
  /** The ways of fitting the game to the screen, and which of them is in use. */
  displayModes(): string[];
  displayMode(): string;
  setDisplayMode(mode: string): void;
  /** Whether the game is smoothed as it is scaled up, or left in its own square pixels. */
  smoothing(): boolean;
  setSmoothing(on: boolean): void;
  /** How loud the music and the game's own sounds are, from silent at 0 to as written at 1. */
  musicVolume(): number;
  setMusicVolume(volume: number): void;
  effectsVolume(): number;
  setEffectsVolume(volume: number): void;
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
    private readonly reading: Reading = () => null,
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

    // A pinned button goes in its corner rather than at a place of its own, so that everything
    // in a corner is the same distance from its neighbours as it is from the edge.
    const buttons = [...this.chrome, ...(layout?.buttons ?? [])];
    for (const corner of CORNERS) {
      const pinned = buttons.filter((b) => b.pin?.corner === corner);
      if (pinned.length === 0) continue;

      const stack = document.createElement('div');
      stack.className = `fusion-touch-corner at-${corner}`;
      // Rows read down the screen whichever corner they are in, so row zero is the upper one
      // and the corner decides only which edge the stack as a whole is held against.
      const rows = [...new Set(pinned.map((b) => b.pin?.row ?? 0))].sort((a, b) => a - b);
      for (const index of rows) {
        const row = document.createElement('div');
        row.className = 'fusion-touch-corner-row';
        for (const button of pinned.filter((b) => (b.pin?.row ?? 0) === index)) {
          row.append(this.button(button, true));
        }
        stack.append(row);
      }
      this.root.append(stack);
    }

    for (const button of buttons) if (!button.pin) this.root.append(this.button(button));
    this.place();
  }

  destroy(): void {
    this.releaseAll();
    window.removeEventListener('resize', this.place);
    window.removeEventListener('orientationchange', this.place);
    this.root.remove();
  }

  /** Redraws whatever shows a state rather than only causing one. */
  private readonly place = (): void => {
    const full = this.shell.isFullscreen();
    for (const icon of Array.from(this.root.querySelectorAll('.is-fullscreen'))) {
      icon.classList.toggle('is-inside', full);
    }
    const mode = this.shell.displayMode();
    for (const option of Array.from(this.root.querySelectorAll('[data-mode]'))) {
      option.classList.toggle('is-on', option.getAttribute('data-mode') === mode);
    }
  };

  /** The panel the settings sit behind, which is up or down and nothing in between. */
  private toggleSettings(): void {
    const open = this.root.querySelector('.fusion-touch-panel');
    if (open) {
      open.remove();
      return;
    }
    this.root.append(this.settingsPanel());
    this.place();
  }

  private settingsPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'fusion-touch-panel';

    const modes = document.createElement('div');
    modes.className = 'fusion-touch-choice';
    for (const mode of this.shell.displayModes()) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'fusion-touch-option';
      option.setAttribute('data-mode', mode);
      option.setAttribute('aria-label', `screen-${mode}`);
      option.append(screenIcon(mode));
      option.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.shell.setDisplayMode(mode);
        this.place();
      });
      modes.append(option);
    }
    panel.append(row('Screen', modes));
    panel.append(row('Smooth', this.toggle('smoothing', this.shell.smoothing(), (on) => {
      this.shell.setSmoothing(on);
    })));

    panel.append(row('Music', this.slider('music', this.shell.musicVolume(), (volume) => {
      this.shell.setMusicVolume(volume);
    })));
    panel.append(row('Effects', this.slider('effects', this.shell.effectsVolume(), (volume) => {
      this.shell.setEffectsVolume(volume);
    })));
    return panel;
  }

  private toggle(name: string, on: boolean, onChange: (on: boolean) => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fusion-touch-switch';
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', String(on));
    button.append(document.createElement('span'));
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const next = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(next));
      onChange(next);
    });
    return button;
  }

  private slider(name: string, at: number, onChange: (volume: number) => void): HTMLElement {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'fusion-touch-slider';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(at * 100));
    slider.setAttribute('aria-label', `${name}-volume`);
    slider.addEventListener('input', () => onChange(Number(slider.value) / 100));
    return slider;
  }

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
    element.style.setProperty('--x', `${(button.x ?? 0) * 100}%`);
    element.style.setProperty('--y', `${(button.y ?? 0) * 100}%`);
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
      } else if (button.action === 'settings') {
        this.toggleSettings();
      } else if (button.cycle) {
        // A cycle keeps its own place in the list: the game selects a weapon by its own key and
        // never says which one it has, so the arrows walk the list rather than follow the game.
        const list = button.cycle.keys.join(',');
        const cursor = this.step(button.cycle, this.cycles.get(list) ?? 0);
        if (cursor !== null) {
          this.cycles.set(list, cursor);
          this.strike(button.cycle.keys[cursor]);
        }
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

    if (icon.kind === 'settings') {
      // A cogwheel: a ring of teeth around a hole.
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', COG);
      svg.append(path);
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

  /**
   * The next place in a cycle that is worth striking, stepping over everything the game says it
   * has not got. Null when it has none of them, which cannot happen while it has one.
   */
  private step(cycle: NonNullable<TouchButton['cycle']>, from: number): number | null {
    const { keys, step, owned } = cycle;
    for (let moved = 1; moved <= keys.length; moved++) {
      const at = ((from + step * moved) % keys.length + keys.length) % keys.length;
      const name = owned?.[at];
      if (!name || (this.reading(name) ?? 0) > 0) return at;
    }
    return null;
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
  /* The panel is read rather than reached for, so it stops growing before a button does. */
  --panel: min(var(--button), 90px);
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
/* A corner is a place to put buttons, not a surface: only the buttons in it take a touch. */
.fusion-touch-corner,
.fusion-touch-corner-row {
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
/* A corner holds rows of buttons, spaced from each other and from the edges by the one measure
   everything on the overlay is spaced by. */
.fusion-touch-corner {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
.fusion-touch-corner-row {
  display: flex;
  gap: var(--gap);
  /* Buttons of different sizes in one row stand on the same line. */
  align-items: flex-end;
}
.fusion-touch-corner.at-top-left { left: var(--gap); top: var(--gap); align-items: flex-start; }
.fusion-touch-corner.at-top-right { right: var(--gap); top: var(--gap); align-items: flex-end; }
.fusion-touch-corner.at-bottom-left {
  left: var(--gap);
  bottom: var(--gap);
  align-items: flex-start;
}
.fusion-touch-corner.at-bottom-right {
  right: var(--gap);
  bottom: var(--gap);
  align-items: flex-end;
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

/* A button is a shape to see the game through; a panel is a thing to read, so it is a sheet of
   the same white rather than a tint of it. */
.fusion-touch-panel {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: calc(var(--gap) * 1.1);
  padding: calc(var(--gap) * 1.8) calc(var(--gap) * 2.2);
  border-radius: calc(var(--gap) * 1.4);
  background: rgba(246, 247, 250, 0.93);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: 0 calc(var(--gap) * 0.5) calc(var(--gap) * 2) rgba(0, 0, 0, 0.45);
  color: rgba(18, 20, 26, 0.92);
  font: 600 calc(var(--panel) * 0.19) ui-sans-serif, system-ui, sans-serif;
  pointer-events: auto;
  touch-action: none;
}
.fusion-touch-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--gap) * 2.4);
}
.fusion-touch-label { white-space: nowrap; }
.fusion-touch-choice { display: flex; gap: calc(var(--gap) * 0.7); }
.fusion-touch-option {
  width: calc(var(--panel) * 0.42);
  height: calc(var(--panel) * 0.42);
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(18, 20, 26, 0.09);
  color: rgba(18, 20, 26, 0.55);
  display: grid;
  place-items: center;
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
/* The way the game is being fitted right now. */
.fusion-touch-option.is-on {
  background: rgba(18, 20, 26, 0.86);
  color: rgba(246, 247, 250, 0.95);
}
/* A switch: a track with a knob at one end or the other. */
.fusion-touch-switch {
  width: calc(var(--panel) * 0.8);
  height: calc(var(--panel) * 0.42);
  padding: 0;
  border: none;
  border-radius: calc(var(--panel) * 0.21);
  background: rgba(18, 20, 26, 0.14);
  display: flex;
  align-items: center;
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 90ms linear;
}
.fusion-touch-switch > span {
  width: calc(var(--panel) * 0.34);
  height: calc(var(--panel) * 0.34);
  margin: 0 calc(var(--panel) * 0.04);
  border-radius: 50%;
  background: rgba(246, 247, 250, 0.95);
  transition: transform 90ms linear;
}
.fusion-touch-switch[aria-pressed='true'] { background: rgba(18, 20, 26, 0.86); }
.fusion-touch-switch[aria-pressed='true'] > span {
  transform: translateX(calc(var(--panel) * 0.38));
}
.fusion-touch-slider {
  width: calc(var(--panel) * 1.6);
  height: calc(var(--panel) * 0.42);
  margin: 0;
  accent-color: rgba(18, 20, 26, 0.86);
  pointer-events: auto;
  touch-action: none;
}
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

/** A ring of teeth around a hole, laid out evenly rather than drawn by eye. */
const COG = 'M83.8 53.3 L94.0 63.4 L90.6 71.7 L76.3 71.6 L71.6 76.3 L71.7 90.6 L63.4 94.0 L53.3 83.8 L46.7 83.8 L36.6 94.0 L28.3 90.6 L28.4 76.3 L23.7 71.6 L9.4 71.7 L6.0 63.4 L16.2 53.3 L16.2 46.7 L6.0 36.6 L9.4 28.3 L23.7 28.4 L28.4 23.7 L28.3 9.4 L36.6 6.0 L46.7 16.2 L53.3 16.2 L63.4 6.0 L71.7 9.4 L71.6 23.7 L76.3 28.4 L90.6 28.3 L94.0 36.6 L83.8 46.7 Z M35.0 50.0 C35.0 41.7 41.7 35.0 50.0 35.0 C58.3 35.0 65.0 41.7 65.0 50.0 C65.0 58.3 58.3 65.0 50.0 65.0 C41.7 65.0 35.0 58.3 35.0 50.0 Z';

/** A screen with the game inside it, drawn the size that way of fitting it gives. */
function screenIcon(mode: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'fusion-touch-icon');

  const screen = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  screen.setAttribute('fill', 'none');
  screen.setAttribute('stroke', 'currentColor');
  screen.setAttribute('stroke-width', '9');
  screen.setAttribute('stroke-linejoin', 'round');
  screen.setAttribute('d', 'M10 20 H90 V80 H10 Z');

  const inner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  inner.setAttribute('fill', 'currentColor');
  inner.setAttribute('d', INNER_SCREEN[mode] ?? INNER_SCREEN.Fixed);

  svg.append(screen, inner);
  return svg;
}

/** One line of the settings panel: what it is on the left, and what sets it on the right. */
function row(label: string, control: HTMLElement): HTMLElement {
  const line = document.createElement('div');
  line.className = 'fusion-touch-line';
  const name = document.createElement('span');
  name.className = 'fusion-touch-label';
  name.textContent = label;
  line.append(name, control);
  return line;
}

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
