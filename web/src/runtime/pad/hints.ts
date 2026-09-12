import type { PadButton } from './layout';

/**
 * The row of hints along the foot of the game, saying what the pad does.
 *
 * A pad has no labels on it that a game can borrow, and a game of this age has no idea a pad
 * exists: what the buttons do is in the layout and nowhere the player can see. So it is drawn,
 * the way console games have always drawn it, as a line of button and meaning along the bottom
 * where it is read without being looked at.
 *
 * It is up only while the pad is the thing being played with, since it is answering a question
 * only a player holding one is asking.
 */

/** What a hint says: the button to press, and what pressing it does. */
export interface PadHint {
  button: PadButton;
  label: string;
}

/**
 * How much of the picture's height one line of the row is, which everything else is built from.
 *
 * Gunner 3 draws itself 480 high, where this is a shade over 14 pixels.
 */
const HINT_SHARE = 0.0297;

/**
 * Which family of pad is in hand, which decides what its buttons are called.
 *
 * The same physical button is A on one pad and a cross on another, and a player reads the one
 * printed on the thing in their hands. Anything not recognised is drawn as a picture of the
 * pad itself with the button in question filled in, which needs no name at all.
 */
export type PadKind = 'xbox' | 'playstation' | 'generic';

/**
 * The family a pad belongs to, from the name the browser gives it.
 *
 * The names are free text from the driver, so this is a guess, and the generic drawing is what
 * it falls back to: a guess that is wrong the other way would print the wrong letter on a
 * button, which is worse than printing none.
 */
export function padKind(id: string): PadKind {
  const name = id.toLowerCase();
  if (/xbox|xinput|x-?input|microsoft|045e/.test(name)) return 'xbox';
  if (/playstation|dual\s?shock|dualsense|sony|054c|ps[2345]\b/.test(name)) return 'playstation';
  return 'generic';
}

export class PadHintBar {
  private readonly root: HTMLDivElement;
  /** What is drawn, so that a row already right is not built again sixty times a second. */
  private showing = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.root = document.createElement('div');
    this.root.className = 'fusion-pad-hints';
    this.root.append(style());
    this.root.style.display = 'none';
    document.body.append(this.root);
    window.addEventListener('resize', this.place);
    window.addEventListener('orientationchange', this.place);
  }

  /**
   * Lays the row along the foot of the picture rather than of the page.
   *
   * The touch controls are placed against the screen, because a thumb reaches the corner of a
   * screen more easily than the corner of a letterboxed picture. These are the other way about:
   * they are read rather than reached for, and what they are about is the game, so they belong
   * on it. Left at the bottom of the page they sit in the black below a game drawn small, which
   * is a caption on nothing.
   *
   * They are sized by the picture too, for the same reason the cursor is timed by it: a row
   * that keeps its share of the game looks the same over the game at any size, on a window in
   * a corner of a monitor and on a television across a room.
   */
  private readonly place = (): void => {
    const picture = this.canvas.getBoundingClientRect();
    if (!picture.width || !picture.height) return;
    this.root.style.left = `${picture.left}px`;
    this.root.style.width = `${picture.width}px`;
    this.root.style.bottom = `${Math.max(0, window.innerHeight - picture.bottom)}px`;
    // Strictly a share of the picture, with no floor and no ceiling: a row that stops growing
    // is a row that is one size against a game drawn small and another against the same game
    // drawn large, which is the one thing it must not be.
    this.root.style.setProperty('--size', `${picture.height * HINT_SHARE}px`);
  };

  /**
   * Puts up the hints for what the pad is doing now, on the pad it is being done with.
   *
   * `aside` is the one that goes last and stands alone at the right edge: it is about the row
   * rather than about the game, and keeping it away from the others says so without a word.
   */
  show(hints: PadHint[], aside: PadHint | null, kind: PadKind): void {
    const name = (hint: PadHint) => `${hint.button}=${hint.label}`;
    const key = `${kind}:${hints.map(name).join('|')}:${aside ? name(aside) : ''}`;
    if (key !== this.showing) {
      this.showing = key;
      for (const child of Array.from(this.root.children)) {
        if (child.tagName !== 'STYLE') child.remove();
      }
      const middle = document.createElement('div');
      middle.className = 'fusion-pad-hints-middle';
      for (const hint of hints) middle.append(this.draw(hint, kind));
      this.root.append(middle);
      if (aside) {
        const drawn = this.draw(aside, kind);
        drawn.classList.add('is-aside');
        this.root.append(drawn);
      }
    }
    this.place();
    this.root.style.display = '';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  remove(): void {
    window.removeEventListener('resize', this.place);
    window.removeEventListener('orientationchange', this.place);
    this.root.remove();
  }

  private draw(hint: PadHint, kind: PadKind): HTMLElement {
    const item = document.createElement('span');
    item.className = 'fusion-pad-hint';
    item.insertAdjacentHTML('beforeend', icon(hint.button, kind));
    const label = document.createElement('span');
    label.className = 'fusion-pad-hint-label';
    label.textContent = hint.label;
    item.append(label);
    return item;
  }
}

/** Where a face button sits on the four-button diamond, for the drawings that are a diagram. */
const PLACES: Partial<Record<PadButton, { x: number; y: number }>> = {
  north: { x: 12, y: 5 },
  south: { x: 12, y: 19 },
  west: { x: 5, y: 12 },
  east: { x: 19, y: 12 },
};

/**
 * The colours a pad of this family paints its face buttons, which is how a player knows them.
 *
 * Worn by the letter rather than by the button, which is the other way round from the pad
 * itself: a coloured disc the size of a word is a spot of paint on the game, while a letter in
 * its own colour on the same dark grey as every other button reads as one row and still says
 * green at a glance. They are the pad's colours lifted towards the light, since a letter has
 * far less of itself to be seen by than a button does.
 */
const XBOX_COLOURS: Partial<Record<PadButton, string>> = {
  south: '#7ac943',
  east: '#f0565c',
  west: '#41a4e8',
  north: '#f4ce2a',
};

/** What every button is drawn on, whatever is written on it. */
const BUTTON_FILL = '#2b2f38';
const BUTTON_EDGE = '#0b0b0b';

const XBOX_LETTERS: Partial<Record<PadButton, string>> = {
  south: 'A', east: 'B', west: 'X', north: 'Y',
};

/**
 * The buttons that are a word rather than a shape, and the word each family prints on them.
 *
 * The shoulders and the small pair in the middle have never settled on a symbol the way the
 * four face buttons have, and every generation renames them: select became share became create.
 * What is printed here is what that family's players last saw on the thing in their hands.
 */
const WORDS: Record<PadKind, Partial<Record<PadButton, string>>> = {
  xbox: { l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT' },
  playstation: { l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'SELECT', start: 'START' },
  generic: { l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'SELECT', start: 'START' },
};

function icon(button: PadButton, kind: PadKind): string {
  const word = WORDS[kind][button];
  if (word) return pillIcon(word);
  if (kind === 'xbox') return button === 'select' ? viewIcon() : xboxIcon(button);
  if (kind === 'playstation') return playstationIcon(button);
  return genericIcon(button);
}

/** A lettered button: the pad's own colour, worn by the letter. */
function xboxIcon(button: PadButton): string {
  const colour = XBOX_COLOURS[button] ?? '#fff';
  const letter = XBOX_LETTERS[button] ?? '?';
  return svg(`
    <circle cx="12" cy="12" r="10.5" fill="${BUTTON_FILL}" stroke="${BUTTON_EDGE}" stroke-width="1.4" />
    <text x="12" y="12" fill="${colour}" font-size="13" font-weight="700"
          text-anchor="middle" dominant-baseline="central">${letter}</text>`);
}

/**
 * The View button, which is a picture on the pad rather than a word.
 *
 * Microsoft stopped writing on that button two pads ago: what is on it now is two panes, the
 * smaller one up and to the left and the larger one over it at the bottom right, and a player
 * looking for it on the thing in their hands is looking for that and not for a word to read.
 */
function viewIcon(): string {
  // Two panes of one size and one shape, four across by three down, the back one offset up and
  // to the left by half of itself. Where the front pane crosses it the back one simply stops,
  // a hair short of the line rather than against it, which is the gap that makes one read as
  // being behind the other rather than welded to it.
  const width = 9;
  const height = 6.75;
  const radius = 1.1;
  const gap = 1.15;
  const back = { x: 5.7, y: 6.8 };
  const front = { x: 9.2, y: 10.45 };
  return svg(`
    <circle cx="12" cy="12" r="10.5" fill="${BUTTON_FILL}" stroke="${BUTTON_EDGE}" stroke-width="1.4" />
    <defs>
      <mask id="${VIEW_MASK}">
        <rect x="0" y="0" width="24" height="24" fill="#fff" />
        <rect x="${front.x - gap}" y="${front.y - gap}" width="${width + gap * 2}"
              height="${height + gap * 2}" rx="${radius + gap}" fill="#000" />
      </mask>
    </defs>
    <g stroke="#fff" stroke-width="1.3" fill="none" stroke-linejoin="round">
      <rect x="${back.x}" y="${back.y}" width="${width}" height="${height}" rx="${radius}"
            mask="url(#${VIEW_MASK})" />
      <rect x="${front.x}" y="${front.y}" width="${width}" height="${height}" rx="${radius}"
            fill="${BUTTON_FILL}" />
    </g>`);
}

/** One drawing, one name for the hole cut in it; the row never holds two of these at once. */
const VIEW_MASK = 'fusion-pad-view-cut';

/**
 * The colours PlayStation gives its four shapes, which are as much of them as the letters are
 * of Xbox's: turquoise, pink, light blue and red, lifted for the dark grey they sit on.
 */
const PLAYSTATION_COLOURS: Partial<Record<PadButton, string>> = {
  north: '#45d4b0',
  west: '#f074b4',
  south: '#62b4f0',
  east: '#f0565c',
};

/** The four shapes, drawn rather than lettered, on the dark ring the pad prints them in. */
function playstationIcon(button: PadButton): string {
  const shapes: Partial<Record<PadButton, string>> = {
    south: '<path d="M7.5 7.5 L16.5 16.5 M16.5 7.5 L7.5 16.5" />',
    east: '<circle cx="12" cy="12" r="4.6" fill="none" />',
    west: '<rect x="7.7" y="7.7" width="8.6" height="8.6" fill="none" />',
    north: '<path d="M12 7 L16.6 16 L7.4 16 Z" fill="none" />',
  };
  const colour = PLAYSTATION_COLOURS[button] ?? '#fff';
  return svg(`
    <circle cx="12" cy="12" r="10.5" fill="${BUTTON_FILL}" stroke="${BUTTON_EDGE}" stroke-width="1.4" />
    <g stroke="${colour}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      ${shapes[button] ?? ''}
    </g>`);
}

/**
 * The pad itself, with the button in question filled in.
 *
 * For a pad nobody recognises there is no letter to print that would not be a lie, so what is
 * drawn is where the button is: four rings in a diamond, and the one meant solid.
 */
function genericIcon(button: PadButton): string {
  const place = PLACES[button];
  const rings = Object.entries(PLACES).map(([name, at]) => {
    const solid = name === button;
    return `<circle cx="${at.x}" cy="${at.y}" r="${solid ? 4.1 : 3.5}"
      fill="${solid ? '#fff' : 'none'}" stroke="#fff" stroke-width="${solid ? 0 : 1.9}" />`;
  }).join('');
  // A button that is not one of the four has no place on the diamond; the ring alone says so.
  if (!place) return svg('<circle cx="12" cy="12" r="7" fill="none" stroke="#fff" stroke-width="2" />');
  return svg(rings);
}

/**
 * A button that carries a word: a pill with the word on it, as wide as the word needs.
 *
 * Grown to fit rather than drawn to a size, since LB and SELECT are the same kind of thing and
 * a pill built for one of them either crops the other or leaves it swimming.
 */
function pillIcon(name: string): string {
  const width = Math.max(24, 9 + name.length * 6.1);
  return svg(`
    <rect x="1.2" y="5" width="${(width - 2.4).toFixed(1)}" height="14" rx="5.2"
          fill="${BUTTON_FILL}" stroke="${BUTTON_EDGE}" stroke-width="1.4" />
    <text x="${(width / 2).toFixed(1)}" y="12.4" fill="#fff" font-size="9.5" font-weight="700"
          text-anchor="middle" dominant-baseline="central">${name}</text>`, width);
}

/** A drawing 24 high, and as wide as it asks to be; the row gives them all one height. */
function svg(body: string, width = 24): string {
  const wide = width !== 24 ? ' is-wide' : '';
  return `<svg class="fusion-pad-hint-icon${wide}" viewBox="0 0 ${width} 24"
    aria-hidden="true">${body}</svg>`;
}

function style(): HTMLStyleElement {
  const element = document.createElement('style');
  element.textContent = `
.fusion-pad-hints {
  position: fixed;
  /* The row is laid out to the width of the picture, so its padding has to come out of that
     width rather than be added to it: content-box hung the last hint over the right edge. */
  box-sizing: border-box;
  /* Laid over the picture, whose place on the page is measured rather than assumed. */
  left: 0;
  bottom: 0;
  /* Everything here is a multiple of the one measure, which is a share of the picture. */
  --size: 14px;
  /* Over the game and over the touch controls, which stand aside while a pad is being held. */
  z-index: 11;
  /* Read, never reached for: it must not take a click meant for the game behind it. */
  pointer-events: none;
  /* The game's hints from the left, where reading starts, and the one about the row itself
     pushed away to the far edge: what it does has nothing to do with what the others do. */
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(var(--size) * 0.5) calc(var(--size) * 0.8);
  /* Enough of a fade for white text to hold over whatever the game is drawing underneath. */
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
}
.fusion-pad-hints-middle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  /* The same measure between the hints as around them, so the row reads as one thing. */
  gap: calc(var(--size) * 0.95);
}
.fusion-pad-hint {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--size) * 0.32);
}
.fusion-pad-hint.is-aside {
  /* Never squeezed, and never up against the last of the others. */
  flex: none;
  margin-left: calc(var(--size) * 0.95);
}
.fusion-pad-hint-icon {
  width: calc(var(--size) * 1.5);
  height: calc(var(--size) * 1.5);
  display: block;
}
.fusion-pad-hint-icon.is-wide {
  /* As wide as its own drawing: a height they all share, a width each asks for. */
  width: auto;
}
.fusion-pad-hint-label {
  color: #fff;
  font-size: var(--size);
  font-weight: 600;
  letter-spacing: 0.01em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 3px rgba(0, 0, 0, 0.7);
  white-space: nowrap;
}
`;
  return element;
}
