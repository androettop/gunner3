#!/usr/bin/env bash
# Packs a game into web/public/game.zip, which is what `npm run dev` serves.
#
#   ./tools/pack-dev.sh [installer-or-game.exe]
#
# Without an argument it uses the copy tools/fetch-game.sh keeps, fetching it if it is not
# there. The music is rendered against a soundfont, which is fetched the same way; $SOUNDFONT
# points at one you already have. This is the same package a real build gets: only the page
# around it differs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ $# -ge 1 ]; then
  GAME="$1"
else
  "$REPO_ROOT/tools/fetch-game.sh"
  GAME="$REPO_ROOT/game/gunner3.exe"
fi

if [ -z "${SOUNDFONT:-}" ]; then
  "$REPO_ROOT/tools/fetch-soundfont.sh"
  SOUNDFONT="$REPO_ROOT/game/GeneralUser-GS.sf2"
fi

cargo build --release --quiet --manifest-path "$REPO_ROOT/tools/unpack/Cargo.toml"
mkdir -p "$REPO_ROOT/web/public"
"$REPO_ROOT/tools/unpack/target/release/unpack" "$GAME" "$REPO_ROOT/web/public/game.zip" \
  --soundfont "$SOUNDFONT"
