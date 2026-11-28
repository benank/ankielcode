#!/usr/bin/env bash
# Mints a 15-minute pairing link on an isolated dev server and launches the native iOS app on one
# simulator with it, through the Debug-only ANKIEL_OPEN_URL hook (`simctl openurl` shows a system
# prompt nobody can tap).
set -euo pipefail

usage() {
  echo "Usage: $0 <simulator-udid> <server-port> <base-dir>" >&2
  exit 2
}

[[ $# -eq 3 ]] || usage
udid="$1"
server_port="$2"
base_dir="$3"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! pairing_output="$(
  ANKIEL_PORT="$server_port" node apps/server/src/bin.ts auth pairing create \
    --base-dir "$base_dir" \
    --base-url "http://127.0.0.1:$server_port" \
    --ttl 15m \
    --label "agent-ios" 2>&1
)"; then
  echo "Could not mint a pairing link: $pairing_output" >&2
  exit 1
fi

pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -n 1)"
if [[ -z "$pairing_url" ]]; then
  echo "Could not parse the pairing URL from: $pairing_output" >&2
  exit 1
fi

deep_link="$(PAIRING_URL="$pairing_url" node -e \
  'process.stdout.write(`ankielcode-native://pair?${new URLSearchParams({ pairingUrl: process.env.PAIRING_URL })}`)')"

SIMCTL_CHILD_ANKIEL_OPEN_URL="$deep_link" \
  xcrun simctl launch --terminate-running-process "$udid" com.ankiel.ankielcode.native >/dev/null
echo "Launched com.ankiel.ankielcode.native on $udid with a fresh pairing link for port $server_port."
