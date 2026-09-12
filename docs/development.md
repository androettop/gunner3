# Development

## What is in here

| Path | Contents |
|---|---|
| `web/` | The runtime, as a library |
| `tools/unpack/` | Reads a Clickteam game and writes the package the runtime loads |
| `tools/*.sh` | Fetching the game and the soundfont, and building a page from them |
| `docs/` | These notes, and the file formats |

`game/` and `build/` are git-ignored.

## Building

```sh
./tools/package.sh          # or: ./tools/package.sh gunner3.exe build
npx --yes serve build
```

With no path given, `tools/fetch-game.sh` downloads a copy from the Internet Archive against a
pinned checksum, into `game/`. `tools/fetch-soundfont.sh` does the same for
[GeneralUser GS](https://www.schristiancollins.com/generaluser.php), the instrument bank the
music is played with; set `$SOUNDFONT` to use one you already have. Either input works: the
installer from the game's own page, or the game inside it.

The build takes a few seconds and writes three files into `build/`:

| File | What it is |
|---|---|
| `fusion-runtime.js` | The runtime, as one ES module (1.0 MB) |
| `game.zip` | Everything it plays: frames, events, images, audio (5.1 MB) |
| `index.html` | A canvas and four lines of script |

```html
<canvas id="game"></canvas>
<script type="module">
  import { play } from './fusion-runtime.js';
  window.fusion = await play({ package: 'game.zip', canvas: 'game' });
</script>
```

That is the whole public API. `./tools/package.sh --single-file` writes one HTML file instead,
with the library and the package inside it as data URLs, which runs straight off the file
system. `.github/workflows/build.yml` does all of this on every push and publishes to GitHub
Pages.

## Working on the runtime

```sh
cd web
npm install
npm run pack       # fetches the game and packs it into public/game.zip, once
npm run dev
```

`npm run build` produces the library and its type declarations, and checks every opcode in the
game's event tables against what the interpreter implements.

## Looking at it while it runs

The running game is left on `window.fusion`, and `fusion.debug` opens up its state from the
console. `fusion.debug.help()` lists everything. What it returns are the runtime's own objects,
so writing to one changes the game:

```js
fusion.debug.state();                    // the frame, the tick, the camera, what is playing
fusion.debug.show(3);                    // jump to a frame, by index or by name
fusion.debug.instances('Gunner');        // what is in the frame, as a table
fusion.debug.set('Health', 0, 100);      // write an alterable value
fusion.debug.pause(); fusion.debug.step(1);          // hold the game, then hand it one tick
fusion.debug.watch('Gunner');                        // report its values as they change
fusion.debug.record(); fusion.debug.fired();         // count what fires, then read the count
fusion.debug.trace(207); fusion.debug.traceLines();  // watch one event decide, condition by condition
fusion.debug.destroyed();                            // what has been taken away, and by which event
```

A paused game is still drawn, so it can be looked at and moved around. It normally stops when
its window loses focus, which is useless when the window you are using is the browser's own
tools: `fusion.debug.pauseOnBlur(false)` turns that off, and is remembered across reloads.

Pass `debug: false` to `play` to leave the window alone, or a name of your own to be reached
under.

## The unpacker

`tools/unpack` is a Rust program with one dependency, built for you by `tools/package.sh`. On
its own:

```sh
cargo run --release --manifest-path tools/unpack/Cargo.toml -- gunner3.exe game.zip
```

It reads the format described in [mmf15-format.md](mmf15-format.md), checked field by field
against a dump made by an unrelated program, with no mismatches. The music is MIDI, a score with
no instruments in it, so packaging also cuts a General MIDI bank down to the 53 presets the
game's fifteen tracks actually reach.
