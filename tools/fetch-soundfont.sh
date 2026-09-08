#!/usr/bin/env bash
# Downloads the General MIDI soundfont the music is played with, into a directory git ignores.
#
#   ./tools/fetch-soundfont.sh [destination]
#
# The game's music is MIDI: a score that names instruments but carries none of them, so what it
# sounded like was whatever synthesiser the machine had. Browsers have none, so the runtime
# carries one, and this is the bank it plays. GeneralUser GS is free for any use, including
# redistribution, which is what a build does with the part of it the game reaches; the whole
# bank is 8 MB and stays out of this repository.
#
# This is the SF3 edition, whose samples are already compressed: what a build ships is a subset
# of it, and the subset is small because it is never decompressed on the way through.
#
# The URL is pinned to a commit and the checksum to the file at it, so a build is made from the
# same instruments every time. An existing file that matches is left alone.
set -euo pipefail

COMMIT="6f7505087eba09bdbf345c97f5cf573fc547412e" # GeneralUser GS v2.0.3
REPO="https://raw.githubusercontent.com/spessasus/SpessaSynth"
URL="${SOUNDFONT_URL:-$REPO/$COMMIT/soundfonts/GeneralUserGS.sf3}"
SHA256="e2ed326ff44d15f78f2fdc72403b6fa6b77ee7266d3aad0d2198bc95797bc66c"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO_ROOT/game/GeneralUserGS.sf3}"

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
