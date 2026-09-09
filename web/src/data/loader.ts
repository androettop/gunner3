import type {
  FontDef, FrameDef, FrameEvents, GameManifest, ImageMeta, ObjectDef, SoundDef, MusicDef,
} from './types';
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

  imageUrl(handle: number): string {
    return this.pkg.url(`images/${handle}.png`);
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
