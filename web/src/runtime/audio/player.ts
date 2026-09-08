import type { GameData } from '../../data/loader';

/**
 * Sound effects and music.
 *
 * Both are audio the browser decodes: the sounds are the game's own WAVs, and the music is what
 * the packaging step made of the game's MIDI, played once against a General MIDI soundfont and
 * recorded. Nothing is synthesised here, so a track sounds the same wherever it is played.
 */
export class AudioBank {
  private context: AudioContext | null = null;
  private readonly samples = new Map<number, AudioBuffer>();
  private readonly tracks = new Map<number, AudioBuffer>();
  private music: AudioBufferSourceNode | null = null;
  private masterGain: GainNode | null = null;

  constructor(private readonly data: GameData) {}

  /** Browsers only allow an AudioContext to start after a user gesture. */
  private ensureContext(): AudioContext | null {
    if (!this.context) {
      try {
        this.context = new AudioContext();
        this.masterGain = this.context.createGain();
        this.masterGain.gain.value = 0.6;
        this.masterGain.connect(this.context.destination);
      } catch (e) {
        console.warn(`no audio: ${e}`);
        return null;
      }
    }
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  resume(): void {
    this.ensureContext();
  }

  /** Decodes every sound and every track, so nothing has to be waited for mid-game. */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const context = this.ensureContext();
    const sounds = [...this.data.sounds.values()];
    const tracks = [...this.data.music.values()];
    const total = sounds.length + tracks.length;
    let loaded = 0;

    await Promise.all([
      ...sounds.map(async (sound) => {
        try {
          const bytes = this.data.soundBytes(sound);
          if (context) this.samples.set(sound.handle, await context.decodeAudioData(bytes));
        } catch (e) {
          console.warn(`sound ${sound.handle} (${sound.name}): ${e}`);
        }
        onProgress?.(++loaded, total);
      }),
      ...tracks.map(async (track) => {
        try {
          const bytes = this.data.musicBytes(track);
          if (context) this.tracks.set(track.handle, await context.decodeAudioData(bytes));
        } catch (e) {
          console.warn(`music ${track.handle} (${track.name}): ${e}`);
        }
        onProgress?.(++loaded, total);
      }),
    ]);
  }

  playSample(handle: number): void {
    const context = this.ensureContext();
    const buffer = this.samples.get(handle);
    if (!context || !buffer || !this.masterGain) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);
    source.start();
  }

  playMusic(handle: number, loop: boolean): void {
    const context = this.ensureContext();
    const buffer = this.tracks.get(handle);
    if (!context || !buffer || !this.masterGain) return;

    this.stopMusic();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(this.masterGain);
    source.start();
    this.music = source;
  }

  stopMusic(): void {
    if (!this.music) return;
    try { this.music.stop(); } catch { /* already ended */ }
    this.music.disconnect();
    this.music = null;
  }
}
