#!/usr/bin/env bash
# Regenerate the slide pages and compile them into OnSight-deck.pdf (one page per slide).
set -euo pipefail
cd "$(dirname "$0")"
python3 build.py
CHROME=${CHROME:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium)}
tmp=$(mktemp -d)
for f in slides/*.html; do
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --allow-file-access-from-files \
    --virtual-time-budget=3000 --print-to-pdf="$tmp/$(basename "$f" .html).pdf" "$f" 2>/dev/null
done
pdfunite "$tmp"/*.pdf OnSight-deck.pdf
rm -rf "$tmp"
echo "wrote OnSight-deck.pdf ($(pdfinfo OnSight-deck.pdf | awk '/Pages/ {print $2}') pages)"
