#!/bin/bash
# TripGrid dev mode — live-reload frontend + API, one command.
#
#   bash /mnt/d/codes/tripgrid/tests/run_dev.sh
#
# Opens the site at http://localhost:5173 with hot reload: edit
# anything in web/src (in the repo, as usual) and the page
# updates within a second or two — no rebuild. The API runs on
# :8000; if you already started it yourself, this script uses
# yours and leaves it alone. Ctrl+C stops what this script
# started. For the built, single-server site, keep using
# python -m api.app on :8000 as before.
set -u
export PATH="$HOME/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
REPO=/mnt/d/codes/tripgrid
DEV=$HOME/tripgrid-web

# 1. Mirror the frontend source onto the Linux filesystem —
#    npm and Vite are far happier here than on the Windows
#    drive. node_modules stays put between runs; the explicit
#    file list keeps the repo's Windows copy out of the way.
mkdir -p "$DEV"
for item in package.json package-lock.json tsconfig.json vite.config.ts index.html src; do
  cp -a "$REPO/web/$item" "$DEV/" 2>/dev/null
done
cd "$DEV"
npm install --no-audit --no-fund > /dev/null 2>&1

# 2. Keep mirroring while dev runs, so edits made in the repo
#    flow into the copy Vite is watching.
( while true; do
    cp -au "$REPO/web/src/." "$DEV/src/" 2>/dev/null
    cp -au "$REPO/web/index.html" "$DEV/index.html" 2>/dev/null
    cp -au "$REPO/web/vite.config.ts" "$DEV/vite.config.ts" 2>/dev/null
    sleep 1
  done ) &
MIRROR_PID=$!

# 3. API — only if one is not already answering.
STARTED_API=""
if ! curl -s -o /dev/null --max-time 2 localhost:8000/api/health; then
  ( cd "$REPO" && exec ~/venvs/tripgrid/bin/python -m api.app > ~/tripgrid-server.log 2>&1 ) &
  STARTED_API=$!
  echo "API started on http://localhost:8000"
else
  echo "API already running on http://localhost:8000 - using yours"
fi

cleanup() {
  kill $MIRROR_PID 2>/dev/null
  if [ -n "$STARTED_API" ]; then kill $STARTED_API 2>/dev/null; fi
}
trap cleanup EXIT INT TERM

echo "Dev site: http://localhost:5173  (Ctrl+C to stop)"
npm run dev
