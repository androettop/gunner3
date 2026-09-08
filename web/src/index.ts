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

export interface PlayOptions {
  /** The package to play: a URL to fetch it from, or the bytes of one already in hand. */
  package: string | ArrayBuffer | Uint8Array;
  /**
   * The canvas to draw on, or the id of one. Without it the runtime makes its own and appends
   * it to the document, which is what a page with nothing else on it wants.
   */
  canvas?: HTMLCanvasElement | string;
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
  const engine = new Engine({
    width: LOADING_WIDTH,
    height: LOADING_HEIGHT,
    ...canvasOption(options.canvas),
    displayMode: DisplayMode.Fixed,
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
  });

  // Save state outlives any single frame, and so do the objects the game marks global: a load
  // screen fills a set of counters from the save file and jumps to the level expecting to find
  // them still filled.
  const ini = new IniStore();
  const globals = new GlobalValues();
  let current: FrameScene | null = null;
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
    } finally {
      switching = false;
    }
  }

  await engine.start(loader);

  // The game's own window size, which is only known once the package has been read.
  engine.screen.resolution = {
    width: data.manifest.windowWidth,
    height: data.manifest.windowHeight,
  };
  engine.screen.viewport = { ...engine.screen.resolution };
  engine.screen.applyResolutionAndViewport();

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
      engine.stop();
    },
  };
}

/** Excalibur takes the canvas as an element or an id, and makes its own when given neither. */
function canvasOption(canvas: PlayOptions['canvas']) {
  if (typeof canvas === 'string') return { canvasElementId: canvas };
  if (canvas) return { canvasElement: canvas };
  return {};
}

export { GameData, GamePackage, FrameScene };
export type * from './data/types';
