# MMF 1.5 game file

Every structure here is written from the bytes of `gunner3.exe`;
[anaconda](https://github.com/Matt-Esch/anaconda) and
[NebulaFD](https://github.com/AITYunivers/NebulaFD) are what made it possible to know what those
bytes are called. Each reading was then checked against a dump of the same game made by an
unrelated program, which is what says these are the right readings and not merely plausible
ones; the totals are at the end.

## Locating the game

The game is appended to an ordinary Windows executable, past everything the loader maps, so it
begins where the last PE section's raw data ends, at `max(PointerToRawData + SizeOfRawData)` over
the section table. In this file that is `0x45400`.

Two things can sit there. If the first `uint16` is **8748**, what follows is the *pack data*: a
chunk list carrying the extension binaries the game shipped with, ending at chunk `0x7F7F`. The
game itself starts after it. Otherwise the game starts immediately.

## Game header

```
'PAME'            4 bytes
runtimeVersion    uint16     768 for MMF 1.5
runtimeSubversion uint16
productVersion    uint32
productBuild      uint32
```

This game reports 768.0, build 6480.

## Chunks

A flat list, ending at id `0x7F7F`:

```
id     uint16
flags  uint16     1 = the body is compressed
size   uint32
body   size bytes
```

A compressed body is a `uint32` decompressed length followed by the stream described next.

Chunk ids seen here: 8739 AppHeader, 8740 AppName, 8741 AppAuthor, 8750/8751 project paths,
8742, 8744, 8747, 8755, and 21845-21848.

## Compression

The coding is DEFLATE's: a least-significant-bit-first bit reader, canonical Huffman codes, the
length and distance tables of RFC 1951, back-references into the output. **How a block announces
itself is not.** DEFLATE opens a block with one bit saying whether it is the last and two naming
its kind. This opens with **three bits of kind and then the last-block flag**, and numbers the
kinds differently:

| Kind | Meaning |
|---|---|
| 5 | coded with the fixed tree |
| 6 | coded with a tree carried in the block |
| 7 | stored |

A stored block aligns to the next byte and gives a `uint16` length, and then its bytes; it does
not follow the length with the complement DEFLATE puts there.

Decoded, the application header is 84 bytes with the flags word `0xAF8A`, the colour mode 4 and
the window 640x480 where they belong, and the short chunks beside it read `Gunner 3`,
`KNPMASTER` and the path the project was built from.

One more thing differs, and it is the one that hides: the order in which the code-length
alphabet's own lengths are stored. DEFLATE interleaves that order so the lengths most likely to
be used come first (16, 17, 18, 0, 8, 7, 9, 6, and so on). This puts the three repeat codes at
the front, largest first, and then counts up:

```
18, 17, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
```

Everything else about a carried-tree block is DEFLATE's. With that ordering all thirty chunks in
this game decode, and so does every entry in the image bank.

## Image bank

A `uint32` count, then one entry per image:

```
handle    uint32
size      uint32     what the entry comes to once decompressed
stream    ...        length not given; the decoder finds it
```

The entry does not say how long its stream is. The next entry begins where the decoder stopped,
counting the byte holding the last bit it read as used.

Decompressed, an image is a 24-byte header and then its data:

```
checksum    uint16
references  uint32
dataSize    uint32     bytes of image data after this header
width       uint16
height      uint16
graphicMode uint8
flags       uint8      bit 0 RLE, 1 RLEW, 2 RLET, 3 LZX, 4 Alpha, 5 ACE, 6 Mac
hotspotX    uint16
hotspotY    uint16
actionX     uint16
actionY     uint16
```

The graphic mode gives the pixel size: mode 4 is three bytes, stored blue first; modes 6 and 7
are two. Rows are padded out to an even number of bytes, rounded up to whole pixels.

With any of the RLE flags set the pixels are run-length coded. A command byte of zero ends the
data; over 128 means that many minus 128 pixels follow literally; anything else repeats the one
pixel that follows it that many times. Positions falling in a row's padding are still counted and
still consume their pixel, but are not kept.

There is no alpha channel in this version. Black is the transparent colour.

## Sound and music banks

Same shape as the image bank, and the same 22 bytes of header on each item:

```
checksum    uint16
references  uint32
size        uint32     the name and the item, together
(unused)    uint32
(unused)    uint32
nameLength  uint32
name        nameLength bytes, zero-padded
```

Music is a MIDI file stored whole, from the end of the name to the end of the item.

A sound is not a file. What is stored is the sixteen-byte wave format structure, the length of
the samples, and then the samples, so the RIFF wrapper has to be built around them.

## Frames

A frame chunk is a chunk list of its own, with the same headers and the same compression as the
outer one:

| Id | Contents |
|---|---|
| 13108 | header |
| 13109 | name, zero-terminated |
| 13111 | palette: four bytes, then 256 colours of four bytes |
| 13112 | the objects placed in the frame |
| 13117 | the event table |

The header is ten bytes: width and height as `uint16`, then the background colour stored red
first with a fourth byte that is not part of it, then flags.

The instance list is a `uint32` count and then twelve bytes each: handle, the object it is an
instance of, x and y as signed `uint16`, and two more `uint16` for the parent it is attached to.

## Object definitions

The chunk opens with a `uint32` count and then describes each object with a chunk list of its
own, closed by the same terminator the outer lists use:

| Id | Contents |
|---|---|
| 17476 | header, 16 bytes |
| 17477 | name, zero-terminated |
| 17478 | properties, which depend on the type |

Not every object carries all three; 67 of this game's 375 have no name chunk.

The header is:

```
handle          uint16
objectType      uint16    0 quick backdrop, 1 backdrop, 2 active, 3 text, 4 question,
                          5 score, 6 lives, 7 counter, 8 RTF, 9 sub-application
flags           uint16
(unused)        uint16
inkEffect       uint32    the effect in the low half, drawing flags in the high
inkEffectParam  uint32
```

Bit 2 of the flag word marks a global object, one object across the whole application rather
than one per frame, which is what carries a save file's counters from the load screen into a
level. Correlating every bit of every field against a known-good dump pins it there uniquely: it
comes out set on 23 objects, which are exactly the counters a save file is made of.

### Properties of a drawn object

Fields at fixed positions:

```
0   size              uint32
4   movementsOffset   uint16
6   animationsOffset  uint16
8   version           uint16
10  counterOffset     uint16
12  systemObject      uint16
18  flags             uint16
20  qualifiers        8 x uint16, -1 ending the list
44  identifier        4 characters
48  backColor         red, green, blue, and a fourth byte that is not part of it
```

The animation table sits at its offset and is a size, a count, and one `uint16` offset per
animation slot, relative to the table. A slot the object does not use has an offset of zero, so
a slot's number is the animation's own number rather than its position in a list, which is why
this game's objects carry animations numbered 0, 1, 7, 12, 13 and 14 with nothing in between.

An animation is 32 direction offsets, again by slot, relative to the animation. A direction is:

```
minSpeed     uint8
maxSpeed     uint8
repeat       uint16
repeatFrame  uint16
frameCount   uint16
frames       frameCount x uint16, each an image handle
```

### The rest of an object's properties

A **backdrop** is `obstacleType`, `collisionType` and an image handle, all `uint16`. A **quick
backdrop** is `obstacleType`, `collisionType`, width and height, then its shape: border size,
border colour, shape type, fill type, the two colours, whether the gradient runs down or across,
and last the image handle.

A **counter** sits at its own offset: a `uint16` size, then the reading, the minimum and the
maximum as `int32`. A counter that only feeds expressions stops there. One that draws itself
carries how, past the range: width and height as `uint16` at +18 and +20, the display kind as a
`uint32` at +24, and at +28 a `uint16` count of images followed by that many handles. The kinds
are 0 hidden, 1 a row of digit images, 2 and 3 bars, 4 an animation and 5 text, and the images
are one per glyph, in the order 0-9 and then the sign and the point.

**Movements** sit at theirs. Twelve bytes of header:

```
control            uint16
type               uint16    0 static, 4 ball, 5 path, 9 platform
movingAtStart      uint16
options            uint16
startingDirection  uint32    a mask, as directions are elsewhere
```

Every object here carries exactly one, and what follows the header is what the type calls for.
A **ball** is speed, bounce, the number of angles it is held to, the bouncing security and the
deceleration, five `uint16`. A **platform** is speed, acceleration, deceleration, jump control,
gravity and jump strength, six `uint16`. A **path** is a `uint16` node count, its minimum and
maximum speed as `uint16`, then loop, reposition and reverse as bytes, and from +22 its nodes,
fourteen bytes each:

```
speed      uint8
direction  uint8
dx, dy     int16     the leg's whole displacement
cos, sin   int16     that displacement as a unit vector, x16384
length     uint16
pause      uint16    ticks to wait at the end of it
```

Those settings are the movement. Without them an object that carries one stands still: the
remote missile steers but never travels, and the sparks a shot throws off sit where they were
made instead of flying apart.

**Paragraphs**, what a text object shows and a question object offers, sit behind the system
object offset, but not at it: eight bytes come first, then a `uint16` count and one `uint16`
offset per paragraph, each measured from the offset itself rather than from the table. A
paragraph is a `uint16` size, the font, the colour, two more bytes, and then its text. Only text
and question objects have them; everything else uses that offset for something else, and reading
it regardless invents paragraphs for counters.

## Event tables

Not a chunk list but a tagged container, with four-character ASCII tags:

```
'ER>>'   header, 42 bytes after the tag
'ERes'   uint32 size, then
  'ERev' uint32 size, then the events
'<<ER'   the end
```

Inside `ERev` is a run of event groups, each saying its own length so the run can be walked
without understanding any of it:

```
size          int16    negative; its magnitude is the group's length
conditions    uint8
actions       uint8
(header)      10 more bytes
conditions[]  then actions[]
```

A condition or an action is:

```
size            uint16
objectType      int8
num             int8
objectInfo      uint16
objectInfoList  uint16
(unused)        uint16
parameterCount  uint16
(conditions)    uint16    two bytes actions do not carry
parameters[]    each: uint16 size, uint16 code, body
```

One catch: the opcode byte holds 48 where the opcode is called 80 everywhere else, and 32 has to
be added back for any opcode of 48 or more, in whichever direction its sign points. That is not
in the bytes: it is a normalisation, and the runtime's own opcode tables are written in the
second numbering, so it belongs here.

A parameter's body depends on its code. The ones this game uses:

| Code | Body |
|---|---|
| 1 | object list, object, object type, as three `uint16` |
| 2 | a timer as `uint32`, then loops |
| 6, 7 | a sound or music handle as `uint32`, then its name |
| 13 | two `uint32`: the delay and the count |
| 32 | button and whether the click was double |
| 38 | group flags, the group's id, its name |
| 9, 16, 18, 21 | a placement: see below |
| 22, 23, 45 | a comparison and a run of expression tokens |
| 29, 31, 43, 50 | a signed `int32` |
| others | a `uint16` |

A **placement**, where to create something or put it or shoot it, is the object
it hangs off at +0, flags at +2, x and y as signed at +4 and +6, slope and angle, the direction
as a signed `int32` at +12, the parent's type at +16, the object list at +18, the layer at +20,
the instance at +22 and the object at +24. A shoot parameter adds its speed at +30.

An **expression** is a comparison and then a flat run of tokens, each an object type, an opcode,
its own length, and a payload. A four-byte token is an operator and carries nothing, so reading an
object out of one reads into the token after it. A longer token belonging to the system object
carries a value, a number for opcode 0 and text for opcode 3; a longer token belonging to
anything else names the object it reads from, and carries a value only if it is longer still.
The opcode inside a token needs the same shift by 32 that an event's own opcode does.

## What was checked

Every reading above was compared, field by field, against a dump of the same game made by an
unrelated program. Nothing disagreed:

| | |
|---|---|
| Images | 2611, pixel for pixel |
| Music | 15 MIDI files, byte for byte |
| Sounds | 34, samples byte for byte |
| Frames | 12, with 7819 instances |
| Objects | 375, and 760 animation directions |
| Object properties | 244 movements with their settings, 41 path nodes, 308 counters, 67 backdrops, 41 paragraphs |
| Events | 35110 conditions and actions |
| Parameters | 87294 fields |

The sounds are compared on their samples rather than whole, because that dump's RIFF headers are
wrong: a total four bytes too large, and a data-chunk length that is not the length of the data.
The ones written here say what is actually there. Players tolerate both.

Neither that dump nor a copy of the game is in this repository any more. The dump came from a
program driven externally while this was being written, and `tools/unpack` replaced it. What
remains is the reading it verified.
