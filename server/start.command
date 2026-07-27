#!/bin/bash
# Double-click this file in Finder to start the PTZ camera server — or run
# it from Terminal with: ./start.command
#
# First time only: Finder may warn that this is "from an unidentified
# developer." Right-click the file and choose Open (instead of double-
# clicking) to get past that, or open Terminal, cd into this folder, and
# run: bash start.command — that bypasses the warning entirely.
#
# This window doubles as the server's log. Closing it (or Ctrl+C) stops
# it. The server has no UI of its own — open the client app (or its
# start.command) separately to control the camera.

set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4790}"

echo "PTZ camera server"
echo "------------------"
echo

pause_and_exit() {
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit 1
}

# --- Node.js present, and new enough for the built-in fetch() we use ----
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed."
  echo "Install it from https://nodejs.org (or run: brew install node),"
  echo "then double-click this script again."
  osascript -e 'display alert "Node.js required" message "Install Node.js from nodejs.org (or run: brew install node), then double-click this script again." as critical' >/dev/null 2>&1
  pause_and_exit
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node.js 24 or newer is required (found $(node --version))."
  echo "Node 24 is the current LTS release. Upgrade from https://nodejs.org"
  echo "or with: brew upgrade node"
  pause_and_exit
fi

# --- Already running? Nothing more to do --------------------------------
if lsof -i tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Already running at http://localhost:$PORT"
  exit 0
fi

# --- First run: install dependencies (includes a bundled ffmpeg, ~40-70MB) -
if [ ! -d node_modules ]; then
  echo "Setting up (first run only, needs internet access — this also"
  echo "downloads a bundled copy of ffmpeg for the live preview, ~40-70MB)..."
  if ! npm install; then
    echo
    echo "npm install failed — see the errors above."
    pause_and_exit
  fi
  echo
fi

echo "Starting the server on port $PORT — leave this window open."
echo "Close this window (or press Ctrl+C) to stop it."
echo
PORT="$PORT" npm start
