#!/usr/bin/env bash
# Downloads the General MIDI soundfont the music is rendered against, into a directory git
# ignores.
#
#   ./tools/fetch-soundfont.sh [destination]
#
# The game's music is MIDI: a score that names instruments but carries none of them, so what it
# sounded like was whatever synthesiser the machine had. Browsers have none, so tools/unpack
# renders the tracks itself, and this is the instrument bank it renders them with. GeneralUser
# GS is free for any use, including the music made with it, which is what a build carries; the
# soundfont itself is 32 MB and stays out of both this repository and the build.
#
# The URL is pinned to a commit and the checksum to the file at it, so a build is made from the
# same instruments every time. An existing file that matches is left alone.
set -euo pipefail

COMMIT="97049183643d5fc5a9322a69c5b09efb667c6c3a" # GeneralUser GS v2.0.3
REPO="https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS"
URL="${SOUNDFONT_URL:-$REPO/$COMMIT/GeneralUser-GS.sf2}"
SHA256="9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO_ROOT/game/GeneralUser-GS.sf2}"

checksum() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if [ -f "$OUT" ] && [ "$(checksum "$OUT")" = "$SHA256" ]; then
  echo "Already have $OUT"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
echo "==> Fetching $URL"
curl -fL --retry 4 --retry-delay 2 --retry-connrefused -o "$OUT.part" "$URL"

got="$(checksum "$OUT.part")"
if [ "$got" != "$SHA256" ]; then
  rm -f "$OUT.part"
  echo "That download is not the soundfont this was written against." >&2
  echo "  expected $SHA256" >&2
  echo "  got      $got" >&2
  exit 1
fi

mv "$OUT.part" "$OUT"
echo "Fetched $OUT"
