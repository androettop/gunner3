# Clickteam Install Creator payload format

Notes from reverse-engineering `gunner3.exe` (the installer). Offsets below are from that file.

## Locating the payload

The payload is appended after the last PE section's raw data, at
`max(PointerToRawData + SizeOfRawData)` over the section table. For this installer that is
`0x13000`; everything from there to EOF is Clickteam data.

## Chunks

The payload is a flat list of chunks:

```
[uint32 tag][uint32 size][size bytes of body]
```

If `tag & 0xFFFF0000` is non-zero the body is compressed:

```
[uint32 decompressedSize][Anaconda deflate stream]
```

Otherwise the body is stored verbatim. Observed tags (low 16 bits):

| Tag | Contents |
|---|---|
| `0x1234` | small integer setting |
| `0x1235` | default install path |
| `0x1236` | installer background bitmap |
| `0x1238` | application name |
| `0x123A` | stored blob (dialog data) |
| `0x1242` | dialog / UI resource table |
| `0x1243` | **file table** |
| `0x7F7F` | **file blob**, the terminator tag, also used by Fusion's own pack format |

### The `0x7F7F` chunk

Its body is prefixed with its own `uint32` length and then runs **to the end of the file**,
four bytes past what the chunk header advertises. Miss that and every stream after the first
decodes to garbage. Concretely: file data starts at `chunkStart + 12` and ends at EOF.

## File table (`0x1243`)

```
[uint32 count]
repeat count times:
  [uint32 entrySize]          ; includes the 4 bytes of entrySize itself
  [entrySize - 4 bytes]       ; entry body
```

Offsets **from the start of an entry**, length field included:

| Offset | Field |
|---|---|
| 0 | `uint32` entry length, which is how far the next entry is |
| 18 | `uint32` decompressed size |
| 22 | `uint32` compressed size |
| 26 | for entry 0, the NUL-separated strings; for the rest, three `FILETIME` values first |
| end | NUL-separated strings, the first being the file name |

Only the two sizes and the entry length are needed to walk the blob, and those three sit at
fixed offsets in every entry. What varies is the tail: the strings are what make one entry
longer than another, and entry 0 (the uninstaller) has no `FILETIME` block, so the name starts
straight after the sizes there and 23 bytes later in the others. A reader that only wants the
files can ignore all of it and step by the entry length.

In this installer the entries are 70, 67, 66, 67 and 83 bytes, and the file table decompresses
from 233 bytes to 357.

## Compression

The installer's streams are the same ones the game itself is stored in, so they are decoded by
the same reader: deflate's coding with a different block header and a different code-length
alphabet order. See [the MMF 1.5 notes](mmf15-format.md#compression) for the details. zlib and
every deflate library built on it reject these streams.

## Contents of this installer

| File | Compressed | Decompressed |
|---|---|---|
| `Uninstal.exe` | 17590 | 49618 |
| `cncs232.dll` | 136727 | 285696 |
| `cncs32.dll` | 89137 | 172032 |
| `gunner3.bmp` | 7873 | 107574 |
| `gunner3.exe` | 1852059 | 2114470 |

The compressed sizes sum to exactly the blob length, which is a useful check that the
table and blob are being walked correctly.

`tools/unpack` reads all five out of the installer byte for byte, and the package it builds from
the `gunner3.exe` inside is identical to the one it builds when handed that `gunner3.exe`
directly.
