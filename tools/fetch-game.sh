#!/usr/bin/env bash
# Downloads a copy of the original game, into a directory git ignores.
#
#   ./tools/fetch-game.sh [destination]
#
# The game is freeware, and still on its author's site and on the Internet Archive, which is
# where this takes it from.
# Nothing in this repository carries it: a build is made from a copy fetched here or from one
# you already have, and the checksum below is what says the copy is the one this was written
# against. An existing file that matches is left alone, so this is cheap to call every time and
# is what makes the download cacheable in CI.
set -euo pipefail

URL="${GAME_URL:-https://archive.org/download/gunner3/gunner3.exe}"
SHA256="3865e0879abdd2f0e6cbba56d315a402f1474ba50cec669b1e7d01a5c62bfa4f"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO_ROOT/game/gunner3.exe}"

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
  echo "That download is not the copy this was written against." >&2
  echo "  expected $SHA256" >&2
  echo "  got      $got" >&2
  exit 1
fi

mv "$OUT.part" "$OUT"
echo "Fetched $OUT"
