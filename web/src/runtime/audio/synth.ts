import workletSource from 'virtual:music-worklet';
import type { FromWorklet, ToWorklet } from './worklet';

/**
 * The music, as the runtime sees it.
 *
 * Everything that makes a sound out of the score happens in `worklet.ts`, on the audio thread.
 * This is the near side of that: it puts the worklet up, hands it the instruments once, and
 * turns a "play this track" into a message.
 *
 * A track starts the moment it is asked for, whatever its length, and costs its notes rather
 * than its running time: nothing is rendered ahead or held in memory.
 */
export class MusicSynth {
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly context: AudioContext, private readonly destination: AudioNode) {}

  /**
   * Puts the worklet up and gives it the soundfont. Resolves once the node exists, which is
   * before the instruments are read: a track asked for in between waits inside the worklet
   * rather than out here.
   */
  async start(soundfont: ArrayBuffer): Promise<void> {
    if (this.starting) return this.starting;

    this.starting = (async () => {
      // The worklet is carried as text, so the URL it is loaded from is made here.
      const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
      try {
        await this.context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const node = new AudioWorkletNode(this.context, 'fusion-music', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (event: MessageEvent<FromWorklet>) => {
        if (event.data.kind === 'failed') console.warn(`music: ${event.data.message}`);
      };
      node.connect(this.destination);
      this.send(node, { kind: 'bank', bytes: soundfont }, [soundfont]);
      this.node = node;
    })();

    return this.starting;
  }

  play(midi: ArrayBuffer, loop: boolean): void {
    if (!this.node) return;
    // The bytes are handed over rather than copied, so the caller gets a buffer of its own.
    const bytes = midi.slice(0);
    this.send(this.node, { kind: 'play', bytes, loop }, [bytes]);
  }

  stop(): void {
    if (this.node) this.send(this.node, { kind: 'stop' });
  }

  private send(node: AudioWorkletNode, message: ToWorklet, transfer: Transferable[] = []): void {
    node.port.postMessage(message, transfer);
  }
}
