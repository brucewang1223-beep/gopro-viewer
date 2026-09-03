#!/usr/bin/env bash
# Start the GoPro Viewer server automatically at login (macOS launchd user agent).
#
#   scripts/macos-launch-agent.sh install     write ~/Library/LaunchAgents/com.gopro-viewer.plist and start the server
#   scripts/macos-launch-agent.sh uninstall   stop the server and remove the agent
#   scripts/macos-launch-agent.sh status      agent state + /api/health
#
# The agent runs `node server/index.js` in this project directory, restarts it if it crashes,
# and appends its output to .cache/server.log. Port/roots come from config.json as usual.
set -euo pipefail

LABEL="com.gopro-viewer"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOG="$PROJECT_DIR/.cache/server.log"
PORT="$(node -p 'try { require(process.argv[1]).port ?? 8790 } catch { 8790 }' "$PROJECT_DIR/config.json" 2>/dev/null || echo 8790)"

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/.cache"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}

install() {
  [ -x "$NODE_BIN" ] || { echo "node not found (set NODE_BIN=/path/to/node)"; exit 1; }
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  write_plist
  launchctl bootstrap "$DOMAIN" "$PLIST"
  sleep 2
  echo "installed $PLIST (node: $NODE_BIN)"
  status
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
}

status() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "agent: loaded (pid $(launchctl print "$DOMAIN/$LABEL" | awk '/pid = /{print $3; exit}'))"
  else
    echo "agent: not loaded"
  fi
  curl -sf "http://127.0.0.1:$PORT/api/health" && echo || echo "server: not answering on port $PORT (see $LOG)"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
esac
