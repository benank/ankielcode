#!/bin/sh
# Builds the app, installs it on a paired iPhone and launches it.
# Usage: apps/ios/scripts/run-on-device.sh [Release|Debug]
# Env: TEAM (signing team id), DEVICE (UDID; defaults to the first paired physical device).
set -eu

CFG="${1:-Release}"
TEAM="${TEAM:-268225YYS4}"
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$IOS_DIR/build"
mkdir -p "$BUILD_DIR"

if [ -z "${DEVICE:-}" ]; then
  xcrun devicectl list devices -j "$BUILD_DIR/devices.json" >/dev/null
  DEVICE="$(node -e 'const d=require(process.argv[1]).result.devices.find(x=>x.hardwareProperties?.reality==="physical"&&x.connectionProperties?.pairingState==="paired");if(d)console.log(d.hardwareProperties.udid)' "$BUILD_DIR/devices.json")"
  [ -n "$DEVICE" ] || { echo "No paired physical device found." >&2; exit 1; }
fi

xcodebuild -project "$IOS_DIR/AnkielCode.xcodeproj" -scheme AnkielCode -configuration "$CFG" \
  -destination "platform=iOS,id=$DEVICE" -derivedDataPath "$BUILD_DIR" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" build
xcrun devicectl device install app --device "$DEVICE" "$BUILD_DIR/Build/Products/$CFG-iphoneos/AnkielCode.app"
xcrun devicectl device process launch --terminate-existing --device "$DEVICE" com.ankiel.code.native
