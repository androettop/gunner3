import type {
  FontDef, FrameDef, FrameEvents, GameManifest, ImageMeta, ObjectDef, SoundDef, MusicDef,
} from './types';
import { isCommon, isQuickBackdrop, TILED_FILL } from './types';
import type { GamePackage } from './package';

/** Where the packaging step puts the soundfont. */
const SOUNDFONT = 'soundfont.sf3';

/** The manifest plus the lookup tables the runtime needs, loaded once at startup. */
export class GameData {
  readonly manifest: GameManifest;
  readonly images = new Map<number, ImageMeta>();
  readonly objects = new Map<number, ObjectDef>();
  readonly sounds = new Map<number, SoundDef>();
  readonly music = new Map<number, MusicDef>();
  readonly fonts = new Map<number, FontDef>();
  private readonly events = new Map<number, FrameEvents>();

  private constructor(manifest: GameManifest, private readonly pkg: GamePackage) {
    this.manifest = manifest;
    for (const image of manifest.images) this.images.set(image.handle, image);
    for (const object of manifest.objects) this.objects.set(object.id, object);
    for (const sound of manifest.sounds) this.sounds.set(sound.handle, sound);
    for (const track of manifest.music) this.music.set(track.handle, track);
    for (const font of manifest.fonts ?? []) this.fonts.set(font.handle, font);
  }

  static load(pkg: GamePackage): GameData {
    return new GameData(pkg.json('game.json') as GameManifest, pkg);
  }

  get frames(): FrameDef[] {
    return this.manifest.frames;
  }

  /**
   * The pictures this game repeats across a box rather than draws once.
   *
   * Whether a texture repeats or is clamped at its edge is settled when the picture is handed to
   * the graphics card, and asking again later is ignored for as long as the card still holds it.
   * That would not matter if a tile were only ever a tile, but a game usually draws the same
   * picture both ways: Gunner 3's dark earth fills a whole level and is a backdrop block of its
   * own, and the blocks are met first. Uploaded from a block, the tile arrives clamped, and the
   * fill over it is then its edge pixel stretched the width of the level.
   *
   * So the answer is read from the game rather than from whatever drew first. Both kinds of fill
   * are counted: an object's own, and the motif a counter fills its bar with.
   */
  get tiledImages(): Set<number> {
    if (!this.tiled) {
      this.tiled = new Set<number>();
      for (const object of this.objects.values()) {
        const detail = object.detail;
        if (isQuickBackdrop(detail) && detail.fillType === TILED_FILL) {
          this.tiled.add(detail.image);
        } else if (isCommon(detail) && detail.counter?.shape?.fillType === TILED_FILL) {
          this.tiled.add(detail.counter.image ?? 0);
        }
      }
    }
    return this.tiled;
  }

  private tiled: Set<number> | null = null;

  frame(index: number): FrameDef {
    const frame = this.manifest.frames[index];
    if (!frame) throw new Error(`No frame ${index} (game has ${this.manifest.frames.length})`);
    return frame;
  }

  /**
   * Event tables are a few MB each parsed, so they are decoded per frame and kept. The bytes are
   * already in hand; it is the parsing that is worth doing once and only when a frame asks.
   */
  frameEvents(index: number): FrameEvents {
    const cached = this.events.get(index);
    if (cached) return cached;
    const loaded = this.pkg.json(this.frame(index).events) as FrameEvents;
    this.events.set(index, loaded);
    return loaded;
  }

  /** A sprite's PNG bytes, straight out of the package, for the decoder to read. */
  imageBytes(handle: number): Uint8Array {
    return this.pkg.bytes(`images/${handle}.png`);
  }

  soundBytes(sound: SoundDef): ArrayBuffer {
    return this.pkg.buffer(`sounds/${sound.file}`);
  }

  musicBytes(track: MusicDef): ArrayBuffer {
    return this.pkg.buffer(`music/${track.file}`);
  }

  /** A package made without one plays the game without music rather than not at all. */
  get hasSoundfont(): boolean {
    return this.pkg.has(SOUNDFONT);
  }

  /** The instruments the music is played with: one General MIDI bank, cut to this game. */
  soundfontBytes(): ArrayBuffer {
    return this.pkg.buffer(SOUNDFONT);
  }

  /** Resolves a "jump to frame" parameter to a frame index. */
  frameForHandle(handle: number): number {
    const handles = this.manifest.frameHandles ?? [];
    const index = handles[handle];
    return typeof index === 'number' ? index : handle;
  }

  objectName(id: number): string {
    const object = this.objects.get(id);
    if (!object) return `#${id}`;
    return object.name || `${object.typeName} #${id}`;
  }
}
