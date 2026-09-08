import type { GameData } from '../../data/loader';
import { parseMidi, type MidiFile, type Note } from './midi';

/**
 * Sound effects and music.
 *
 * Samples are WAVs and play straight through WebAudio. Music is MIDI, which browsers cannot
 * play, so each track is synthesised once into an AudioBuffer the first time it is asked for
 * and then reused. The synthesis is a small subtractive voice per note rather than a General
 * MIDI soundfont, so the music is a recognisable rendition of the original score, not a
 * faithful reproduction of how it sounded on a 2000-era wavetable card.
 */
export class AudioBank {
  private context: AudioContext | null = null;
  private readonly samples = new Map<number, AudioBuffer>();
  private readonly scores = new Map<number, MidiFile>();
  private readonly rendered = new Map<number, AudioBuffer>();
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

  /** Fetches and decodes every sample, and parses every score. */
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
          this.scores.set(track.handle, parseMidi(this.data.musicBytes(track)));
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

  async playMusic(handle: number, loop: boolean): Promise<void> {
    const context = this.ensureContext();
    if (!context || !this.masterGain) return;

    const buffer = await this.renderScore(handle);
    if (!buffer) return;

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

  private async renderScore(handle: number): Promise<AudioBuffer | null> {
    const cached = this.rendered.get(handle);
    if (cached) return cached;

    const score = this.scores.get(handle);
    const context = this.context;
    if (!score || !context || !score.notes.length) return null;

    const sampleRate = 22050; // Plenty for these voices, and a quarter the memory of 44.1k.
    const seconds = Math.min(score.duration + 1, 180);
    const offline = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);

    const master = offline.createGain();
    // Scale down with polyphony so dense passages do not clip.
    master.gain.value = 0.5 / Math.max(1, Math.sqrt(maxPolyphony(score.notes)));
    master.connect(offline.destination);

    for (const note of score.notes) {
      if (note.start > seconds) continue;
      renderNote(offline, master, note);
    }

    try {
      const buffer = await offline.startRendering();
      this.rendered.set(handle, buffer);
      return buffer;
    } catch (e) {
      console.warn(`music ${handle} render failed: ${e}`);
      return null;
    }
  }
}

/** MIDI note number to frequency, A440. */
function frequency(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

function maxPolyphony(notes: Note[]): number {
  // Approximate: the densest one-second window.
  const buckets = new Map<number, number>();
  for (const note of notes) {
    const bucket = Math.floor(note.start);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let peak = 1;
  for (const count of buckets.values()) peak = Math.max(peak, count);
  return peak;
}

function renderNote(context: OfflineAudioContext, destination: GainNode, note: Note): void {
  const gain = context.createGain();
  gain.connect(destination);

  const level = (note.velocity / 127) * 0.35;
  const attack = 0.008;
  const release = Math.min(0.12, note.duration * 0.5);
  const end = note.start + note.duration;

  gain.gain.setValueAtTime(0, note.start);
  gain.gain.linearRampToValueAtTime(level, note.start + attack);
  gain.gain.setValueAtTime(level, Math.max(note.start + attack, end - release));
  gain.gain.linearRampToValueAtTime(0, end);

  // Channel 10 is percussion: pitch carries no melody there, so use a short noise burst.
  if (note.channel === 9) {
    const length = Math.max(1, Math.floor(context.sampleRate * Math.min(note.duration, 0.2)));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(note.start);
    return;
  }

  const oscillator = context.createOscillator();
  oscillator.type = waveFor(note.program);
  oscillator.frequency.value = frequency(note.pitch);
  oscillator.connect(gain);
  oscillator.start(note.start);
  oscillator.stop(end + 0.02);
}

/** A coarse mapping from General MIDI families to oscillator shapes. */
function waveFor(program: number): OscillatorType {
  if (program < 8) return 'triangle';    // pianos
  if (program < 24) return 'sine';       // chromatic percussion, organs
  if (program < 40) return 'sawtooth';   // guitars, basses
  if (program < 56) return 'sawtooth';   // strings
  if (program < 80) return 'square';     // brass, reeds, pipes
  if (program < 96) return 'square';     // synth leads
  return 'triangle';
}
