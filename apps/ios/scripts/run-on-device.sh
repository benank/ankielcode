#!/bin/sh
# Builds the app, installs it on a paired iPhone and launches it.
# Usage: apps/ios/scripts/run-on-device.sh [Release|Debug]
# Env: TEAM (signing team), BUNDLE_ID (the app's id; one team owns each), RN_BUNDLE_ID (the React
# Native app signed by the same team, whose pairings the first launch imports), DEVICE (UDID;
# defaults to the first paired physical device). The defaults match the RN personal-team build.
set -eu
set -o pipefail

CFG="${1:-Release}"
TEAM="${TEAM:-AVK2MHX5CW}"
BUNDLE_ID="${BUNDLE_ID:-com.ankiel.ankielcode.personal.native}"
RN_BUNDLE_ID="${RN_BUNDLE_ID:-com.ankiel.ankielcode.personal}"
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$IOS_DIR/build"
mkdir -p "$BUILD_DIR"

if [ -z "${DEVICE:-}" ]; then
  xcrun devicectl list devices -j "$BUILD_DIR/devices.json" >/dev/null
  DEVICE="$(node -e 'const d=require(process.argv[1]).result.devices.find(x=>x.hardwareProperties?.reality==="physical"&&x.connectionProperties?.pairingState==="paired");if(d)console.log(d.hardwareProperties.udid)' "$BUILD_DIR/devices.json")"
  [ -n "$DEVICE" ] || { echo "No paired physical device found." >&2; exit 1; }
fi

for target in AnkielCode AnkielWidgets; do
  cp "$IOS_DIR/Config/$target.entitlements" "$BUILD_DIR/device-$target.entitlements"
done

build() {
  xcodebuild -project "$IOS_DIR/AnkielCode.xcodeproj" -scheme AnkielCode -configuration "$CFG" \
    -destination "platform=iOS,id=$DEVICE" -derivedDataPath "$BUILD_DIR" -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration DEVELOPMENT_TEAM="$TEAM" ANKIEL_BUNDLE_ID="$BUNDLE_ID" \
    ANKIEL_RN_BUNDLE_ID="$RN_BUNDLE_ID" CODE_SIGN_ENTITLEMENTS="$BUILD_DIR/device-\$(TARGET_NAME).entitlements" \
    build 2>&1 | tee "$BUILD_DIR/last-build.log"
}

strip() {
  for target in AnkielCode AnkielWidgets; do
    /usr/libexec/PlistBuddy -c "Delete :$1" "$BUILD_DIR/device-$target.entitlements" 2>/dev/null || true
  done
}

# xcodebuild cannot register an App Group, and personal teams have no push. Drop whichever the
# team refuses (only the usage widget's data and notifications are lost) and retry.
attempt=0
until build; do
  attempt=$((attempt + 1))
  stripped=""
  if grep -q "application-groups entitlement" "$BUILD_DIR/last-build.log"; then
    strip com.apple.security.application-groups
    stripped="the App Group (the usage widget shows no data)"
  fi
  if grep -q "Push Notifications" "$BUILD_DIR/last-build.log"; then
    strip aps-environment
    stripped="${stripped:+$stripped and }push notifications"
  fi
  [ -n "$stripped" ] && [ "$attempt" -lt 3 ] || exit 1
  echo "Team $TEAM refused $stripped; building without it." >&2
done

xcrun devicectl device install app --device "$DEVICE" "$BUILD_DIR/Build/Products/$CFG-iphoneos/AnkielCode.app"
xcrun devicectl device process launch --terminate-existing --device "$DEVICE" "$BUNDLE_ID"
