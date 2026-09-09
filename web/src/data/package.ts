import { unzip } from 'fflate';

/**
 * The game, as one file.
 *
 * The engine ships without a game in it. A packaging script reads a copy of the original and
 * writes everything the runtime needs (the manifest, the per-frame event tables, the sprites
 * and the audio) into a single zip, which is what this loads. Nothing is fetched per asset
 * afterwards, so the whole bank is in hand before the first frame is built.
 *
 * The event tables are JSON and make up most of the uncompressed size, so a game that is 34 MB
 * on disk travels as under 3 MB.
 */
export class GamePackage {
  private constructor(private readonly files: Record<string, Uint8Array>) {}

  /**
   * Downloads and unpacks a package, reporting bytes received and then the unpacking itself.
   *
   * Unpacking runs off the main thread, so the loading screen keeps drawing through it: a
   * synchronous inflate of this much JSON freezes the tab for long enough to look like a hang.
   */
  static async fetch(
    url: string,
    onProgress?: (received: number, total: number, label: string) => void,
  ): Promise<GamePackage> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load the game package at ${url}: ` +
        `${response.status} ${response.statusText}`);
    }

    const expected = Number(response.headers.get('content-length') ?? 0);
    const bytes = await readAll(response, expected, onProgress);

    onProgress?.(expected || bytes.length, expected || bytes.length, 'Unpacking');
    return new GamePackage(await extract(bytes));
  }

  /** A package whose bytes are already in hand: one embedded in the page it is played from. */
  static async open(bytes: ArrayBuffer | Uint8Array): Promise<GamePackage> {
    return new GamePackage(await extract(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  }

  has(path: string): boolean {
    return this.files[path] !== undefined;
  }

  bytes(path: string): Uint8Array {
    const file = this.files[path];
    if (!file) throw new Error(`${path} is not in the game package`);
    return file;
  }

  json(path: string): unknown {
    return JSON.parse(new TextDecoder().decode(this.bytes(path)));
  }

  /**
   * A file's bytes in a buffer of their own, for the callers that take one and keep it.
   * Decoding audio detaches the buffer it is handed, so it must not be the package's own.
   */
  buffer(path: string): ArrayBuffer {
    const data = this.bytes(path);
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
  }
}

/** Unpacking runs off the main thread: see `fetch` for why that matters. */
function extract(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, unzipped) => (error ? reject(error) : resolve(unzipped)));
  });
}

/** Reads a response body, reporting progress; falls back to one lump where streaming is absent. */
async function readAll(
  response: Response,
  expected: number,
  onProgress?: (received: number, total: number, label: string) => void,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, expected, 'Downloading the game');
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
