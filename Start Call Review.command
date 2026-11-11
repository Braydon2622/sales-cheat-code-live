#!/bin/bash
# Double-click in Finder to start the Call Review app and open it in your browser.
# Keep the Terminal window that opens; closing it (or Ctrl+C) stops the app.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/node/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node isn't installed where expected (~/.local/node). Ask Claude to fix it."
  read -r -p "Press Enter to close."
  exit 1
fi
[ -d node_modules ] || npm install
(sleep 4; open "http://127.0.0.1:4310") &
npm run app
