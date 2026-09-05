#!/usr/bin/env bash
# Download the full-length GoPro sample files from gopro/gpmf-parser (Apache-2.0)
# into samples/ (git-ignored) for manual testing with the viewer:
#   npm run samples && npm start -- --media samples
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="samples"
mkdir -p "$DEST"
BASE="https://raw.githubusercontent.com/gopro/gpmf-parser/master/samples"
for f in hero5.mp4 hero6.mp4 hero6a.mp4 hero7.mp4 hero8.mp4 Fusion.mp4 karma.mp4 max-heromode.mp4; do
  if [ -s "$DEST/$f" ]; then echo "exists  $f"; continue; fi
  echo "fetch   $f"
  if curl -fsSL --retry 3 -o "$DEST/$f.part" "$BASE/$f"; then
    mv "$DEST/$f.part" "$DEST/$f"
  else
    echo "failed  $f (see the curl error above)" >&2; rm -f "$DEST/$f.part"; exit 1
  fi
done
echo "done → $DEST"
