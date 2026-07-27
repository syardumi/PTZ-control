#!/bin/bash
# Double-click this file in Finder to start the PTZ client UI and open it
# in your browser — or run it from Terminal with: ./start.command
#
# First time only: Finder may warn that this is "from an unidentified
# developer." Right-click the file and choose Open (instead of double-
# clicking) to get past that, or open Terminal, cd into this folder, and
# run: bash start.command — that bypasses the warning entirely.
#
# This window doubles as the client's log. Closing it (or Ctrl+C) stops
# it. Make sure the PTZ server is already running (see server/start.command
# in the sibling folder) — the client's Settings needs its address.

set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4791}"

echo "PTZ client"
echo "-----------"
echo

pause_and_exit() {
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed."
  echo "Install it from https://nodejs.org (or run: brew install node),"
  echo "then double-click this script again."
  osascript -e 'display alert "Node.js required" message "Install Node.js from nodejs.org (or run: brew install node), then double-click this script again." as critical' >/dev/null 2>&1
  pause_and_exit
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

# --- Open the browser automatically once the client responds ------------
(
  for _ in $(seq 1 40); do
    sleep 0.5
    if curl -s -o /dev/null "http://localhost:$PORT"; then
      open "http://localhost:$PORT"
      break
    fi
  done
) &

echo "Starting the client on port $PORT — leave this window open."
echo "Close this window (or press Ctrl+C) to stop it."
echo
PORT="$PORT" npm start
