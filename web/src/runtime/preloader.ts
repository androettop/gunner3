import { ImageSource } from 'excalibur';
import type { GameData } from '../data/loader';

export interface Progress {
  loaded: number;
  total: number;
  label: string;
}

/**
 * Loads the whole asset bank before the game starts.
 *
 * Requests run through a bounded pool: browsers cap concurrent connections per host anyway, and
 * queueing 2600 fetches at once only makes the progress reporting lumpy and the tab unresponsive.
 */
export class Preloader {
  constructor(private readonly data: GameData, private readonly concurrency = 24) {}

  async loadAll(onProgress: (p: Progress) => void): Promise<Map<number, ImageSource>> {
    const images = new Map<number, ImageSource>();
    const handles = [...this.data.images.keys()];
    const total = handles.length;
    let loaded = 0;

    const report = (label: string) => onProgress({ loaded, total, label });
    report('Loading sprites');

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < handles.length) {
        const handle = handles[next++];
        const source = new ImageSource(this.data.imageUrl(handle));
        try {
          await source.load();
          images.set(handle, source);
        } catch (e) {
          console.warn(`image ${handle}: ${e}`);
        }
        loaded++;
        // Repainting on every single image costs more than it communicates.
        if (loaded % 16 === 0 || loaded === total) report('Loading sprites');
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, handles.length) }, worker));
    report('Ready');
    return images;
  }
}
