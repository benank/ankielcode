# Ankiel Code for iOS (native)

A SwiftUI client for Ankiel Code servers. iOS 26+, Swift 6, no third-party dependencies.
Bundle id `com.ankiel.code.native` and URL scheme `ankielcode-native`, so it installs next to the
React Native app in `apps/mobile`.

- `AnkielCode/`: the app (SwiftUI views, design system). The folder is a synchronized group, so new
  files join the target without editing the project.
- `Packages/AnkielKit/`: the wire protocol, auth (pairing, DPoP, Keychain), the RPC client, the
  shell reducer, and the connection runtime (`Connection/`: one supervisor per saved environment,
  routes, shell sync and cache, the registry). Pure Swift, tested with `swift test` on the Mac.

Saved environments live in `Application Support/AnkielCode/environments.json`, their last shell in
`Application Support/AnkielCode/shell/`, and credentials plus the DPoP key in the Keychain.

## Build

```sh
xcodebuild -project apps/ios/AnkielCode.xcodeproj -scheme AnkielCode \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath apps/ios/build build
```

Or open `AnkielCode.xcodeproj` in Xcode and run the `AnkielCode` scheme.

## Test

```sh
cd apps/ios/Packages/AnkielKit && swift test
```

## Live check against a server

`ankiel-probe` pairs, connects, starts a session, reads the shell and prints a summary. Use the
server port (not the web port) of an isolated dev server, and mint a link with
`node apps/server/src/bin.ts auth pairing create --base-dir <worktree>/.ankiel --base-url http://127.0.0.1:<port>`.

```sh
cd apps/ios/Packages/AnkielKit
swift run ankiel-probe --pair-url 'http://127.0.0.1:<port>/pair#token=<CODE>' --state /tmp/probe.json
swift run ankiel-probe --state /tmp/probe.json --trace   # reuse the saved credential
```

`--supervise` runs the app's registry against the server without touching the server: connect, a
foreground probe that must not reconnect, an in-place token renewal, a dropped socket that must
resume the shell from its cursor, and a cold start from the cache whose cursor is rewound to force
`snapshot-required` and the HTTP snapshot fallback. `--stale-resume` shows the server's raw answer
to an unreplayable resume.

```sh
swift run ankiel-probe --state /tmp/probe.json --supervise
swift run ankiel-probe --state /tmp/probe.json --stale-resume
```

## Debug hooks (Debug builds only)

Pass these as launch environment variables, e.g.
`SIMCTL_CHILD_ANKIEL_DEBUG_ROUTE=onboarding xcrun simctl launch --terminate-running-process <sim> com.ankiel.code.native`.
None of them forget saved environments or credentials.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_OPEN_URL` | a deep link | Opens it at launch without the system "Open in app?" prompt (`simctl openurl` shows that prompt and nobody can tap it). A pairing link opened this way pairs at once instead of asking to confirm. |
| `ANKIEL_DEBUG_ROUTE` | `onboarding` | The welcome screen. |
| | `onboarding-help` | Welcome with "How do I get a pairing link?" open. |
| | `pairing-link` | The paste or enter-address form. |
| | `scanner` | The QR scanner (on the simulator: its no-camera state). |
| | `computers` | Home with the Computers sheet open. |
| | `settings`, `new-thread` | Home with the Settings or New thread placeholder sheet open. |
| | `thread` | The first listed thread of the first computer, opened. |
| | `computer` | The first computer's detail page. |
| | `pairing-confirm`, `pairing-checking`, `pairing-exchanging`, `pairing-connecting`, `pairing-success` | The pairing sheet in that state (fake host). |
| | `pairing-expired`, `pairing-unreachable`, `pairing-incompatible`, `pairing-claims`, `pairing-clock`, `pairing-invalid` | The pairing sheet with that failure. |
| `ANKIEL_DEBUG_STATUS` | `reconnecting`, `offline`, `connecting`, `needs-pairing`, `incompatible`, `mismatch` | Every computer shows that connection status (display only; it stops following the real connection for that launch). Combine with `computers`, `computer` or no route (home, for the status indicator). |

| `ANKIEL_DEBUG_HOME` | `sample` | The thread list with canned rows across two fake computers (every status, a pin, a subagent, snoozed and settled shelves). Actions show; their commands fail as not connected. |
| | `empty` | The list's "No threads yet" state. |
| `ANKIEL_DEBUG_SEARCH` | a query | Home with that search typed. |

UI tests (`AnkielCodeUITests`) run with `xcodebuild test … -only-testing:AnkielCodeUITests`.
`SampleListUITests` need no server; `LiveListUITests` change real threads on the dev server at
`127.0.0.1:14527` and put each one back, and skip when it is not running. Set
`TEST_RUNNER_SHOTS_DIR=<dir>` to also save their screenshots there.

Deep links the app accepts (any `ankielcode[-channel]` scheme): `ankielcode-native://pair?pairingUrl=<urlencoded>`
and the RN dev form's `…://connections/new?pairingUrl=<urlencoded>&autoConnect=1`; and thread links
`ankielcode-native://thread/<environmentId>/<threadId>` (also the RN shape `…://threads/<environmentId>/<threadId>`). Release builds always ask
before pairing with a host from a link; Debug builds pair at once with `autoConnect=1`.
