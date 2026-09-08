# Gunner 3

A port of **Gunner 3** by KNPMaster (Gary Gasko). The assets, frames and event tables are
extracted from the original Multimedia Fusion 1.5 executable, and the engine that runs them is
reimplemented from reverse engineering, drawing on
[Matt-Esch/anaconda](https://github.com/Matt-Esch/anaconda) and
[NebulaFD](https://github.com/AITYunivers/NebulaFD) among others for what the formats mean.

| Main menu | First level |
|---|---|
| ![The main menu](docs/screenshots/title.png) | ![The first level](docs/screenshots/level.png) |

**[Play it here](https://androettop.github.io/gunner3/)**, or
**[on a phone](https://androettop.github.io/gunner3/?touch=true)**, which is the same page asked
for with its touch controls up. That demo is built from the latest commit on `main`, the same
way a build on your own machine is.

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

A copy of the game and the soundfont its music is played with land in `game/`, and builds in
`build/`; git ignores both.

## Building

```sh
./tools/package.sh          # or: ./tools/package.sh gunner3.exe build
npx --yes serve build
```

Without a path it fetches one: `tools/fetch-game.sh` takes a copy from the Internet Archive over
a pinned checksum, into `game/`. A copy already there is left alone. `tools/fetch-soundfont.sh`
does the same for [GeneralUser GS](https://www.schristiancollins.com/generaluser.php), which is
the instrument bank the music is played with; `$SOUNDFONT` points at one you already have.

That takes about five seconds and writes three things: `fusion-runtime.js`, a `game.zip` holding
everything the runtime needs, and an `index.html` that imports the one and calls it with the
other:

```html
<canvas id="game"></canvas>
<script type="module">
  import { play } from './fusion-runtime.js';
  window.fusion = await play({ package: 'game.zip', canvas: 'game' });
</script>
```

That is the whole of the page, and the whole of the library's public surface. A build comes to
6.0 MB: 5.1 MB of game, of which 3.0 MB is the instruments its music needs, and 1.0 MB of
runtime.

The input can be either the installer the game's own page hands you or the game inside it, and
which it is does not have to be said. `tools/unpack` reads the executable and writes the
package: the chunks, the compression, the image bank, the sounds, the music, the frames, the
objects and the event tables. The music is MIDI, a score with no instruments in it, so the
packaging step also cuts a General MIDI bank down to the presets the game's fifteen tracks
reach (53 of 287, and 272 samples of 920) and puts that in the package too. `web/` is the
runtime that interprets it.

The page is the canvas and nothing else, on black. The loading screen is drawn on that canvas by
the runtime, and names the game as its package gives it.

## Playing it with a thumb

Asked for as `?touch=true`, the game comes up with controls over it and fitted to the screen.

The game is played by keyboard: its own event tables ask whether a key is down. So the controls
are HTML over the page, and what they produce is `keydown` and `keyup` on the window, which is
where Excalibur listens. Nothing in the game knows it is being played by touch, and a layout is
a description of which keys a thumb can reach rather than a change to the game.

| Control | Where | Key |
|---|---|---|
| Steering | the whole left half, with nothing drawn on it | the arrow keys |
| Shoot | right, above the other two | `Ctrl` |
| Jump | bottom right | `Shift` |
| Roll | beside jump | `Z` |
| Previous and next weapon | top right | one key per weapon, in the game's own order |
| Back | top right, on the load screen | `Escape` |

Steering reads where the finger has moved to rather than where it landed, and only once it has
left a deadzone, so a thumb resting on the glass is a thumb standing still. Jump, shoot and roll
wear silhouettes of the game's own sprites, taken from the sprite bank as it is loaded, so the
buttons show the game's drawing of what they do; nothing of the game is copied into the runtime
to draw them.

A layout is data: round buttons and at most one steering area, each either pinned to a corner or
placed as a fraction of the screen, and each layout names the frames it is for. The default is
`web/src/runtime/touch/layout.ts`, and this game's gives its eight levels the whole set, its
load screen a way back out, and its menus nothing at all. Another game is another list, which
`play({ touch: [...] })` takes in place of it.

The two buttons in the top corner are up whether or not there are controls, since fitting the
game to the screen belongs to the page rather than to the game: one fills the screen, and the
other moves between the game's own size and as large as fits. Both keep the whole picture and
its shape.

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

- **The music is played on instruments of its own.** The original read the score note by note
  through whatever synthesiser the machine had, which is why it never sounded the same on two of
  them. Here the runtime carries the synthesiser and the game carries the instruments, so the
  score plays as written, on a good General MIDI set, rather than on the particular one any one
  player happened to hear.
- **Aiming is measured from the muzzle, and rounded.** The reference runtime measures a launch
  toward a position from the shooter's hotspot and truncates the resulting angle. Measured that
  way, this game's six aims come out at 40.5, 1.7 and 178.3 degrees where its own events want
  45, 0 and 180, and truncating sends two of them a whole direction wide of where the gun points.
  From the muzzle, rounded to the nearest direction, all six land where the game puts them.
