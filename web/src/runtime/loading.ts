import { DefaultLoader, type Loadable } from 'excalibur';

export interface Progress {
  loaded: number;
  total: number;
  label: string;
}

/**
 * The loading screen, drawn on the game's own canvas.
 *
 * Excalibur runs a loader before the first scene and draws it itself, which is where a loading
 * screen belongs: the page around the canvas is nothing but a black background, and a screen
 * built out of HTML over it would be a second thing to style and to hide at the right moment.
 *
 * The work is one long sequence rather than a list of resources (download the package, unpack
 * it, decode the sprites, decode the audio), so the bar is driven from the sequence's own
 * reporting rather than from a count of loadables. The base loader lets the game start without
 * waiting for a click, which is what a page holding a single game should do; audio stays silent
 * until the player touches the page, as browsers require, and the runtime resumes it then.
 */
export class GameLoader extends DefaultLoader {
  private progressed: Progress = { loaded: 0, total: 0, label: 'Starting' };
  private finished = false;

  /** Shown above the bar once the package says what the game is called. */
  title = '';

  constructor(run: (report: (progress: Progress) => void) => Promise<void>) {
    super();
    const work: Loadable<null> = {
      data: null,
      isLoaded: () => this.finished,
      load: async () => {
        await run((progress) => { this.progressed = progress; });
        this.finished = true;
        return null;
      },
    };
    this.addResource(work);
  }

  onDraw(ctx: CanvasRenderingContext2D): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const { loaded, total, label } = this.progressed;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const barWidth = Math.min(420, Math.round(width * 0.7));
    const barLeft = Math.round((width - barWidth) / 2);
    const barTop = Math.round(height / 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    if (this.title) {
      ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = '#6ee36e';
      ctx.fillText(this.title.toUpperCase(), width / 2, barTop - 46);
    }

    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#d8d8e0';
    ctx.fillText(label, width / 2, barTop - 16);

    ctx.fillStyle = '#22222c';
    ctx.fillRect(barLeft, barTop, barWidth, 8);
    ctx.fillStyle = '#6ee36e';
    ctx.fillRect(barLeft, barTop, total ? Math.round((loaded / total) * barWidth) : 0, 8);

    if (total) {
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillStyle = '#6a6a78';
      ctx.fillText(`${loaded} / ${total}`, width / 2, barTop + 28);
    }
  }

  /** Reports a failure on the same screen, since there is no page around it to put one on. */
  fail(message: string): void {
    this.progressed = { loaded: 0, total: 0, label: message };
  }
}
