/**
 * A runtime for games built with Clickteam Multimedia Fusion 1.5, on Excalibur.
 *
 * The library carries no game in it. What it plays is a package (one zip holding the manifest,
 * the per-frame event tables, the sprites and the audio) produced by this repository's
 * unpacker from a copy of the original executable. A page that wants to play one imports this,
 * points it at a package and gets a running game back:
 *
 * ```html
 * <canvas id="game"></canvas>
 * <script type="module">
 *   import { play } from './fusion-runtime.js';
 *   window.fusion = await play({ package: 'game.zip', canvas: 'game' });
 * </script>
 * ```
 *
 * The game then runs as it was built to: it opens at its own first frame and its own tick rate,
 * and its own events decide where it goes from there.
 *
 * That is the whole of the public surface: everything else (the interpreter, the movement
 * engines, the obstacle masks) is driven by the game's own data and has nothing a page would
 * want to say to it.
 *
 * What it does have is `game.debug`, which is the same runtime opened up for a console: the
 * frames, the objects, the instances in the frame and the values they hold, all readable and
 * writable, plus the clock, so the game can be held still and handed one tick at a time. The
 * running game is left on the window under its own name, so `fusion.debug.help()` is the whole
 * of what anyone needs to remember. See ./runtime/debug.
 */
import { Color, DisplayMode, Engine } from 'excalibur';
import { GameData } from './data/loader';
import { GamePackage } from './data/package';
import { AudioBank } from './runtime/audio/player';
import { Debug, pauseOnBlurWanted } from './runtime/debug';
import { GlobalValues } from './runtime/globals';
import { IniStore } from './runtime/ini';
import { GameLoader } from './runtime/loading';
import { Preloader } from './runtime/preloader';
import { FrameScene } from './runtime/scene';
import { readSettings, type Settings, writeSettings } from './runtime/settings';
import { SpriteStore } from './runtime/sprites';
import { DEFAULT_CHROME, DEFAULT_LAYOUTS, type TouchLayout } from './runtime/touch/layout';
import {
  ControlOverlay, type Reading, type Shell, silhouetteFrom,
} from './runtime/touch/overlay';

export interface PlayOptions {
  /** The package to play: a URL to fetch it from, or the bytes of one already in hand. */
  package: string | ArrayBuffer | Uint8Array;
  /**
   * The canvas to draw on, or the id of one. Without it the runtime makes its own and appends
   * it to the document, which is what a page with nothing else on it wants.
   */
  canvas?: HTMLCanvasElement | string;
  /**
   * Touch controls, over the screen. Left out, they come up on the machines that look like they
   * are played by thumb, and the settings panel turns them on or off from there. `true` and
   * `false` decide it outright; a layout of your own replaces the game's default one.
   *
   * The buttons that fit the game to the screen are up either way: they belong to the page
   * rather than to the game, and are as useful with a mouse as with a thumb.
   */
  touch?: boolean | TouchLayout[];
  /**
   * Where to leave the running game on the window, for a console to reach: `fusion` by default,
   * another name if that one is taken, `false` to leave the window alone.
   *
   * A library writing to the window is not something to do quietly, but a game is played by
   * looking at it, and what there is to reach for while looking at it has to be somewhere a
   * console can name without the page having arranged it first.
   */
  debug?: boolean | string;
}

/** A running game. */
export interface Game {
  readonly engine: Engine;
  readonly data: GameData;
  readonly audio: AudioBank;
  /** The frame being played, or null between one and the next. */
  readonly scene: FrameScene | null;
  /** The runtime's state, opened up for a console: see ./runtime/debug. */
  readonly debug: Debug;
  /** Jumps to a frame, as the game's own events do. */
  show(index: number): Promise<void>;
  /** Stops the game and releases the canvas. */
  stop(): void;
}

/** The size the loading screen is drawn at, before the package says how big the game is. */
const LOADING_WIDTH = 640;
const LOADING_HEIGHT = 480;

/**
 * Loads a package and plays it, resolving once the first frame is on screen.
 *
 * Everything is decoded up front (the whole sprite bank and every sound), so frames switch
 * instantly and nothing pops in mid-play. That is what the loading screen is waiting on, and
 * why it is worth drawing.
 */
export async function play(options: PlayOptions): Promise<Game> {
  const layouts = layoutsFor(options.touch);
  // What the player last chose, over what this machine would start with. The guess at whether
  // the game is played by thumb is only ever the first answer; after that it is their own.
  const settings = readSettings({
    touch: wantsTouch(options.touch),
    displayMode: wantsTouch(options.touch) ? DisplayMode.FitScreen : DisplayMode.Fixed,
    smoothing: false,
    musicVolume: 1,
    effectsVolume: 1,
  });
  const keep = () => writeSettings(settings);
  const engine = new Engine({
    width: LOADING_WIDTH,
    height: LOADING_HEIGHT,
    ...canvasOption(options.canvas),
    // Played by touch, the game takes the whole screen, letterboxed to keep its own shape: a
    // phone has no room to spare around a picture drawn at the size a monitor of 2000 had.
    displayMode: displayModeNamed(settings.displayMode),
    backgroundColor: Color.Black,
    antialiasing: false,
    suppressPlayButton: true,
  });

  let data!: GameData;
  let sprites!: SpriteStore;
  let audio!: AudioBank;

  const loader = new GameLoader(async (report) => {
    report({ loaded: 0, total: 0, label: 'Loading the game' });
    const pkg = typeof options.package === 'string'
      ? await GamePackage.fetch(options.package, (received, total, label) =>
        report({ loaded: received, total, label }))
      : await GamePackage.open(options.package);

    data = GameData.load(pkg);
    loader.title = data.manifest.appName;

    sprites = new SpriteStore(data, await new Preloader(data).loadAll(report));

    audio = new AudioBank(data);
    // The bank says how much there is to do: the instruments its music needs are one more thing
    // to load than the sounds and the scores, and counting them out here read one over the total.
    await audio.load((loaded, total) => report({ loaded, total, label: 'Loading audio' }));
  });

  // Save state outlives any single frame, and so do the objects the game marks global: a load
  // screen fills a set of counters from the save file and jumps to the level expecting to find
  // them still filled.
  const ini = new IniStore();
  const globals = new GlobalValues();
  let current: FrameScene | null = null;
  let debug: Debug | null = null;
  let overlay: ControlOverlay | null = null;
  let sceneCount = 0;
  let switching = false;

  async function show(index: number): Promise<void> {
    if (switching || !data.frames[index]) return;
    switching = true;
    try {
      audio.stopMusic();
      current?.captureGlobals();

      const scene = await FrameScene.create(data, index, sprites);
      scene.audio = audio;
      scene.ini = ini;
      // Attached before the scene initialises, which is when its instances are built and take
      // up what their objects were left holding.
      scene.globals = globals;
      // A frame jump cannot tear down the scene it is running inside, so defer it a tick.
      scene.onJumpToFrame = (next) => queueMicrotask(() => void show(next));
      // Whatever a console asked of the last frame (that the game be held, that firings be
      // counted) is asked of this one before it opens, so the answer covers its first tick.
      debug?.adopt(scene);

      current = scene;
      const key = `frame-${index}-${sceneCount++}`;
      engine.addScene(key, scene);
      await engine.goToScene(key);
      // The controls belong to the frame: a level is played with a thumb, a menu is not.
      overlay?.show(index);
    } finally {
      switching = false;
    }
  }

  await engine.start(loader);

  // The game's own window size, which is only known once the package has been read. Fitted to a
  // screen, the viewport is worked out from that size rather than set to it.
  engine.screen.resolution = {
    width: data.manifest.windowWidth,
    height: data.manifest.windowHeight,
  };
  if (engine.screen.displayMode === DisplayMode.Fixed) {
    engine.screen.viewport = { ...engine.screen.resolution };
  }
  engine.screen.applyResolutionAndViewport();

  // What a control asks the game, which is one counter's reading at a time. The frame it reads
  // is whichever one is playing, so a control asks about the game as it stands.
  const named = new Map([...data.objects.values()].map((object) => [object.name, object.id]));
  const reading: Reading = (name) => {
    const id = named.get(name);
    if (id === undefined) return null;
    const instance = current?.byObject.get(id)?.[0];
    return instance ? instance.values[0] : null;
  };

  const shell = shellFor(engine, audio, () => overlay?.touch ?? false, settings, keep);
  overlay = new ControlOverlay(
    layouts,
    settings.touch,
    DEFAULT_CHROME,
    (handle) => silhouetteFrom(sprites.source(handle)),
    shell,
    reading,
    (on) => { settings.touch = on; keep(); },
  );

  // The rest of what was chosen last time, put back now that there is something to put it on.
  shell.setSmoothing(settings.smoothing);
  audio.musicVolume = settings.musicVolume;
  audio.effectsVolume = settings.effectsVolume;

  // Browsers hold audio until the page has been interacted with.
  const resume = () => audio.resume();
  document.addEventListener('pointerdown', resume, { once: true });
  document.addEventListener('keydown', resume, { once: true });

  // The runtime, opened up for a console. It is built before the first frame opens so that what
  // it is asked to do covers that frame too, and it holds nothing of its own: what it hands out
  // are the runtime's own objects.
  const bridge = new Debug({
    engine,
    data,
    audio,
    ini,
    globals,
    scene: () => current,
    show,
    pauseOnBlur: (on?: boolean) => {
      if (on !== undefined) {
        pauseOnBlur = on;
        visibilityChanged();
      }
      return pauseOnBlur;
    },
    awaken: () => visibilityChanged(),
  });
  debug = bridge;

  await show(0);

  /**
   * A game in a window nobody is looking at stops where it is, sound and all.
   *
   * The clock is what the whole loop hangs off, so stopping it leaves the last frame on screen
   * and the game exactly as it stood. Both the window's focus and the tab's own are watched,
   * since a tab can be hidden without the window losing focus and a window can lose focus with
   * the tab still showing.
   *
   * Unless it is told not to. Working on a game through the browser's own tools means leaving
   * its window at every step, and a game that stops each time cannot be watched while it is
   * being worked on; `fusion.debug.pauseOnBlur(false)` says so, and storage remembers it across
   * the reloads that such work is made of.
   */
  let pauseOnBlur = pauseOnBlurWanted();
  const watch = (awake: boolean) => {
    // The sound follows the window whether or not the clock does: a game left running in the
    // background is one thing, a game heard from another window is another.
    if (awake) audio.wake();
    else if (pauseOnBlur) audio.sleep();

    // A game held still by a console keeps its clock: it is drawing and nothing else, and that
    // is what carries a step asked for from the very window that took the focus away.
    const running = awake || !pauseOnBlur || (current?.paused ?? false);
    if (running === engine.clock.isRunning()) return;
    if (running) engine.clock.start();
    else engine.clock.stop();
  };
  const lostFocus = () => watch(false);
  const gotFocus = () => watch(true);
  const visibilityChanged = () => watch(!document.hidden && document.hasFocus());
  window.addEventListener('blur', lostFocus);
  window.addEventListener('focus', gotFocus);
  document.addEventListener('visibilitychange', visibilityChanged);
  // The window may have been left while the game was still loading.
  visibilityChanged();

  const game: Game = {
    engine,
    data,
    audio,
    get scene() { return current; },
    debug: bridge,
    show,
    stop() {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      window.removeEventListener('blur', lostFocus);
      window.removeEventListener('focus', gotFocus);
      document.removeEventListener('visibilitychange', visibilityChanged);
      audio.stopMusic();
      overlay?.destroy();
      engine.stop();
    },
  };

  installOnWindow(game, options.debug);
  return game;
}

/**
 * Leaves the running game where a console can find it.
 *
 * A page that wants it under its own name says so, and one that would rather the window were
 * left alone says `debug: false`. The name is only ever taken if nothing else has it: a page
 * that has already put something there meant to.
 */
function installOnWindow(game: Game, where: PlayOptions['debug']): void {
  if (where === false) return;
  const name = typeof where === 'string' ? where : 'fusion';
  const window = globalThis as unknown as Record<string, unknown>;
  if (window[name] !== undefined && window[name] !== game) return;
  window[name] = game;
  console.info(`${game.data.manifest.appName} is on window.${name}; ${name}.debug.help() says ` +
    'what can be asked of it.');
}

/** A display mode by name, falling back to the game's own size for anything unknown. */
function displayModeNamed(name: string): DisplayMode {
  return DISPLAY_MODES.find((mode) => mode === name) ?? DisplayMode.Fixed;
}

/** The layouts to play by, which are the game's own unless a page brings its own. */
function layoutsFor(touch: PlayOptions['touch']): TouchLayout[] {
  return Array.isArray(touch) ? touch : DEFAULT_LAYOUTS;
}

/**
 * Whether to start with the controls up.
 *
 * Asked for nothing, the machine is taken at its word: a phone or a tablet says so in its user
 * agent, and iPads since iOS 13 say they are desktops and give themselves away by the number of
 * fingers they accept instead. Either way the settings panel has the last word, so a wrong
 * guess is one tap from being put right.
 */
function wantsTouch(touch: PlayOptions['touch']): boolean {
  if (typeof touch === 'boolean') return touch;
  if (Array.isArray(touch)) return true;
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini|Mobile/i.test(agent)) {
    return true;
  }
  // An iPad since iOS 13 calls itself a Mac; a Mac that takes a finger is one.
  return /Macintosh/.test(agent) && navigator.maxTouchPoints > 0;
}

/**
 * The ways of fitting the game to the screen, in the order the button walks them: at the size it
 * was drawn for, and as large as fits.
 *
 * Both keep the whole picture and its shape. The modes that fill a screen do it either by
 * drawing past the edges of the frame, which shows what the game was never meant to show, or by
 * cropping into it, which takes away what it was. A game drawn for one shape is played in it.
 */
const DISPLAY_MODES: DisplayMode[] = [DisplayMode.Fixed, DisplayMode.FitScreen];

/**
 * The page, as the controls work it.
 *
 * Excalibur takes its display mode when it is built and offers no way to change one afterwards,
 * so the mode is written where it reads it from and the screen is laid out again. Fullscreen is
 * asked of the whole document rather than of the canvas, so that the controls, which are not in
 * the canvas, come along with it.
 */
function shellFor(
  engine: Engine,
  audio: AudioBank,
  touch: () => boolean,
  settings: Settings,
  keep: () => void,
): Shell {
  const screen = engine.screen;
  // The size the game was drawn for, which is what "fixed" means. Fitting the game leaves the
  // fitted size behind in the viewport, so going back to its own size has to say so.
  const own = { ...screen.resolution };
  // Excalibur reads the mode on every layout but only lets it be set when the engine is built,
  // so it is written back where it is read from.
  const setMode = (mode: DisplayMode) => {
    if (mode === DisplayMode.Fixed) screen.viewport = { ...own };
    (screen as unknown as Record<string, DisplayMode>)._displayMode = mode;
    // Working out a fit is what Excalibur does when the window changes size, and saying so is
    // the only way to ask for it from outside.
    window.dispatchEvent(new Event('resize'));
  };

  return {
    isFullscreen: () => document.fullscreenElement !== null,
    displayModes: () => [...DISPLAY_MODES],
    displayMode: () => screen.displayMode,
    setDisplayMode(mode) {
      const wanted = DISPLAY_MODES.find((known) => known === mode);
      if (!wanted) return;
      setMode(wanted);
      settings.displayMode = wanted;
      keep();
    },
    smoothing: () => screen.antialiasing,
    setSmoothing(on) {
      // Two things smooth a game on its way to the screen: how its own drawing is sampled, and
      // how the finished picture is stretched to fit. The second is the one that is seen.
      screen.antialiasing = on;
      const rendering = screen as unknown as Record<string, string>;
      rendering._canvasImageRendering = on ? 'auto' : 'pixelated';
      screen.applyResolutionAndViewport();
      settings.smoothing = on;
      keep();
    },
    musicVolume: () => audio.musicVolume,
    setMusicVolume(volume) {
      audio.musicVolume = volume;
      settings.musicVolume = audio.musicVolume;
      keep();
    },
    effectsVolume: () => audio.effectsVolume,
    setEffectsVolume(volume) {
      audio.effectsVolume = volume;
      settings.effectsVolume = audio.effectsVolume;
      keep();
    },
    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }
        await document.documentElement.requestFullscreen();
        // The game is drawn wider than it is tall, so a phone playing it is turned on its side.
        // A browser that will not be told so simply stays as it was.
        if (touch()) await lockLandscape();
      } catch (e) {
        console.warn(`fullscreen: ${e}`);
      }
    },
  };
}

async function lockLandscape(): Promise<void> {
  const orientation = window.screen.orientation as ScreenOrientation & {
    lock?: (to: string) => Promise<void>;
  };
  try {
    await orientation.lock?.('landscape');
  } catch {
    // Locking is refused on a desktop and by some phones; the game plays either way.
  }
}

/** Excalibur takes the canvas as an element or an id, and makes its own when given neither. */
function canvasOption(canvas: PlayOptions['canvas']) {
  if (typeof canvas === 'string') return { canvasElementId: canvas };
  if (canvas) return { canvasElement: canvas };
  return {};
}

export { GameData, GamePackage, FrameScene };
export type * from './data/types';
