#!/bin/bash
# Double-click this file on a Mac to start memory blue.
cd "$(dirname "$0")" || exit 1

# Pick up Node installed through nvm, if that's how it was installed.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org and try again."
  read -r -p "Press Enter to close."
  exit 1
fi

PORT="${PORT:-3000}"

# Node keeps running the code it was started with, so an older memory blue that
# is still running would keep serving the old version. If one is listening on
# our port from this folder, stop it — and the `npm` / `node --watch` / `sh`
# that started it, which would otherwise start it again.
kill_if_ours() {
  local cmd first
  cmd=$(ps -o command= -p "$1" 2>/dev/null) || return 1
  first=$(basename "${cmd%% *}")
  case "$first" in node | npm | sh) ;; *) return 1 ;; esac
  case "$cmd" in
    *server.js* | *"npm start"* | *"npm run dev"* | *npm-cli.js*) kill "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

stop_old_server() {
  local pids pid cwd ppid depth
  pids=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null) || return 0
  for pid in $pids; do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
    [ "$cwd" = "$PWD" ] || [ "$(basename "$cwd")" = "memory blue" ] || [ "$(basename "$cwd")" = "memory-blue" ] || continue
    echo "Stopping the memory blue server that was already running (port $PORT)..."
    depth=0
    while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 5 ]; do
      ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
      kill_if_ours "$pid" || break
      pid=$ppid
      depth=$((depth + 1))
    done
  done
  # Give the port a moment to free up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break
    sleep 0.3
  done
}
stop_old_server

[ -d node_modules ] || npm install
# `dev` = auto-restart when server.js changes, so updates take effect without stopping and starting.
PORT="$PORT" npm run dev
