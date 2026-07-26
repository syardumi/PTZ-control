#!/bin/bash
# Double-click this file in Finder to start the Move SE control panel —
# or run it from Terminal with: ./start.command
#
# First time only: Finder may warn that this is "from an unidentified
# developer." Right-click the file and choose Open (instead of double-
# clicking) to get past that, or open Terminal, cd into this folder, and
# run: bash start.command — that bypasses the warning entirely.
#
# This window doubles as the server's log. Closing it (or Ctrl+C) stops
# the camera control panel.

set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4790}"

echo "Move SE control panel"
echo "----------------------"
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
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required (found $(node --version))."
  echo "Upgrade from https://nodejs.org or with: brew upgrade node"
  pause_and_exit
fi

# --- ffmpeg is optional — smoother live preview if it's there ----------
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Note: ffmpeg isn't installed, so the live preview will use the"
  echo "slower snapshot mode. For smooth video: brew install ffmpeg"
  echo
fi

# --- Already running? Just open the browser instead of double-starting -
if lsof -i tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Already running at http://localhost:$PORT — opening your browser."
  open "http://localhost:$PORT"
  exit 0
fi

# --- First run: install dependencies -------------------------------------
if [ ! -d node_modules ]; then
  echo "Setting up (first run only, needs internet access)..."
  if ! npm install; then
    echo
    echo "npm install failed — see the errors above."
    pause_and_exit
  fi
  echo
fi

# --- Open the browser automatically once the server responds ------------
(
  for _ in $(seq 1 40); do
    sleep 0.5
    if curl -s -o /dev/null "http://localhost:$PORT"; then
      open "http://localhost:$PORT"
      break
    fi
  done
) &

echo "Starting the server — leave this window open while you use the camera panel."
echo "Close this window (or press Ctrl+C) to stop it."
echo
PORT="$PORT" npm start
