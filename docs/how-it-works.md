# How the port works

A Multimedia Fusion game is a table of events running over a set of objects, once per tick. The
port keeps that: it does not translate the game's 7722 events into code, it interprets them as
they stand. That is practical because the whole game uses only 34 condition opcodes and 43
action opcodes, and its expressions are simpler still — 90% are a bare constant, and the rest
are `operand operator operand` over ten token kinds.

So a port is a runtime plus the game's data, and the runtime is the only part another platform
needs.

## The event loop

Every event is visited in order. Its conditions narrow a per-event selection of instances, and
its actions apply to that selection. An unimplemented condition fails its event rather than
letting it fire, so a gap shows up as missing behaviour rather than wrong behaviour.

Two details of Fusion's model are load-bearing and easy to get wrong:

- **An object destroyed by an event does not go until the loop ends.** Every event below the one
  that killed it still finds it, collisions included. The bosses are built on that: a shot is
  destroyed against the boss's body by an event above the one that asks whether it reached the
  weak point laid over it.
- **Collision is per pixel.** Obstacle backdrops are rasterised into a mask for the frame, and
  two objects meet where the images they are showing have an opaque pixel in the same place. A
  sprite is a rectangle around a drawing, and the empty corners of it are where boxes and pixels
  part company — by more than they look.

Movement is stepped in game ticks rather than render frames, since Fusion physics is written as
per-tick deltas: the jump adds a value to Y every tick, and driving that from the render clock
makes the player leap higher on a faster display.

## Deliberate deviations

Everything else is meant to match the original. Where it does not yet, that is a detail still to
be fixed rather than a decision.

- **The music plays on its own instruments.** The original used whatever synthesiser the machine
  had, which is why it never sounded the same twice. Here the runtime carries the synthesiser
  and the package carries the instruments, so the score plays as written.
- **Aiming is measured from the muzzle, and rounded.** Measured from the shooter's hotspot and
  truncated, as the original runtime does it, this game's six aims come out at 40.5, 1.7 and
  178.3 degrees where its own events want 45, 0 and 180 — two of them a whole direction wide.
  From the muzzle, rounded, all six land where the game puts them.

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

## Other games

The runtime carries no knowledge of Gunner 3. What is particular to it lives either in the
package the unpacker writes or in lists of data that another game replaces: the touch layout in
`web/src/runtime/touch/layout.ts` and the gamepad mapping in `web/src/runtime/pad/layout.ts`.

What is implemented is what this game uses, which is why it is the one that runs. Supporting
other Multimedia Fusion games means filling in opcodes, object types and movement engines it
never asked for; `npm run build` already reports every opcode a package uses that the
interpreter does not implement, which is where that work starts.
