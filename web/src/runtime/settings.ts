/**
 * What the player has chosen, kept between visits.
 *
 * The settings panel is the only thing that writes these, and it writes on every change rather
 * than on the way out: a game is left by closing the tab, and there is no moment to save at.
 *
 * Storage is allowed to fail. A browser in private mode, or one told to keep no site data,
 * throws on the way in and on the way out; the game plays either way, and the settings simply
 * last as long as the page does.
 */

const KEY = 'fusion-runtime.settings';

export interface Settings {
  /** How the game is fitted to the screen, named as Excalibur names it. */
  displayMode: string;
  /** Whether the game is smoothed as it is scaled up. */
  smoothing: boolean;
  musicVolume: number;
  effectsVolume: number;
}

/**
 * The settings as they were left, over the ones this machine would start with.
 *
 * Anything missing or spoiled falls back to the default, so a stored setting from an older
 * version of the game is no reason for it not to start.
 */
export function readSettings(fallback: Settings): Settings {
  const stored = parse(read());
  return {
    displayMode: typeof stored.displayMode === 'string' ? stored.displayMode : fallback.displayMode,
    smoothing: typeof stored.smoothing === 'boolean' ? stored.smoothing : fallback.smoothing,
    musicVolume: volume(stored.musicVolume, fallback.musicVolume),
    effectsVolume: volume(stored.effectsVolume, fallback.effectsVolume),
  };
}

export function writeSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Nowhere to keep them; they last as long as the page.
  }
}

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function parse(stored: string | null): Partial<Settings> {
  if (!stored) return {};
  try {
    const read: unknown = JSON.parse(stored);
    return typeof read === 'object' && read !== null ? (read as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

function volume(stored: unknown, fallback: number): number {
  return typeof stored === 'number' && Number.isFinite(stored)
    ? Math.min(1, Math.max(0, stored))
    : fallback;
}
