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
`Application Support/AnkielCode/shell/`, and credentials plus the DPoP key in the Keychain. Composer
drafts, the outbox of unsent messages and remembered model options live in
`Application Support/AnkielCode/composer/composer.json`, attachment copies beside it in `files/`.
Device preferences (theme, code text, follow-up default, project grouping, thread list options)
are one JSON value in `UserDefaults` under `ankiel.preferences.v1` (`ClientPreferences`; phase 4's
`threadList.*` keys are adopted once and removed). Server defaults are written to the computer
they belong to with `server.updateSettings` (`SettingsWriter`, optimistic with rollback).

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
| | `computers` | Settings on its Computers page. |
| | `settings`, `new-thread` | Home with Settings or the New thread sheet open. |
| | `settings-<page>` | Settings on a page: `general`, `appearance`, `chat`, `notifications`, `providers`, `threads`, `about`, `storage`, `diagnostics`, `computers`; with `ANKIEL_DEBUG_SETTINGS`, also `computer`, `computer-pairing`, `computer-off` (the fixture computers). |
| | `thread` | The first listed thread of the first computer, opened. |
| | `computer` | The first computer's detail page. |
| | `pairing-confirm`, `pairing-checking`, `pairing-exchanging`, `pairing-connecting`, `pairing-success` | The pairing sheet in that state (fake host). |
| | `pairing-expired`, `pairing-unreachable`, `pairing-incompatible`, `pairing-claims`, `pairing-clock`, `pairing-invalid` | The pairing sheet with that failure. |
| `ANKIEL_DEBUG_STATUS` | `reconnecting`, `offline`, `connecting`, `needs-pairing`, `incompatible`, `mismatch` | Every computer shows that connection status (display only; it stops following the real connection for that launch). Combine with `computers`, `computer` or no route (home, for the status indicator). |

| `ANKIEL_DEBUG_SETTINGS` | `fixture`, `fail`, `slow` | Three canned computers (connected, needs pairing, turned off) with their own folder, credential store and `UserDefaults` suite, a fake settings sink (`fail` refuses writes, `slow` never answers) and a fake release check offering 0.1.12. Removing, clearing and writing never reach the real saved computers or a server. |
| `ANKIEL_DEBUG_HOME` | `sample` | The thread list with canned rows across two fake computers (every status, a pin, a subagent, snoozed and settled shelves). Actions show; their commands fail as not connected. |
| | `empty` | The list's "No threads yet" state. |
| `ANKIEL_DEBUG_SEARCH` | a query | Home with that search typed. |
| `ANKIEL_DEBUG_THREAD` | `short`, `markdown`, `subagents`, `rich-markdown`, `pending`, `failed`, `kinds`, `replay`, `long`; pending requests: `approval-command`, `approval-file-change`, `approval-file-read`, `approval-permission`, `approval-mcp`, `approval-stale`, `approvals-queued`, `question-single`, `question-multi`, `question-text`, `question-other`, `question-steps`, `question-message`, `secret`, `secret-fields`, `requests-mixed`, `question-resolved` (a question the server resolves by event) | A thread from the bundled fixtures (`AnkielCode/Thread/Fixtures`, synthetic threads about a made-up project), run through the same decode, reduce and timeline path as a live stream. `replay` streams a turn in paced events; `long` repeats fixture turns to 500+ rows. No server needed; Release builds leave the fixtures out. |
| `ANKIEL_DEBUG_THREAD_EXPAND` | `folds`, `all` | Opens the fixture's run folds (and, with `all`, every work group and call) once it loads. |
| `ANKIEL_DEBUG_THREAD_SCROLL` | `top` | Opens the fixture scrolled to its first row (the scroll-to-latest button). |
| `ANKIEL_DEBUG_COMPOSER` | `fake`, `slow`, `fail`, `offline` | Composers send to a fake instead of a computer, with their own store (`composer-debug/`), so nothing reaches a real server. `fake` accepts after a short wait and shows the message in fixture threads (queued sends become a queued run); `slow` never answers; `fail` refuses; `offline` has no computer. Attachments named `*fail*` fail to upload, `*slow*` stall. New thread also lists a "Fixture Mac" with sample projects. |
| `ANKIEL_DEBUG_REQUESTS` | `readonly`, `elsewhere`, `expire` | With a request fixture: the session may not answer (read-only cards); or the first request is resolved on "another device" (or expires) 2.5 s after the thread loads. With `ANKIEL_DEBUG_COMPOSER`, answers go to the fake sink, which resolves the fixture's request like the server would (`fail` refuses, `slow` never answers). |
| `ANKIEL_DEBUG_COMPOSER_RESET` | `1` | Empties the fake composer store at launch (UI tests). |
| `ANKIEL_DEBUG_COMPOSER_PRESET` | `multiline`, `attachments`, `send`, `queued`, `failed`, `picker`, `keyboard` | With `ANKIEL_DEBUG_THREAD`: fills the fixture thread's composer, sends or queues a message, or opens the model sheet. |

Command encoding is checked twice: `CommandEncodingTests` compares the Swift encoders with
`Tests/AnkielKitTests/Fixtures/commands/*.json`, and `check-schemas.mjs` in that folder decodes the
same files with the server's Effect schemas (run it from `packages/contracts`:
`node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/commands/check-schemas.mjs`).
It also writes `provider-catalog.json` by encoding a sample through the real `ServerProvider` and
`ServerSettings` schemas.

The pending-request fixtures (`thread-approval-*`, `thread-question-*`, `thread-secret*`,
`thread-approvals-queued`, `thread-requests-mixed`) are written by
`Tests/AnkielKitTests/Fixtures/requests/make-request-fixtures.mjs` (run it from
`packages/contracts`), which decodes every stream item with the server's
`OrchestrationV2ThreadStreamItem` schema before writing it.

Thread fixtures are in the exact wire shape (checked against the TypeScript schemas and reducer;
`thread-reducer-golden.json` holds the TypeScript reducer's output the Swift reducer must match).
Their text was rewritten word by word into vocabulary about a made-up tide-chart project, with
digits remapped and ids and timestamps remapped consistently (golden included); markdown and
punctuation shape, item kinds, statuses, tool names and option labels are kept so the parser and
timeline see realistic structure. A test checks for the `"synthetic": true` marker and for home
paths, real emails and tokens.

UI tests (`AnkielCodeUITests`) run with `xcodebuild test … -only-testing:AnkielCodeUITests`.
`SampleListUITests`, `FixtureThreadUITests`, `ComposerUITests`, `RequestUITests` (fake sink) and `SettingsUITests` (settings fixture) need no server (`FixtureThreadUITests` includes a scroll
measurement on the 500-row fixture); `LiveListUITests` change real threads on the dev server at
`127.0.0.1:14527` and put each one back, and `LiveThreadUITests` open one; both skip when it is
not running. Set
`TEST_RUNNER_SHOTS_DIR=<dir>` to also save their screenshots there.

Deep links the app accepts (any `ankielcode[-channel]` scheme): `ankielcode-native://pair?pairingUrl=<urlencoded>`
and the RN dev form's `…://connections/new?pairingUrl=<urlencoded>&autoConnect=1`; and thread links
`ankielcode-native://thread/<environmentId>/<threadId>` (also the RN shape `…://threads/<environmentId>/<threadId>`). Release builds always ask
before pairing with a host from a link; Debug builds pair at once with `autoConnect=1`.
