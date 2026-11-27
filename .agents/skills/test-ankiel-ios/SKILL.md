---
name: test-ankiel-ios
description: Build, run and test the native SwiftUI iOS app (apps/ios) on an iOS simulator against fixtures or an isolated dev server. Use for apps/ios changes, AnkielKit Swift tests, iOS UI tests, screenshots and translations. Use test-ankiel-mobile for the React Native app.
---

# Test Ankiel iOS (native)

Everything runs from the repository root on a Mac with Xcode. `apps/ios/README.md` lists every
debug hook; this page is the loop.

## Rules

- Use one simulator, by UDID. Pick it once (`xcrun simctl list devices available`), boot it if
  needed (`xcrun simctl boot <udid>`), and shut down only one you booted. Never erase a simulator
  or use `booted` as the target: other sessions may have one open.
- Never kill processes by name or pattern. Never start a server against `~/.ankiel/userdata`;
  reuse this task's dev server (`vp run dev`, isolated `.ankiel` state) or test on fixtures.
- Use your own derived data and SwiftPM scratch paths (`build-*` is gitignored) so parallel
  sessions do not share build products, and delete them when done.
- Look at every screenshot you take (Read the PNG) before calling a screen done.

## Build, install, launch

```bash
SIM=<udid>; DD=apps/ios/build-<task>
xcodebuild -project apps/ios/AnkielCode.xcodeproj -scheme AnkielCode \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath $DD build 2>&1 | grep -E "error|warning: |BUILD"
xcrun simctl install $SIM $DD/Build/Products/Debug-iphonesimulator/AnkielCode.app
SIMCTL_CHILD_ANKIEL_DEBUG_SETTINGS=fixture SIMCTL_CHILD_ANKIEL_DEBUG_HOME=sample \
  xcrun simctl launch --terminate-running-process $SIM com.ankiel.code.native
xcrun simctl io $SIM screenshot /tmp/<task>/home.png
```

Debug builds read `ANKIEL_DEBUG_*` launch variables (pass them as `SIMCTL_CHILD_<name>`): canned
computers and settings, a sample thread list, thread fixtures (`ANKIEL_DEBUG_THREAD=markdown`,
`approval-command`, …), a fake composer sink and a route to open (`ANKIEL_DEBUG_ROUTE=settings`,
`thread`, …). They need no server and never touch saved computers. There is no tap tool: reach a
screen with a route or a UI test. `xcrun simctl ui $SIM appearance dark|light` switches appearance.

Another language: append `-AppleLanguages "(de)" -AppleLocale de_DE` to `simctl launch` (`ja`,
`zh-Hans`, … — the app ships the RN app's 10 locales).

## Against a live server

```bash
.agents/skills/test-ankiel-ios/scripts/pair-sim.sh $SIM <server-port> "$PWD/.ankiel"
```

It mints a single-use link on the dev server and launches the app with it through
`ANKIEL_OPEN_URL` (do not use `simctl openurl`: its confirmation prompt cannot be tapped). The
app pairs, stores the credential in the simulator's Keychain and reconnects on later launches.
For a wire change without UI, `swift run ankiel-probe` in `apps/ios/Packages/AnkielKit` pairs and
reads the shell from the command line (see the README).

## Tests

```bash
swift test --package-path apps/ios/Packages/AnkielKit --scratch-path /tmp/<task>-kit
xcodebuild test -project apps/ios/AnkielCode.xcodeproj -scheme AnkielCode \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath $DD \
  -only-testing:AnkielCodeUITests/SettingsUITests/testSearchFindsASettingOnItsPage
```

Run the UI test classes your change touches, not the whole target. Most run on fixtures;
`LiveListUITests` and `LiveThreadUITests` need the dev server and skip without it. Set
`TEST_RUNNER_SHOTS_DIR=<dir>` to keep their screenshots.

`vp run check:changed` runs `swift test` when AnkielKit changed, the wire-schema fixture check
when its fixtures or `packages/contracts` changed, and the translation check when app sources
changed. CI builds none of this.

## Strings

New `Text("…")` / `String(localized:)` keys reach `Localizable.xcstrings` only from the Xcode
editor. After an `xcodebuild`, run
`node apps/ios/scripts/import-translations.mjs --sync $DD` to add them, fill translations from
the RN catalogs and `apps/ios/scripts/manual-translations.json`, then
`node apps/ios/scripts/check-translations.mjs --build $DD`. A key with no RN match needs entries
in `manual-translations.json` for all 9 locales (they land as `needs_review`).
