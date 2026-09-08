/**
 * The music, played where the audio is.
 *
 * The game's music is MIDI, so playing it means synthesising it, and synthesising it means
 * producing every sample on time or being heard not to. That is what an audio worklet is for:
 * this runs on the audio thread, off the one the game is drawn on, and hands back a block of
 * samples per render quantum however busy the frame is.
 *
 * It is built into a module of its own and carried inside the runtime as text, since a worklet
 * can only be loaded from a URL and the runtime is one file with nothing beside it to point at.
 * The page makes that URL out of the text at load; see `synth.ts`.
 */
import { BasicMIDI, BasicSoundBank, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer }
  from 'spessasynth_core';

// The audio worklet scope is not the window's, and TypeScript's DOM library does not describe
// it. This is the whole of what is used here.
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

/** What the runtime sends in. */
export type ToWorklet =
  | { kind: 'bank'; bytes: ArrayBuffer }
  | { kind: 'play'; bytes: ArrayBuffer; loop: boolean }
  | { kind: 'stop' };

/** What it sends back: whether the instruments arrived, and nothing else. */
export type FromWorklet = { kind: 'ready' } | { kind: 'failed'; message: string };

class MusicProcessor extends AudioWorkletProcessor {
  private readonly synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  private readonly sequencer = new SpessaSynthSequencer(this.synth);
  private ready = false;
  /** A track asked for before the instruments arrived, played as soon as they do. */
  private waiting: { bytes: ArrayBuffer; loop: boolean } | null = null;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.receive(event.data);
  }

  private receive(message: ToWorklet): void {
    switch (message.kind) {
      case 'bank':
        void this.loadBank(message.bytes);
        return;
      case 'play':
        if (this.ready) this.start(message.bytes, message.loop);
        else this.waiting = { bytes: message.bytes, loop: message.loop };
        return;
      case 'stop':
        this.waiting = null;
        this.sequencer.pause();
        this.synth.stopAllChannels();
        return;
    }
  }

  private async loadBank(bytes: ArrayBuffer): Promise<void> {
    try {
      // The samples are Vorbis, which is decoded by a WebAssembly module the library brings
      // with it, and that has to be up before the bank can be read.
      await BasicSoundBank.isSF3DecoderReady;
      await this.synth.processorInitialized;
      this.synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(bytes), 'game');
      this.ready = true;
      this.port.postMessage({ kind: 'ready' } satisfies FromWorklet);

      const waiting = this.waiting;
      this.waiting = null;
      if (waiting) this.start(waiting.bytes, waiting.loop);
    } catch (e) {
      this.port.postMessage({ kind: 'failed', message: `${e}` } satisfies FromWorklet);
    }
  }

  private start(bytes: ArrayBuffer, loop: boolean): void {
    try {
      this.sequencer.loadNewSongList([BasicMIDI.fromArrayBuffer(bytes)]);
      this.sequencer.loopCount = loop ? Infinity : 0;
      this.sequencer.play();
    } catch (e) {
      this.port.postMessage({ kind: 'failed', message: `${e}` } satisfies FromWorklet);
    }
  }

  /**
   * One render quantum. The sequencer is stepped first so that the notes falling inside this
   * block are sounding by the time it is filled.
   */
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    if (this.ready && left && right) {
      this.sequencer.processTick();
      this.synth.process(left, right);
    }
    // Never done: the node lives as long as the game does, silent between tracks.
    return true;
  }
}

registerProcessor('fusion-music', MusicProcessor);
