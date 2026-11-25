#!/usr/bin/env bash
# Publish azahar-web/dist to the gh-pages branch (GitHub Pages).
# Pages cannot set COOP/COEP headers, so the page relies on web/coi-sw.js for cross-origin isolation.
# Only redistributable demo homebrew is published (Craftus Reloaded, MIT; textures CC BY-SA).
# The deploy commit records the source commit it was built from (GPLv3 corresponding source).
# usage: deploy-pages.sh            (run after build.sh, from a clean working tree)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"
HOMEBREW="$ROOT/test-homebrew"
REMOTE="${REMOTE:-origin}"

cd "$ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean: commit first so the deploy maps to a source commit" >&2
  exit 1
fi
SRC_COMMIT="$(git rev-parse HEAD)"
SRC_URL="$(git remote get-url "$REMOTE" | sed -e 's#\.git$##' -e 's#^git@github.com:#https://github.com/#')"

# Prevent publishing the legacy picker page or a build without home assets.
for needed in index.html home-v5.js home-v5-5.js home-v5.css home-v5-5.css gaemboy3ds-cache.js gaemboy3ds-page.js gaemboy3ds-worker.js home-v5-assets/logo.png home-v5-assets/loginBG.png home-v5-covers.json; do
  [ -s "$DIST/$needed" ] || { echo "Missing mandatory Gaemboy v5 asset: $needed" >&2; exit 1; }
done
grep -q 'home-v5.js' "$DIST/index.html" || { echo "Refusing to publish legacy index.html" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$DIST"/. "$STAGE"/
touch "$STAGE/.nojekyll"
mkdir -p "$STAGE/homebrew"
if [ -f "$HOMEBREW/craftus_reloaded.3dsx" ]; then
  cp "$HOMEBREW/craftus_reloaded.3dsx" "$STAGE/homebrew/"
  cat > "$STAGE/homebrew/README.md" <<'EOF'
# Demo homebrew

`craftus_reloaded.3dsx` - Craftus Reloaded by Kemal Afzal "RSDuck", MIT license.
Textures by XSSheep, CC BY-SA. Source and full license: https://github.com/RSDuck/craftus_reloaded

Copyright 2017 Kemal Afzal "RSDuck"

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
EOF
fi
cat > "$STAGE/SOURCE.txt" <<EOF
Built from $SRC_URL/tree/$SRC_COMMIT
Emulator core: Azahar (GPLv3+), pinned commit and patches listed in that tree.
EOF

cd "$STAGE"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" \
  commit -q -m "Deploy $SRC_COMMIT"
git push -f "$(git -C "$ROOT" remote get-url "$REMOTE")" gh-pages
echo "deployed $SRC_COMMIT to gh-pages"
