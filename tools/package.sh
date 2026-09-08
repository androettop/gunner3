#!/usr/bin/env bash
# Turns a copy of the original game into a playable build.
#
#   ./tools/package.sh [--single-file] [installer-or-game.exe] [outDir]
#
# Reads the game, packs everything the runtime needs into one zip, builds the runtime library,
# and writes a page that imports the library and calls it with that package. The library carries
# no game of its own: what comes out of here is the only place the two meet, and it is built
# from a copy you already have. Without a path, tools/fetch-game.sh supplies one.
#
# The game's music is MIDI, and it is rendered into audio here, against the soundfont
# tools/fetch-soundfont.sh fetches. $SOUNDFONT points at one you already have instead.
#
# Needs Rust and Node, and cmake and a C compiler for the Opus encoder the music is written
# with. The game is read by tools/unpack, which is this repository's own.
#
# The output has to be served over HTTP: a page opened from the file system cannot fetch its
# own package. Any static server will do:
#
#   npx --yes serve <outDir>
#
# --single-file writes one HTML file instead, with the library and the package inside it, which
# does run straight off the file system.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SINGLE_FILE=0
if [ "${1:-}" = "--single-file" ]; then
  SINGLE_FILE=1
  shift
fi

# An empty first argument means the same as none: fetch a copy. That is what lets a caller
# pass a path it may not have (a workflow with the game already downloaded, say) in one place.
if [ -n "${1:-}" ]; then
  GAME="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  "$REPO_ROOT/tools/fetch-game.sh"
  GAME="$REPO_ROOT/game/gunner3.exe"
fi
if [ $# -ge 1 ]; then shift; fi

OUT_DIR="${1:-$REPO_ROOT/build}"
OUT="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ ! -f "$GAME" ]; then
  echo "No such file: $GAME" >&2
  exit 1
fi

if [ -z "${SOUNDFONT:-}" ]; then
  "$REPO_ROOT/tools/fetch-soundfont.sh"
  SOUNDFONT="$REPO_ROOT/game/GeneralUser-GS.sf2"
fi

echo "==> Reading $GAME"
cargo build --release --quiet --manifest-path "$REPO_ROOT/tools/unpack/Cargo.toml"
"$REPO_ROOT/tools/unpack/target/release/unpack" "$GAME" "$STAGE/game.zip" --soundfont "$SOUNDFONT"

cd "$REPO_ROOT/web"
[ -d node_modules ] || npm install --silent

# The page's title comes from the game's own name, which is in the package; the opcode coverage
# check reads the same package, so the build is verified against the game it is being made for.
unzip -p "$STAGE/game.zip" game.json > "$STAGE/game.json"

echo "==> Building the runtime library"
GAME_PACKAGE="$STAGE/game.zip" npm run build --silent

echo "==> Writing $OUT"
if [ "$SINGLE_FILE" = 1 ]; then
  node scripts/write-page.mjs --manifest "$STAGE/game.json" --library dist/fusion-runtime.js \
    --inline "$STAGE/game.zip" --out "$OUT/index.html"
  echo
  echo "Built $OUT/index.html: open it in a browser."
else
  # Anything already in the output that this build replaces goes, so a rebuild does not leave
  # the previous library behind; a package under another name is left alone.
  rm -f "$OUT/index.html" "$OUT/fusion-runtime.js" "$OUT/game.zip"
  cp dist/fusion-runtime.js "$OUT/fusion-runtime.js"
  cp "$STAGE/game.zip" "$OUT/game.zip"
  node scripts/write-page.mjs --manifest "$STAGE/game.json" --library fusion-runtime.js \
    --package game.zip --out "$OUT/index.html"
  echo
  echo "Built $OUT: serve it over HTTP, for example:"
  echo "  npx --yes serve \"$OUT\""
fi
