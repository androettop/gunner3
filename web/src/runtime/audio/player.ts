import type { GameData } from '../../data/loader';
import { MusicSynth } from './synth';

/**
 * Sound effects and music.
 *
 * The sounds are the game's own WAVs and play straight through WebAudio. The music is MIDI,
 * which browsers cannot play, so the runtime carries a synthesiser and a General MIDI soundfont
 * cut down to what this game asks for, and the score is played the way the original played it:
 * note by note, as it goes.
 */
export class AudioBank {
  private context: AudioContext | null = null;
  private readonly samples = new Map<number, AudioBuffer>();
  private readonly scores = new Map<number, ArrayBuffer>();
  private synth: MusicSynth | null = null;
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

  /**
   * Decodes every sound, takes the scores as they are, and puts the synthesiser up.
   *
   * The scores are bytes until they are played: parsing one costs nothing next to the
   * soundfont, and the worklet is where it has to happen anyway.
   */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const context = this.ensureContext();
    const sounds = [...this.data.sounds.values()];
    const tracks = [...this.data.music.values()];
    // The soundfont is the last thing counted, and by far the largest.
    const total = sounds.length + tracks.length + 1;
    let loaded = 0;

    for (const track of tracks) {
      this.scores.set(track.handle, this.data.musicBytes(track));
      onProgress?.(++loaded, total);
    }

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
      (async () => {
        try {
          if (context && this.masterGain && this.data.hasSoundfont) {
            const synth = new MusicSynth(context, this.masterGain);
            await synth.start(this.data.soundfontBytes());
            this.synth = synth;
          }
        } catch (e) {
          console.warn(`music: ${e}`);
        }
        onProgress?.(++loaded, total);
      })(),
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
    this.ensureContext();
    const score = this.scores.get(handle);
    if (!this.synth || !score) return;
    this.synth.play(score, loop);
  }

  stopMusic(): void {
    this.synth?.stop();
  }
}
