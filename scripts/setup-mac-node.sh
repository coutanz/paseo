#!/usr/bin/env bash
set -euo pipefail

# Paseo Omni — macOS / Linux Node One-Click Setup (NetBird + Computer Use + Aqua GUI LaunchAgent)

PORT="${PASEO_PORT:-6767}"
BIND_ADDR="${PASEO_BIND_ADDR:-}"
CDP_ENDPOINT="${PASEO_CHROME_CDP_URL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Paseo Omni: macOS / Linux Node Setup ==="

detect_netbird_ip() {
  if command -v netbird >/dev/null 2>&1; then
    local nb_ip
    nb_ip="$(netbird status 2>/dev/null | grep -Eo '100\.[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
    if [[ -n "${nb_ip}" ]]; then
      echo "${nb_ip}"
      return
    fi
  fi
  echo "0.0.0.0"
}

if [[ -z "${BIND_ADDR}" ]]; then
  BIND_ADDR="$(detect_netbird_ip)"
fi
LISTEN_ENDPOINT="${BIND_ADDR}:${PORT}"
echo "[1/3] Detected Bind Endpoint: ${LISTEN_ENDPOINT}"

echo "[2/3] Synchronizing Computer Use & Browser Use MCP across Codex, Antigravity, ZCode, and DSH..."
if [[ -n "${CDP_ENDPOINT}" ]]; then
  node "${REPO_ROOT}/scripts/sync-computer-use-mcp.mjs" --cdp-endpoint "${CDP_ENDPOINT}" --no-windows-mcp
else
  node "${REPO_ROOT}/scripts/sync-computer-use-mcp.mjs" --no-windows-mcp
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[3/3] Creating macOS Aqua GUI LaunchAgent (~/Library/LaunchAgents/sh.paseo.omni.daemon.plist)..."
  PLIST_PATH="${HOME}/Library/LaunchAgents/sh.paseo.omni.daemon.plist"
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/.paseo"
  cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.paseo.omni.daemon</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PASEO_LISTEN</key>
    <string>${LISTEN_ENDPOINT}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npm</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
  echo "      Created ${PLIST_PATH} (Aqua session ensures Accessibility & Screen Recording permissions)."
else
  echo "[3/3] Ready to start with: PASEO_LISTEN=${LISTEN_ENDPOINT} npm run start"
fi

echo "=== Node Setup Complete! ==="
