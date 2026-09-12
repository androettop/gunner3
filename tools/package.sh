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
# The game's music is MIDI, so a package also carries the instruments to play it with: the part
# of a General MIDI bank the game reaches, cut out of the one tools/fetch-soundfont.sh fetches.
# $SOUNDFONT points at a bank you already have instead.
#
# Needs Rust and Node. The game is read by tools/unpack, which is this repository's own.
#
# What comes out is installable: the page carries a web app manifest and a worker that keeps a
# copy of the build, and the icon on it is the one the game's own executable wears, read out of
# it by tools/unpack.
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
  SOUNDFONT="$REPO_ROOT/game/GeneralUserGS.sf3"
fi

echo "==> Reading $GAME"
cargo build --release --quiet --manifest-path "$REPO_ROOT/tools/unpack/Cargo.toml"
"$REPO_ROOT/tools/unpack/target/release/unpack" "$GAME" "$STAGE/game.zip"

cd "$REPO_ROOT/web"
[ -d node_modules ] || npm install --silent

echo "==> Cutting the soundfont down to the game"
node scripts/add-soundfont.mjs --package "$STAGE/game.zip" --soundfont "$SOUNDFONT"

# The page's title comes from the game's own name, which is in the package; the opcode coverage
# check reads the same package, so the build is verified against the game it is being made for.
unzip -p "$STAGE/game.zip" game.json > "$STAGE/game.json"

echo "==> Building the runtime library"
GAME_PACKAGE="$STAGE/game.zip" npm run build --silent

# The package carries the game's icon, as the executable wears it and at the sizes a manifest
# asks for. A file the package does not have is simply not laid out.
take() { # take <name in the package> <destination>
  if unzip -p "$STAGE/game.zip" "$1" > "$2" 2> /dev/null; then :; else rm -f "$2"; fi
}

echo "==> Writing $OUT"
if [ "$SINGLE_FILE" = 1 ]; then
  # One file has nowhere to keep an icon beside it, so it carries it the way it carries the
  # rest, and there is nothing to install: a page off the file system gets no worker.
  take icon.png "$STAGE/icon.png"
  node scripts/write-page.mjs --manifest "$STAGE/game.json" --library dist/fusion-runtime.js \
    --inline "$STAGE/game.zip" --icon "$STAGE/icon.png" --out "$OUT/index.html"
  echo
  echo "Built $OUT/index.html: open it in a browser."
else
  # Anything already in the output that this build replaces goes, so a rebuild does not leave
  # the previous library behind; a package under another name is left alone.
  rm -f "$OUT/index.html" "$OUT/fusion-runtime.js" "$OUT/game.zip" \
    "$OUT/manifest.webmanifest" "$OUT/sw.js" "$OUT"/icon*.png
  cp dist/fusion-runtime.js "$OUT/fusion-runtime.js"
  cp "$STAGE/game.zip" "$OUT/game.zip"
  take icon.png "$OUT/icon.png"
  take icons/192.png "$OUT/icon-192.png"
  take icons/512.png "$OUT/icon-512.png"
  take icons/maskable.png "$OUT/icon-maskable.png"
  node scripts/write-page.mjs --manifest "$STAGE/game.json" --library fusion-runtime.js \
    --package game.zip --icon "$OUT/icon.png" --out "$OUT/index.html" --pwa
  node scripts/write-pwa.mjs --manifest "$STAGE/game.json" --out "$OUT" \
    --library fusion-runtime.js --package game.zip
  echo
  echo "Built $OUT: serve it over HTTP, for example:"
  echo "  npx --yes serve \"$OUT\""
fi
