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
 */
import { Color, DisplayMode, Engine } from 'excalibur';
import { GameData } from './data/loader';
import { GamePackage } from './data/package';
import { AudioBank } from './runtime/audio/player';
import { GlobalValues } from './runtime/globals';
import { IniStore } from './runtime/ini';
import { GameLoader } from './runtime/loading';
import { Preloader } from './runtime/preloader';
import { FrameScene } from './runtime/scene';
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
   * Touch controls, over the screen. Left out, they are up when the page is asked for with
   * `?touch=true`, which is how a phone gets them without a page having to know it is a phone.
   * `false` refuses them outright; a layout of your own replaces the game's default one.
   *
   * The buttons that fit the game to the screen are up either way: they belong to the page
   * rather than to the game, and are as useful with a mouse as with a thumb.
   */
  touch?: boolean | TouchLayout[];
}

/** A running game. */
export interface Game {
  readonly engine: Engine;
  readonly data: GameData;
  readonly audio: AudioBank;
  /** The frame being played, or null between one and the next. */
  readonly scene: FrameScene | null;
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
  const layouts = touchLayouts(options.touch);
  const engine = new Engine({
    width: LOADING_WIDTH,
    height: LOADING_HEIGHT,
    ...canvasOption(options.canvas),
    // Played by touch, the game takes the whole screen, letterboxed to keep its own shape: a
    // phone has no room to spare around a picture drawn at the size a monitor of 2000 had.
    displayMode: layouts ? DisplayMode.FitScreen : DisplayMode.Fixed,
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
    const audioTotal = data.sounds.size + data.music.size;
    await audio.load((loaded) => report({ loaded, total: audioTotal, label: 'Loading audio' }));

    // A counter draws its reading as an image of its own glyphs, and an image has to be decoded
    // before it can be drawn. Every reading a counter can show is known from the range it
    // declares, so they are all built here rather than one at a time in front of the player.
    await sprites.warmCounters((built, total) =>
      report({ loaded: built, total, label: 'Loading counters' }));
  });

  // Save state outlives any single frame, and so do the objects the game marks global: a load
  // screen fills a set of counters from the save file and jumps to the level expecting to find
  // them still filled.
  const ini = new IniStore();
  const globals = new GlobalValues();
  let current: FrameScene | null = null;
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
  if (!layouts) engine.screen.viewport = { ...engine.screen.resolution };
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

  overlay = new ControlOverlay(
    layouts ?? [],
    DEFAULT_CHROME,
    (handle) => silhouetteFrom(sprites.source(handle)),
    shellFor(engine, audio, layouts !== null),
    reading,
  );

  // Browsers hold audio until the page has been interacted with.
  const resume = () => audio.resume();
  document.addEventListener('pointerdown', resume, { once: true });
  document.addEventListener('keydown', resume, { once: true });

  await show(0);

  return {
    engine,
    data,
    audio,
    get scene() { return current; },
    show,
    stop() {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      audio.stopMusic();
      overlay?.destroy();
      engine.stop();
    },
  };
}

/**
 * Which touch layouts to put up, if any.
 *
 * Asked for nothing, the controls follow the URL: a page can be handed to a phone as
 * `?touch=true` and to a desktop as itself, without the two being different pages.
 */
function touchLayouts(touch: PlayOptions['touch']): TouchLayout[] | null {
  if (Array.isArray(touch)) return touch;
  if (touch === false) return null;
  if (touch === true) return DEFAULT_LAYOUTS;
  const asked = new URLSearchParams(window.location.search).get('touch');
  return asked === 'true' ? DEFAULT_LAYOUTS : null;
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
function shellFor(engine: Engine, audio: AudioBank, touch: boolean): Shell {
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
      if (wanted) setMode(wanted);
    },
    smoothing: () => screen.antialiasing,
    setSmoothing(on) {
      // Two things smooth a game on its way to the screen: how its own drawing is sampled, and
      // how the finished picture is stretched to fit. The second is the one that is seen.
      screen.antialiasing = on;
      const rendering = screen as unknown as Record<string, string>;
      rendering._canvasImageRendering = on ? 'auto' : 'pixelated';
      screen.applyResolutionAndViewport();
    },
    musicVolume: () => audio.musicVolume,
    setMusicVolume: (volume) => { audio.musicVolume = volume; },
    effectsVolume: () => audio.effectsVolume,
    setEffectsVolume: (volume) => { audio.effectsVolume = volume; },
    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }
        await document.documentElement.requestFullscreen();
        // The game is drawn wider than it is tall, so a phone playing it is turned on its side.
        // A browser that will not be told so simply stays as it was.
        if (touch) await lockLandscape();
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
