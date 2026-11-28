#!/bin/sh
# Builds the app, installs it on a paired iPhone and launches it.
# Usage: apps/ios/scripts/run-on-device.sh [Release|Debug]
# Env: TEAM (signing team id), DEVICE (UDID; defaults to the first paired physical device).
set -eu
set -o pipefail

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

build() {
  xcodebuild -project "$IOS_DIR/AnkielCode.xcodeproj" -scheme AnkielCode -configuration "$CFG" \
    -destination "platform=iOS,id=$DEVICE" -derivedDataPath "$BUILD_DIR" -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration DEVELOPMENT_TEAM="$TEAM" "$@" build 2>&1 | tee "$BUILD_DIR/last-build.log"
}

# xcodebuild cannot register an App Group; until the team has one (Xcode's Signing & Capabilities),
# sign without it. Only the usage widget's data needs the group.
if ! build; then
  grep -q "application-groups entitlement" "$BUILD_DIR/last-build.log" || exit 1
  echo "App Group not registered for team $TEAM; building without it (the widget shows no data)." >&2
  for target in AnkielCode AnkielWidgets; do
    cp "$IOS_DIR/Config/$target.entitlements" "$BUILD_DIR/no-group-$target.entitlements"
    /usr/libexec/PlistBuddy -c "Delete :com.apple.security.application-groups" "$BUILD_DIR/no-group-$target.entitlements"
  done
  build CODE_SIGN_ENTITLEMENTS="$BUILD_DIR/no-group-\$(TARGET_NAME).entitlements"
fi
xcrun devicectl device install app --device "$DEVICE" "$BUILD_DIR/Build/Products/$CFG-iphoneos/AnkielCode.app"
xcrun devicectl device process launch --terminate-existing --device "$DEVICE" com.ankiel.ankielcode.native
