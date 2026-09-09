import type { FontDef } from '../data/types';

/**
 * The game's own lettering, as a browser can be asked for it.
 *
 * A Clickteam game stores the font its author picked as a Windows `LOGFONT`, so what comes out
 * of the package is a face name, a height and a weight rather than any letters. The face is
 * asked for by that name, which the machine either has or has not; a monospaced face stands in
 * for the ones it has not, since the faces these games were written in were monospaced.
 */

/** What a text object is drawn in when the game names no font for it. */
const FALLBACK: FontDef = {
  handle: -1,
  face: 'monospace',
  size: 12,
  weight: 400,
  italic: false,
  underline: false,
};

export function fontOr(def: FontDef | undefined): FontDef {
  return def ?? FALLBACK;
}

/** The face and the ones to fall back to, as CSS wants them. */
export function fontFamily(def: FontDef): string {
  return def.face === 'monospace' ? 'monospace' : `"${def.face}", monospace`;
}

/** A whole font as the canvas's `font` property wants it. */
export function cssFont(def: FontDef): string {
  const slant = def.italic ? 'italic ' : '';
  return `${slant}${def.weight} ${def.size}px ${fontFamily(def)}`;
}
