# Gunner 3

A port of **Gunner 3** by KNPMaster (Gary Gasko). The assets, frames and event tables are
extracted from the original Multimedia Fusion 1.5 executable, and the engine that runs them is
reimplemented from reverse engineering, drawing on
[Matt-Esch/anaconda](https://github.com/Matt-Esch/anaconda) and
[NebulaFD](https://github.com/AITYunivers/NebulaFD) among others for what the formats mean.

| Main menu | First level |
|---|---|
| ![The main menu](docs/screenshots/title.png) | ![The first level](docs/screenshots/level.png) |

**[Play it here.](https://androettop.github.io/gunner3/)** That demo is built from the latest
commit on `main`, the same way a build on your own machine is.

What this is after is the original experience on other platforms, the web first, on
[Excalibur.js](https://excaliburjs.com/), though nothing about the approach is tied to it. The
game is not rewritten as new code: its own event tables are interpreted as they stand, so a port
is a runtime plus the game's data, and the runtime is the only part another platform needs.

That is also why it should play exactly like the original, bugs included: the logic being run
is the game's own. Most of it already does; a few minor details are still being polished, and
two departures are deliberate and listed at the end.

The game itself is not here. `Gunner 3` is its author's; a build reads a copy of the original,
fetched or already yours, and nothing in this repository carries it. It is freeware, and still
where it has always been: on its author's site, [thegamespage.com](https://www.thegamespage.com/),
and on the [Internet Archive](https://archive.org/details/gunner3).

## Licence

The code (the runtime, the unpacker and the tooling) is **GPLv3**, in `LICENSE`. The game's
own data is not covered by it.

## What is in here

| Path | Contents |
|---|---|
| `web/` | The runtime, as a library: one precompiled ES module that plays a package |
| `tools/unpack/` | Reads a Clickteam game and writes the package the runtime loads |
| `tools/*.sh` | Fetching a copy of the game and a soundfont, and building a page out of them |
| `docs/` | Notes on the file formats reverse-engineered along the way |

A copy of the game and the soundfont its music is rendered against land in `game/`, and builds
in `build/`; git ignores both.

## Building

```sh
./tools/package.sh          # or: ./tools/package.sh gunner3.exe build
npx --yes serve build
```

Without a path it fetches one: `tools/fetch-game.sh` takes a copy from the Internet Archive over
a pinned checksum, into `game/`. A copy already there is left alone. `tools/fetch-soundfont.sh`
does the same for [GeneralUser GS](https://www.schristiancollins.com/generaluser.php), which is
what the music is rendered against; `$SOUNDFONT` points at one you already have instead.

That takes about fifteen seconds, ten of them the music, and writes three things:
`fusion-runtime.js`, a `game.zip` holding everything the runtime needs, and an `index.html` that
imports the one and calls it with the other:

```html
<canvas id="game"></canvas>
<script type="module">
  import { play } from './fusion-runtime.js';
  window.fusion = await play({ package: 'game.zip', canvas: 'game' });
</script>
```

That is the whole of the page, and the whole of the library's public surface. A build comes to
12.7 MB, of which 12.1 MB is the game and 10.4 MB of that is its music, rendered.

The input can be either the installer the game's own page hands you or the game inside it, and
which it is does not have to be said. `tools/unpack` reads the executable and writes the
package: the chunks, the compression, the image bank, the sounds, the music, the frames, the
objects and the event tables. The music is MIDI, which no browser plays, so it is played there
and then against the soundfont and recorded as Ogg Opus. `web/` is the runtime that interprets
it.

The page is the canvas and nothing else, on black. The loading screen is drawn on that canvas by
the runtime, and names the game as its package gives it.

`./tools/package.sh --single-file` writes one HTML file instead, library and package inside it
as data URLs, which runs straight off the file system. A page that fetches a package beside it
cannot, because the browser counts that as cross-origin.

`.github/workflows/build.yml` does all of this on every push, caching the download, and
publishes the result to GitHub Pages as the demo above.

### Working on the runtime

```sh
cd web
npm install
npm run pack       # fetches a copy of the game and packs it into public/game.zip, once
npm run dev
```

The dev server's page calls the library exactly as a built one does. Both leave the running game
on `window.fusion`, which is what there is to reach for from a console: the scene, the loaded
data, and `show(index)` for jumping to a frame.

`npm run build` produces the library and its type declarations, and checks every opcode in the
game's event tables against what the interpreter implements.

### Building the unpacker

`tools/unpack` is a Rust program with one dependency, and `tools/package.sh` builds it for you.
On its own:

```sh
cargo run --release --manifest-path tools/unpack/Cargo.toml -- gunner3.exe game.zip
```

It reads the format described in `docs/mmf15-format.md`, which was worked out here and checked
reading by reading against a dump made by an unrelated program: every image, sound, frame,
object, animation, condition, action and parameter field, with no mismatches.

## The game

`Gunner 3`, Multimedia Fusion 1.5, runtime 768.0 build 6480.

| Content | Count |
|---|---|
| Frames (levels) | 12 |
| Images | 2611 |
| Sounds | 34 |
| Music tracks | 15 |
| Object types | 375 |
| Events | 7722 |

Levels are wide side-scrollers, up to 7500x480 and 6000x2300 pixels.

## How the port works

The port does not hand-translate the game's 7722 events. It interprets the package's event
tables at runtime, which is practical because the whole game uses only 34 condition opcodes and
43 action opcodes, and its expressions are simpler still: 90% are a bare constant and the rest
are `operand operator operand` over ten token kinds.

Fusion's per-tick model is reproduced directly: every event is visited in order, its conditions
narrow a per-event instance selection, and its actions apply to that selection. An unimplemented
condition fails its event rather than letting it fire, so gaps surface as missing behaviour
rather than wrong behaviour.

Collision is per pixel, not per bounding box, as Fusion's is: every backdrop marked an obstacle
is rasterised into a mask for the frame. The movement engines are stepped in game ticks rather
than render frames, since Fusion physics is written as per-tick deltas.

### Deliberate deviations

Everything else is meant to match the original, and where it does not yet, that is a detail
still to be polished rather than a decision.

- **The music is recorded, not played.** The original read the score note by note through
  whatever synthesiser the machine had, which is why it never sounded the same on two of them.
  Here `tools/unpack` plays each track once against GeneralUser GS and the runtime plays the
  recording, so the score is right and the instruments are a good General MIDI set, but they are
  not the particular ones any one player heard. It also costs 10 MB of the download, which is
  the whole of the difference between the two ways round.
- **Aiming is measured from the muzzle, and rounded.** The reference runtime measures a launch
  toward a position from the shooter's hotspot and truncates the resulting angle. Measured that
  way, this game's six aims come out at 40.5, 1.7 and 178.3 degrees where its own events want
  45, 0 and 180, and truncating sends two of them a whole direction wide of where the gun points.
  From the muzzle, rounded to the nearest direction, all six land where the game puts them.
