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
are one JSON value in `UserDefaults` under `ankiel.preferences.v1` (`ClientPreferences`). Server defaults are written to the computer
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

`vp run check:changed` runs these tests on macOS when AnkielKit changed, and the wire-schema check
below when its fixtures or `packages/contracts` changed. The `test-ankiel-ios` agent skill
(`.agents/skills/test-ankiel-ios`) covers simulators, pairing and UI tests.

## Translations

`Localizable.xcstrings` ships the React Native app's 10 locales; iOS offers the per-app language in
the system Settings app (General → Language in the app links there). `xcodebuild` extracts new keys
but never writes them to the catalog, so after adding strings:

```sh
node apps/ios/scripts/import-translations.mjs --sync <derived-data>   # add/drop keys, fill translations
node apps/ios/scripts/check-translations.mjs --build <derived-data>
```

The import copies a translation when the English matches a string in
`apps/mobile/src/i18n/translations` (placeholders and trailing punctuation normalized, plurals
kept) and otherwise takes it from `scripts/manual-translations.json`, marked `needs_review`. It only
fills missing units. Add a key with no RN match to that file for all 9 locales, reusing the RN
terms ("Thread", "Kopplung", …). `vp run i18n:check` runs the check; debug-only strings (comment
starting `debug`) are not translated.

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

`--live <mode>` proves the app's wire paths against a dev server with the free `Replay (dev)`
provider, through the same registry, thread sync, composer store, request controller and settings
writer the app uses. Modes that write create their own threads in an `ankiel-probe live` project
(a folder under `/tmp/ankiel-live`) and delete them; `--live cleanup` removes the project. Each run
exits after `--limit <seconds>` (default 240).

| Mode | Proves |
| --- | --- |
| `threads` | Every shell thread's snapshot, raw versus decoded (item kinds, unknown kinds, timeline rows, frame parts). |
| `list --title <seeded title>` | Each list action and its undo, read back from the shell, then search and an older-settled page. |
| `turn`, `undo`, `interrupt` | A launched Replay turn streamed and compared with a cold snapshot (approval, acks, launch retry); settle undo restoring a manual position; stop, and the server's reply to a client `Interrupt`. |
| `requests` | A question answered, an approval declined through the composer path, one answered from another session. |
| `composer` | Uploads and launch, a dropped reply resent with the same command id, settings before a message, steer and queue, queued edit and removal, an offline send. |
| `detail` | Scopes, the reopen cache, subagent threads, a 401 at the upgrade, command output on expand, a socket drop mid-stream. |
| `settings`, `repair --link-a <url> --link-b <url>`, `release` | Server settings writes and a refused write; re-pairing at the saved and a new address; the update check. |

## Debug hooks (Debug builds only)

Pass these as launch environment variables, e.g.
`SIMCTL_CHILD_ANKIEL_DEBUG_ROUTE=onboarding xcrun simctl launch --terminate-running-process <sim> com.ankiel.code.native`.
None of them forget saved environments or credentials.

| Variable                       | Values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shows                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANKIEL_OPEN_URL`              | a deep link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Opens it at launch without the system "Open in app?" prompt (`simctl openurl` shows that prompt and nobody can tap it). A pairing link opened this way pairs at once instead of asking to confirm.                                                                                                                                                                                                                                 |
| `ANKIEL_DEBUG_ROUTE`           | `onboarding`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The welcome screen.                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                | `onboarding-help`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Welcome with "How do I get a pairing link?" open.                                                                                                                                                                                                                                                                                                                                                                                  |
|                                | `pairing-link`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The paste or enter-address form.                                                                                                                                                                                                                                                                                                                                                                                                   |
|                                | `scanner`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The QR scanner (on the simulator: its no-camera state).                                                                                                                                                                                                                                                                                                                                                                            |
|                                | `computers`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Settings on its Computers page.                                                                                                                                                                                                                                                                                                                                                                                                    |
|                                | `settings`, `new-thread`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Home with Settings or the New thread sheet open.                                                                                                                                                                                                                                                                                                                                                                                   |
|                                | `settings-<page>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Settings on a page: `general`, `appearance`, `chat`, `notifications`, `providers`, `threads`, `about`, `storage`, `diagnostics`, `computers`; with `ANKIEL_DEBUG_SETTINGS`, also `computer`, `computer-pairing`, `computer-off` (the fixture computers).                                                                                                                                                                           |
|                                | `thread`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The first listed thread of the first computer, opened.                                                                                                                                                                                                                                                                                                                                                                             |
|                                | `computer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The first computer's detail page.                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                | `pairing-confirm`, `pairing-checking`, `pairing-exchanging`, `pairing-connecting`, `pairing-success`                                                                                                                                                                                                                                                                                                                                                                                         | The pairing sheet in that state (fake host).                                                                                                                                                                                                                                                                                                                                                                                       |
|                                | `pairing-expired`, `pairing-unreachable`, `pairing-incompatible`, `pairing-claims`, `pairing-clock`, `pairing-invalid`                                                                                                                                                                                                                                                                                                                                                                       | The pairing sheet with that failure.                                                                                                                                                                                                                                                                                                                                                                                               |
| `ANKIEL_DEBUG_STATUS`          | `reconnecting`, `offline`, `connecting`, `needs-pairing`, `incompatible`, `mismatch`                                                                                                                                                                                                                                                                                                                                                                                                         | Every computer shows that connection status (display only; it stops following the real connection for that launch). Combine with `computers`, `computer` or no route (home, for the status indicator).                                                                                                                                                                                                                             |
| `ANKIEL_DEBUG_SETTINGS`        | `fixture`, `fail`, `slow`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Three canned computers (connected, needs pairing, turned off) with their own folder, credential store and `UserDefaults` suite, a fake settings sink (`fail` refuses writes, `slow` never answers) and a fake release check offering 0.1.12. Removing, clearing and writing never reach the real saved computers or a server.                                                                                                      |
| `ANKIEL_DEBUG_SETTINGS_KEEP`   | `1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | With `ANKIEL_DEBUG_SETTINGS`: keeps the fixture's preferences from the last launch instead of resetting them (cold-launch theme checks).                                                                                                                                                                                                                                                                                           |
| `ANKIEL_DEBUG_HOME`            | `sample`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The thread list with canned rows across two fake computers (every status, a pin, a subagent, snoozed and settled shelves). Actions show; their commands fail as not connected.                                                                                                                                                                                                                                                     |
|                                | `empty`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The list's "No threads yet" state.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ANKIEL_DEBUG_SEARCH`          | a query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Home with that search typed.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ANKIEL_DEBUG_THREAD`          | `short`, `markdown`, `subagents`, `rich-markdown`, `pending`, `failed`, `kinds`, `replay`, `long`; pending requests: `approval-command`, `approval-file-change`, `approval-file-read`, `approval-permission`, `approval-mcp`, `approval-stale`, `approvals-queued`, `question-single`, `question-multi`, `question-text`, `question-other`, `question-steps`, `question-message`, `secret`, `secret-fields`, `requests-mixed`, `question-resolved` (a question the server resolves by event) | A thread from the bundled fixtures (`AnkielCode/Thread/Fixtures`, synthetic threads about a made-up project), run through the same decode, reduce and timeline path as a live stream. `replay` streams a turn in paced events; `long` repeats fixture turns to 500+ rows. No server needed; Release builds leave the fixtures out.                                                                                                 |
| `ANKIEL_DEBUG_THREAD_EXPAND`   | `folds`, `all`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Opens the fixture's run folds (and, with `all`, every work group and call) once it loads.                                                                                                                                                                                                                                                                                                                                          |
| `ANKIEL_DEBUG_THREAD_SCROLL`   | `top`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Opens the fixture scrolled to its first row (the scroll-to-latest button).                                                                                                                                                                                                                                                                                                                                                         |
| `ANKIEL_DEBUG_THREAD_DELAY`    | seconds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Opens the fixture that long after launch, pushed over the list like a tap (transition checks).                                                                                                                                                                                                                                                                                                                                     |
| `ANKIEL_DEBUG_COMPOSER`        | `fake`, `slow`, `fail`, `offline`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Composers send to a fake instead of a computer, with their own store (`composer-debug/`), so nothing reaches a real server. `fake` accepts after a short wait and shows the message in fixture threads (queued sends become a queued run); `slow` never answers; `fail` refuses; `offline` has no computer. Attachments named `*fail*` fail to upload, `*slow*` stall. New thread also lists a "Fixture Mac" with sample projects. |
| `ANKIEL_DEBUG_REQUESTS`        | `readonly`, `elsewhere`, `expire`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | With a request fixture: the session may not answer (read-only cards); or the first request is resolved on "another device" (or expires) 2.5 s after the thread loads. With `ANKIEL_DEBUG_COMPOSER`, answers go to the fake sink, which resolves the fixture's request like the server would (`fail` refuses, `slow` never answers).                                                                                                |
| `ANKIEL_DEBUG_COMPOSER_RESET`  | `1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Empties the fake composer store at launch (UI tests).                                                                                                                                                                                                                                                                                                                                                                              |
| `ANKIEL_DEBUG_COMPOSER_PRESET` | `multiline`, `attachments`, `send`, `queued`, `failed`, `picker`, `keyboard`                                                                                                                                                                                                                                                                                                                                                                                                                 | With `ANKIEL_DEBUG_THREAD`: fills the fixture thread's composer, sends or queues a message, or opens the model sheet.                                                                                                                                                                                                                                                                                                              |

Command encoding is checked twice: `CommandEncodingTests` compares the Swift encoders with
`Tests/AnkielKitTests/Fixtures/commands/*.json`, and `check-schemas.mjs` in that folder decodes the
same files with the server's Effect schemas (run it from `packages/contracts`:
`node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/commands/check-schemas.mjs`).
It also writes `provider-catalog.json` by encoding a sample through the real `ServerProvider` and
`ServerSettings` schemas.

Thread fixtures (`AnkielCode/Thread/Fixtures`) are invented conversations about a made-up
tide-chart app, written by `Tests/AnkielKitTests/Fixtures/threads/make-thread-fixtures.mjs` (run it
from `packages/contracts`). It builds every thread from short item specs with a shared builder,
decodes each stream item with the server's `OrchestrationV2ThreadStreamItem` schema, and writes
`thread-reducer-golden.json` from the TypeScript reducer, which the Swift reducer must match. The
app shifts fixture timestamps to the present when it loads them. A test checks for the
`"synthetic": true` marker and for home paths, real emails and tokens.

UI tests (`AnkielCodeUITests`) run with `xcodebuild test … -only-testing:AnkielCodeUITests`. All but
`LiveListUITests` and `LiveThreadUITests` run on fixtures and fake sinks; those two use the dev
server at `127.0.0.1:14527` (putting back what they change) and skip when it is down.
`SplitLayoutUITests` runs only on an iPad simulator. `AccessibilityAuditUITests` runs
`performAccessibilityAudit()` over the main screens. `FixtureThreadUITests` measures scrolling on
the 500-row fixture. Set `TEST_RUNNER_SHOTS_DIR=<dir>` to also save screenshots there.

Deep links the app accepts (any `ankielcode[-channel]` scheme): `ankielcode-native://pair?pairingUrl=<urlencoded>`
and the RN dev form's `…://connections/new?pairingUrl=<urlencoded>&autoConnect=1`; and thread links
`ankielcode-native://thread/<environmentId>/<threadId>` (also the RN shape `…://threads/<environmentId>/<threadId>`). Release builds always ask
before pairing with a host from a link; Debug builds pair at once with `autoConnect=1`.

## Files and media

A thread's menu has **Files**: the workspace (the thread's worktree, else its project's root) as a
lazily listed tree (`projects.listEntries`), searchable by path (`projects.searchEntries`). Files open
by kind: text through `projects.readFile` (1 MiB, then a "Partial file" notice and Quick Look) in
`SourceTextView` (line numbers, the in-house highlighter, the code font and word-wrap preferences,
find); markdown rendered with a Preview/Source switch; images zoomable; video and audio streamed
with AVKit; PDFs in PDFKit; binary and everything else downloaded (`media-file` or
`draft-workspace-file` with `disposition: "attachment"`) for Quick Look. Feed entry points: image
thumbnails and markdown images open the gallery (`ImageViewer`, zoom transition from the thumbnail,
pinch and double-tap zoom, swipe between the thread's images, drag down to close, Share, Save to
Photos, Copy); file chips open attachments; work-row file paths, read rows and markdown links to
paths (`src/a.ts:12`, `file://…`) open the file; expanded tool rows show the tool's images
(`tool-output-image`, read from `orchestration.getTurnItem`). Originals are cached on disk in
`Caches/AnkielCode/media` (256 MB, oldest first), keyed by environment and resource, plus the
server's `fileRevision` for `media-file` (attachments and tool images never change; `workspace-file`
URLs carry no revision, so those fall back to the signed URL). New-thread's toolbar has **Files**
for the chosen project (`draft-workspace-file`). Everything is hidden without `filesystem:read`.

`ankiel-probe --files <cwd>` runs the same reads against a server: list, `--search <q>`, `--read
<path>` (repeatable; text, binary, folder, with the error's `failure`), and with `--thread <id>`
`--stat <path>` (`filesystem.getMetadata`), counts a `--tool-item <itemId>`'s images from
`orchestration.getTurnItem` and signs and downloads them, `--image <path>` and `--download <path>`:

```sh
swift run ankiel-probe --state /tmp/probe.json --files /path/to/checkout --read package.json \
  --thread <threadId> --image docs/shot.png --download pnpm-lock.yaml
```

Debug hook (with `ANKIEL_DEBUG_ROUTE=thread` or an `ANKIEL_OPEN_URL` thread link):

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_FILES` | `browser` | The file browser. |
| | `search:<query>` | The browser with that search typed. |
| | `file:<path>[:line]` | A file in the viewer (relative to the workspace, or absolute), scrolled to the line. |
| | `gallery` | The gallery at the thread's first image. |
| | `images:<path>,<path>` | A gallery of workspace images, loaded live. |

`MediaFilesUITests` (live, skips when the dev server is down) opens Files from the thread menu,
lists a folder, searches and opens a file, and zooms, swipes, closes and drags the gallery closed.

## Review and git (Debug builds)

Review (`AnkielCode/Review`, logic in `AnkielKit/Review`) reads turn diffs (`orchestration.getTurnDiff`),
the checkout's comparisons (`review.getDiffPreview`, tracked-only first, then the completion read;
truncated comparisons read each file's patch on open) and file contents for unchanged lines
(`review.getDiffFileContents`, git sections only, refused when the contents no longer reproduce the
patch). Git state is `vcs.refreshStatus`; actions are `git.runStackedAction` (a progress stream) and
`vcs.pull`. The diff is a lazy SwiftUI stack, one `Text` per line.

| Variable                      | Values                                                                 | Shows |
| ----------------------------- | ---------------------------------------------------------------------- | ----- |
| `ANKIEL_DEBUG_REVIEW`         | `fixture`, `readonly`                                                  | Every thread gets canned turns (multi-hunk, added, deleted, renamed, binary, mode-only, a lock file, a 5,000-line file), both comparisons and a fake checkout on its default branch with uncommitted files. Nothing reaches a server; `readonly` is a session without `source-control:write`. |
| `ANKIEL_DEBUG_REVIEW_OPEN`    | `review`, `review:<section id>`, `file:<path>[@<section id>]`, `git`, `commit`, `confirm` | Opens it once in the thread the launch shows (fixture or live). Section ids are RN's: `turn:3`, `git:working-tree`, `git:branch-range`. |
| `ANKIEL_DEBUG_REVIEW_EXPAND`  | `1`                                                                    | A git section's file opens with every unchanged region shown. |

`swift run ankiel-probe --state <file> --diff [threadId]` reads, without writing anything, each
thread's turns with changes and their diffs (parsed and ordered), the checkout's status, both
comparisons, one lazy file patch and the contents check. `--git-actions <cwd>` (commit one file, push,
commit on a feature branch) and `--git-pull <cwd>` write: point them only at a throwaway repository
with a local bare remote, never a real checkout. `ReviewUITests` cover open → switch file →
expand context, the line comment hand-off to the composer, the default-branch confirmation and
scrolling a 5,000-line diff. `Fixtures/review/make-review-golden.mjs` (run from
`packages/client-runtime`) records the TypeScript review order and git action rules the Swift ports
must match.

## Push notifications

Settings → Notifications turns alerts on (iOS asks for permission only then, or after the one-time
offer that follows the first new thread), picks the kinds and shows each computer's relay status.
The app registers its APNs token with every connected computer (`server.registerPush`: token,
bundle id, `sandbox`/`production` from the embedded provisioning profile, sandbox on the simulator,
kinds and locale), again on each reconnect and whenever the token, kinds or language change, and
unregisters when push is turned off or before a connected computer is removed. Delivery goes
through the computer's own Cloudflare relay, which needs an APNs key from the team that signs the
app; nothing here can be checked without one (`docs/user/mobile-notifications.md`).

- The alert body is the APNs `loc-key` `ANKIEL_PUSH_{COMPLETED,FAILED,APPROVAL,INPUT}`, kept in the
  catalog as manual entries; ids sit under the payload's top-level `body` key.
- Alerts for the thread on screen stay quiet; others show. A tap opens the thread (cold or warm);
  opening a thread clears its alerts, and an approval or question answered elsewhere clears its
  alert once that computer's list is live.
- `ANKIEL_APPROVAL` (Approve, Deny) and `ANKIEL_INPUT_REPLY` (Reply) need the phone unlocked and
  answer without opening the app: it connects, waits until the thread's live projection shows the
  request, and sends with the fixed command id `notification:<button>:<requestId>`, within iOS's
  ~30 s. If that fails while the request still waits, a local alert says the answer was not sent.
- The app icon badge counts threads waiting on the user. The server's payload carries no badge, so
  it only changes while the app runs.

Simulator testing without APNs: `apps/ios/scripts/push-samples/*.apns` are shaped exactly like
`AgentAlertPush.apnsPayload`, with synthetic titles and placeholder ids: put a real
`environmentId` and `threadId` (in `body` and `aps.thread-id`) in a copy to test tap-to-open.

```sh
SIM=<udid>
xcrun simctl push $SIM com.ankiel.code.native apps/ios/scripts/push-samples/completed.apns
# A real pending request and its alert: stages a Replay approval, writes the payload, waits for an
# answer, prints how it ended and deletes the thread.
(cd apps/ios/Packages/AnkielKit && swift run ankiel-probe --state /tmp/probe.json --live push-stage \
  --scenario approval --out /tmp/staged.apns --wait 200) &
xcrun simctl push $SIM com.ankiel.code.native /tmp/staged.apns
# Register, read back and unregister with a made-up token (leaves the session unregistered).
(cd apps/ios/Packages/AnkielKit && swift run ankiel-probe --state /tmp/probe.json --live push)
```

`PushNotificationUITests` press SpringBoard's Allow, banners and buttons. They wait for a banner the
host sends, so they skip unless run with `TEST_RUNNER_PUSH_UI_TESTS=1` (and
`TEST_RUNNER_PUSH_THREAD_URL=<thread link>` for `testQuietForOpenThread`) while the alert above is
pushed ~45 s after the test starts.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_PUSH` | `on`, `on-more` | Notifications with push on and canned per-computer rows (On, Relay not set up, Relay has no push key; or Relay offline, Not connected, a refused read). Combine with `ANKIEL_DEBUG_SETTINGS=fixture` for three computers. |
| | `denied`, `unavailable` | iOS notifications off for the app; push on without a token. |
| | `offer` | The one-time offer over home. |

## Voice, archive and system entry points

**Voice** (`AnkielCode/Voice`, logic in `AnkielKit/Voice`): the composer's microphone dictates on
the device with iOS 26's `SpeechAnalyzer`/`SpeechTranscriber` in the app's language, downloading
the language's model first when it is missing. Live text shows after the draft while the field is
frozen; Done commits it once, Cancel leaves the draft. Where on-device transcription is unavailable
(the simulator included) the microphone hides, as in RN. A call, a lost headset or backgrounding ends
the session and keeps what was heard. Settings → Voice shows the language, the model and microphone
access. Transcribing on a computer or with a cloud provider (RN's other options) is not here yet.

**Archive** (Settings → Archive): each computer's `orchestration.getArchivedShellSnapshot`, searched,
filtered and paged on the device (the RPC takes no arguments). Archived threads open read-only.
`ankiel-probe --live archive` proves archive → list → open → unarchive → delete; `--seed <n>` archives
n "probe archive" threads for the screen, `--seed-clean` deletes them.

**Entry points** (`AnkielCode/Shortcuts`): App Intents (New thread with an optional prompt and
project, Open thread over the recent threads, Search threads) with App Shortcuts phrases; Home
Screen quick actions (New thread, Search, the latest thread); Spotlight items for recent threads
(one domain per computer, removed with it); and the keyboard and iPad menu bar commands. All of
them go through `AppModel.open(AppEntry)`, which never waits on a connection. Recent threads and
projects are saved in `UserDefaults` so intents answer from a cold launch. Links:
`ankielcode-native://new?prompt=…&environment=…&project=…` and `…://search?q=…`.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_VOICE` | `listen`, `download`, `unsupported`, `unavailable`, `fail`, `interrupt`, `denied` | A scripted speech engine (the simulator has no microphone to drive and no on-device transcriber): it "hears" a fixed sentence; `download` first fakes a model download; `denied` refuses the microphone. |
| `ANKIEL_DEBUG_INTENT` | `new`, `new:<prompt>`, `open`, `search:<query>` | Runs that intent's own `perform()` at launch, before the computers load, as Siri does at a cold launch. |
| `ANKIEL_DEBUG_RECENTS` | `1` | Prints the saved recent threads. |
| `ANKIEL_DEBUG_AUDIO_SESSION` | `1` | Tries the dictation engine's audio session setup at launch and prints the result. |
| `ANKIEL_DEBUG_ROUTE` | `settings-voice`, `settings-archive` | Those Settings pages. |

`VoiceUITests` (fake engine), `ArchiveUITests` (live; seed first) and `ShortcutUITests` (live;
quick actions through Springboard, intents through `ANKIEL_DEBUG_INTENT`) cover these.

## Usage limits and the widget

The thread's top bar shows its context window as a capsule meter (the active provider thread's
newest `tokenUsage`, its `contextUsage`, or a later compaction: `ContextWindow` in `AnkielKit/Usage`);
home shows a ring of the highest provider spend. Both open the usage sheet; Settings → Usage pools
accounts per provider with a page per account (banked resets, `provider.consumeResetCredit`). Limits
come from `ServerProvider.usageLimits` on the config stream; pull to refresh and opening the sheet
call `server.refreshProviders {}` (one in flight per computer, automatic ones at most every five
minutes, `UsageRefresher`). Links: `ankielcode-native://settings/usage` and `…://usage`.

`AnkielWidgets` is a WidgetKit extension (`com.ankiel.code.native.widgets`) sharing the App Group
`group.com.ankiel.code.native`. The app writes `subscription-usage.json` there whenever the limits
change (`UsageWidgetSnapshot`, Codex and Claude, no emails) and reloads the widget; the widget never
connects and greys a provider out at its expiry (15 minutes after the read, or its first reset).
Its views (`AnkielWidgets/UsageWidgetViews.swift`) are compiled into the app too and read the app's
String Catalog from the containing bundle; `AnkielWidgetsBundle.swift` (the widget, timeline and
the period intent) is widget-only. App Groups need provisioning to work on a device.

`swift run ankiel-probe --state <file> --usage` prints each provider's raw limits, forces a refresh,
says whether `providerStatuses` followed, and prints accounts, pools, the widget snapshot and every
listed thread's context window.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_USAGE` | `fresh`, `near`, `stale`, `unavailable`, `pooled`, `empty` | Canned computers' limits instead of the live ones (synthetic; refreshes only wait). Also written to the widget's snapshot. |
| `ANKIEL_DEBUG_CONTEXT` | `low`, `high`, `over`, `compacting`, `compacted`, `unknown` | Every thread's context window. |
| `ANKIEL_DEBUG_USAGE_OPEN` | `home`, `thread`, `widgets` | Opens the usage sheet from home or the open thread, or (home) the widget's views at each size, full color and monochrome. `ANKIEL_DEBUG_WIDGET_STALE=1` renders them an hour later. |

Settings → Usage directly: `ANKIEL_DEBUG_ROUTE=settings-usage`. `UsageUITests` open usage from home,
a thread and Settings on fixtures.

## Terminal

A thread's menu has **Terminal** (only with a confirmed `terminal:operate`): the thread's live shells
and "Open new terminal", pushed over the thread. The screen follows one terminal with
`terminal.attach` (`resume` after the first reply, `maxHistoryBytes`, the measured grid resent with
`terminal.resize` on every new attachment), lists the computer's shells with
`subscribeTerminalMetadata`, and closes a shell that exits while shown, moving to the nearest live
one (RN `ThreadTerminalRouteScreen`). Logic is in `AnkielKit/Terminal` (`TerminalSessionModel`);
the screen is in `AnkielCode/Terminal`.

Rendering is Ghostty: `Packages/Ghostty` wraps the same prebuilt `GhosttyKit.xcframework` the RN
module vendors (libghostty with its Metal renderer, arm64 device and simulator slices) as a binary
target that only the app links. `TerminalSurfaceView` is the RN module's `AnkielTerminalView` without
Expo: output is fed in, keys come out of a hidden text field (hardware key commands, IME-safe field
diffs), pastes go through `ghostty_surface_text` so bracketed paste follows the program, the bell
is a haptic, links open on tap and "Select text" opens the visible text in a selectable sheet. The
theme follows the app's appearance (`TerminalPalette`), the size follows the code font setting
(2.5 pt smaller, 6–14 pt), and the cursor stops blinking under Reduce Motion. A read-only observer
for sessions with only `terminal:read`, project scripts and "Attach output" to the composer are
not built.

`swift run ankiel-probe --state <file> --terminal <cwd>` runs a real shell through the same model
(echo, a 300 KB flood past the ack window, a resize read back with `stty size`, reattach with
scrollback, close). `--terminal-list <threadId> [--close term-2,term-3]` lists a thread's shells and
closes the named ones with their history. Use a throwaway folder under `/tmp`: the probe's shell
gets `ZDOTDIR` and its history there.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_TERMINAL` | `open`, `open:<terminalId>`, `new` | Opens the terminal of the thread a launch shows (an `ANKIEL_OPEN_URL` thread link). |
| `ANKIEL_DEBUG_TERMINAL_SEND` | text (`\r` is Enter) | Typed once the shell is live. The shell is real: harmless commands only. |
| `ANKIEL_DEBUG_TERMINAL_KEYBOARD` | `1` | Focuses the terminal (keyboard and accessory bar). |
| `ANKIEL_DEBUG_TERMINAL_SELECT` | `1` | Opens "Select text" a moment after the send. |
| `ANKIEL_DEBUG_TERMINAL_PASTE` | text (`\n` is a newline) | Pasted through the surface (Ghostty's bracketed paste) once the shell is live. |
| `ANKIEL_DEBUG_TERMINAL_HISTORY` | a folder | New shells start with `ZDOTDIR`, `HISTFILE` there and `LESSHISTFILE` off, so zsh skips the user's rc files and history (an rc file can reset `HISTFILE`). |
| `ANKIEL_DEBUG_TERMINAL_INPUT` | `1` | Puts the hidden input field in the accessibility tree so UI tests can type. |

`TerminalUITests` (live; skips when the dev server is down) opens a new terminal from the thread
menu in the `ankiel-probe live` project, types `echo`, rotates and closes it; a second test scrolls
back through 200 lines and leaves on `exit`.

## Pull requests

Home's toolbar opens **Pull requests** (a full-screen stack; the list beside the open pull request
on iPad), and a thread's pull request chip (rows and the thread header) opens its pull request.
Logic lives in `AnkielKit/PullRequests`, views in `AnkielCode/PullRequests`. The list reads
`pullRequests.list` from every computer whose config says `pullRequests`, filters on the device
like RN (`PullRequestQuery`, `PullRequestList`), fills line counts with `pullRequests.listStats`
and keeps the last first page per request plus the stats in `Caches/AnkielCode/pull-requests` so
it shows at once. Pull to refresh sends `pullRequests.invalidate` first. The diff is the HTTP route
`POST /api/pull-requests/diff` (`EnvironmentConnector.postJSON`), parsed by the Review parser and
drawn by `DiffLinesView` with review threads and pending inline comments under their lines.
Every write is a `PullRequestWrite` sent through a `PullRequestSink`. Reads and writes go through
`PullRequestRouter`: another computer answers only when both are trusted in **Pull request
routing** (the list's menu; per device, keyed by the saved addresses) and it verifies the same host
account; a write never moves to another computer once the server may have run it. "Start work"
fills the new-thread (or a linked thread's) draft with the pull request's link and the task's
prompt; nothing runs until it is sent.

`swift run ankiel-probe --state <file> --pull-requests [number] [--pr-state open|closed|merged|all]
[--pr-ref <projectId>:<owner/repo>:<number>] [--enable-github]` lists pull requests, reads one's
detail, conversation, checks, viewed files, linked threads and every diff page, and prints counts
only. It never writes to the host. `--enable-github` turns the computer's GitHub integration on
for that read and off again (it changes the server's settings).

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_PULL_REQUESTS` | `fixture`, `empty`, `signed-out`, `failing`, `readonly` | Synthetic pull requests on an invented repository (`PullRequestFixtures`), no server. `readonly` hides write controls. |
| `ANKIEL_DEBUG_PR_WRITES` | `fake`, `fail`, `slow`, `refuse` | Where writes go: a recording fake (the default with fixtures; its last write shows in a debug pill), one that refuses or never answers, or `refuse` for live reads with every write stopped on the device. |
| `ANKIEL_DEBUG_PR_OPEN` | `list`, `routing`, `link:<url>`, `pr:<n>`, `activity:<n>`, `files:<n>`, `file:<n>:<path>`, `review:<n>`, `merge:<n>`, `comment:<n>`, `edit:<n>`, `reviewers:<n>`, `thread:<n>`, `confirm-close:<n>` | Opens that screen or sheet at launch. |

`PullRequestUITests` run on fixtures: list → detail → files → a diff, search, the thread row chip,
and each write (comment, inline comment and review, merge with its confirmation, close, edit,
reviewers, thread reply and resolve, reaction) against the recording sink.

## Issues

Home's toolbar has **Issues** (RN's Issues tab): one computer's issues across its projects' trackers
(`issues.list`: open, closed or all, one project or every one, a search the trackers run, more
pages per scope as the list scrolls), each opening read-only (`issues.detail`, older pages with
`issues.comments`) with its description and comments as markdown. Rows and the detail offer Start a
thread (the new-thread sheet in the issue's project with its title and link), Copy link and Open on
the tracker. Writes (comment, close or reopen, edit, labels, assignees, reactions, new issues),
linked threads, saved views and the involvement filters are not built. Logic is in
`AnkielKit/Issues`; `swift run ankiel-probe --state <file> --issues [--project <id>] [--query <q>]
[--closed]` lists and opens the newest issue without writing anything.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_ISSUES` | `fixture`, `empty`, `fail` | Canned synthetic issues (about a made-up project) instead of a computer, none, or a refusal. |
| `ANKIEL_DEBUG_ISSUES_OPEN` | `list`, `detail` | Opens Issues over home, or (with `fixture`) its first issue. |

## Sharing & access

A computer's page has **Sharing & access** (web Settings "Sharing & access"; RN has no screen):
the devices signed in to it (`subscribeAuthAccess`: this device marked, online or last seen,
permissions) and its open pairing links. With `access:write` the page revokes another device
(`POST /api/auth/clients/revoke`, confirmed; the server refuses a device's own session) or a link
(`/api/auth/pairing-links/revoke`), and creates a one-time link (`/api/auth/pairing-token`) with a
name and permissions limited to what this device holds. A new link shows as a QR code of the
`ankielcode://pair?pairingUrl=…` app link (Core Image) plus Share, Copy link and Copy code, through
a saved address another device can reach (relay and tailnet first, never loopback). Codes exist
only in the create answer, so links made elsewhere cannot be shared from here. "Revoke others" is
not offered. Logic is in `AnkielKit/Access`.

`swift run ankiel-probe --state <file> --access [--revoke-session <id>]` prints the list, creates
and revokes a read-only link labelled "ankiel-probe access", checks that the session cannot revoke
itself and, with `--revoke-session`, revokes that one other session. Pair a throwaway session from
its own `--state` file for that (sessions sharing a DPoP key are revoked together).

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_ROUTE` | `settings-computer-access` | The page for the fixture's Studio Mac (with `ANKIEL_DEBUG_SETTINGS`) or the first saved computer (live). |
| `ANKIEL_DEBUG_ACCESS` | `fail`, `denied` | With `ANKIEL_DEBUG_SETTINGS`: the fake access service refuses writes, or the session may not read access. |
| `ANKIEL_DEBUG_ACCESS_OPEN` | `create`, `share` | Opens the create sheet, or creates a link on the fake and shows its QR. |

`SharingAccessUITests` (fixtures) revoke a device, create, share and revoke a link, and check the
denied state.

## Previews

A thread's menu has **Browser**, and a `localhost` (or `127.0.0.1`, `[::1]`, `0.0.0.0`) link in a
message opens there instead of Safari, which would load the phone's own localhost (RN
`LocalPreviewScreen`). The page is the computer's: a `WKWebView` whose website data store (one
in-memory store per computer) sends a stand-in host, `ankl.test`, to a SOCKS5 listener in the app;
each connection gets a ticketed `/api/preview/tunnel?wsTicket=…&port=…` WebSocket on the computer's
own route (LAN or relay alike), and the listener swaps `ankl.test` and `localhost` in plain HTTP.
There is no fallback to the device's loopback: a refused tunnel shows why (nothing on the port, not
connected, tunnel turned off, an outdated server, no `terminal:operate`). The menu also lists the
thread's server browser tabs (`preview.list` plus `subscribePreviewEvents`) to open on this device.
The streamed server browser (RN `PreviewStreamWebView`) and device streams are not built. Logic is
in `AnkielKit/Preview`, views in `AnkielCode/Preview`.

`swift run ankiel-probe --state <file> --preview-tunnel <port> [--closed-port <port>]
[--preview-thread <id>]` loads `http://localhost:<port>/` through the same listener and tunnel
(the stand-in host resolves nowhere, so a load proves the tunnel carried it), then checks a closed
port and a bogus ticket. `--preview-seed <url>` makes a Replay thread whose message links `url`;
`--preview-delete <id>` removes it.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_PREVIEW` | `start`, `open:<url>` | Opens the browser (empty, or at that address) in the thread a launch shows. |
| `ANKIEL_DEBUG_PREVIEW_STATE` | `port`, `environment`, `outdated`, `disabled`, `permission`, `setup`, `page`, `tunnel-off` | That state, with no server. |
| `ANKIEL_DEBUG_PREVIEW_TABS` | `fixture` | Two synthetic browser tabs in the menu and start page. |

`PreviewUITests` (live; skips without `ANKIEL_TEST_PREVIEW_THREAD_LINK` and
`ANKIEL_TEST_PREVIEW_PORT`, a page on the Mac whose index links `/second.html`) opens Browser from
the thread menu, types the address, follows a link, goes back and shows a closed port's error.

## Addresses, relay and route switching

A computer's page lists its addresses in the order this device prefers them (RN
`EnvironmentRoutesSection`): touch and hold one to move it, add one by hand (checked against the
computer's public descriptor before the sign-in goes there, never loopback, never plain `http` to
a public address unless the computer was paired that way) and remove one added by hand. The order
is `EnvironmentRecord.routeOrder`; without one, local addresses come first, then the paired one.
Below it, **Remote relay** shows `server.getRelayStatus` read only (changing the relay changes the
computer for every device) and offers to add the relay's address when this device has none.

`ConnectionSupervisor` follows RN's better-route rule: on an address other than the first that
answers, it checks the preferred ones every minute and at once when the network changes, connects
over the best one that answers and only then replaces the session (no offline blip). A route that
answered but failed to connect rests five minutes; a silent one is checked half as often each
time, up to 30 minutes, until the network changes. A health check the socket leaves unanswered asks
the host over HTTP after 0.5 s; if the host answers and the socket stays silent (0.5 s on the LAN,
2.5 s elsewhere) the socket is replaced without waiting out the timeout.

`swift run ankiel-probe --state <file> --routes` saves the computer with two addresses of the same
server (`127.0.0.1` and `localhost`), flips the order and prints the switch, the statuses seen
meanwhile, the relay status and two refused hand-added addresses. Nothing on the server changes.
`SharingAccessUITests.testAddressesReorderAndRefuseLoopback` covers the page on fixtures.

## Providers

Settings → Providers lists each computer's providers (status, version, the account with its
email masked until tapped, model count); pull to refresh re-probes them (`server.refreshProviders`
through `UsageRefresher`). A provider opens its page: status, version and the latest when behind,
the account and plan, and its models with Default, Hidden (from `providerModelPreferences`) and
Needs update badges. Signing in or out, switching accounts and adding Claude accounts are not
here: they act on the computer's real provider accounts and run multi-step sign-in flows, so the
page sends users to web or desktop Settings as RN does. `ANKIEL_DEBUG_ROUTE=settings-provider`
opens the fixture's Codex page; `SettingsMoreUITests` covers the list and a provider page.

## Workflows

Home's toolbar has **Workflows** (RN's Workflows tab): every computer's runs from
`workflows.subscribe`, in Needs you, Running and All (skipped runs on request), each opening to
its question, pause, steps (quick bookkeeping folded, overlapping steps together, an invoked run
in place of its steps), agent summaries and result. A session with `orchestration:operate`
answers questions, resumes paused runs and cancels running ones (`workflows.answer`, `.resume`,
`.cancel`); no client RPC starts a run (triggers, the CLI and agents do). Agent threads open from
their step and "Ask the agent first". Definitions, the run store, reference chips that open issues
or pull requests, and the counts badge are not built. Logic is in `AnkielKit/Workflows`
(result fields list in key order: Foundation does not keep the server's).

`swift run ankiel-probe --state <file> --workflows [--run <id>]` reads the list and one run's
feed. `--workflow-setup <file.ts>` turns the Labs switch on and saves a definition on a dev server;
`--workflow-teardown <file name>` deletes it and turns the switch off. Start runs with
`node apps/server/src/bin.ts workflow start <name> --base-dir <worktree>/.ankiel --input '<json>' --key <key>`.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_WORKFLOWS` | `fixture`, `readonly` | Synthetic runs (a question, a pause, an agent step, a finished run) with a recording sink; `readonly` without `orchestration:operate`. |
| `ANKIEL_DEBUG_WORKFLOWS_OPEN` | `list`, `run:<runId>` | Opens Workflows, or one run (live runs also need `ANKIEL_DEBUG_WORKFLOWS_ENVIRONMENT=<environmentId>`). |

`WorkflowUITests` (live, with `ANKIEL_TEST_WORKFLOWS=1`) answers "Ship tide chart v1.4?" and
cancels the paused "Tide chart v1.5", runs of a throwaway `ios-check` definition started as above.

## Chat and thread preferences

- **Response streaming** (Threads page, per computer): `responseStreamingMode` `paragraph` or
  `turn`, written with `server.updateSettings`. `ankiel-probe --streaming-setting` flips it and
  puts it back.
- **Use last project** (Threads → New threads, this device): on, New thread starts in the project
  this device last started a thread in on that computer (`lastProjectIds`), else the computer's
  most recent one; off, it starts with "No project" unless a project is picked.
- **Streaming replies** haptic (Chat → Haptics, this device): a soft tap as the open thread's reply
  streams, throttled like RN (`StreamHaptics`, 320 ms).
- **Apply auto-settle defaults to all** (Threads, all connected computers, when they differ).

Not built: tool-call visibility (the thread feed is being rebuilt separately) and project-scoped
overrides of model and permission defaults (RN's project overview).

## Scheduled tasks

Settings → **Scheduled tasks** lists every computer's tasks (`scheduledTasks.subscribe`) with
their schedule in the server's time zone (PST/PDT by the next run, PT otherwise) and the next run.
A row opens the editor; swipe or long-press to pause or resume, run now (not for webhooks), open a
bound thread or delete. The editor (new and edit) sets the name, prompt, project, model, workspace
(new worktree with an automatic base branch from `vcs.listRefs`, the project checkout, or a
checkout path), the schedule (a time on chosen weekdays, once, or every N minutes) and whether it
is enabled, and saves with `scheduledTasks.upsert`. Changing needs `orchestration:operate`.
Webhook schedules are shown and saved back unchanged; editing their signature, filters and
deduplication, rotating the URL, webhook deliveries, thread modes and binding to an existing
thread are not built. Logic is in `AnkielKit/ScheduledTasks`.

`swift run ankiel-probe --state <file> --scheduled-tasks` lists them read-only.

| Variable | Values | Shows |
| --- | --- | --- |
| `ANKIEL_DEBUG_SCHEDULED` | `fixture`, `readonly` | Synthetic tasks on a "Fixture Mac" with a recording sink (use with `ANKIEL_DEBUG_ROUTE=settings-scheduled`). |
| `ANKIEL_DEBUG_SCHEDULED_OPEN` | `new`, `edit:<taskId>` | Opens the editor once the page shows. |
| `ANKIEL_DEBUG_SCHEDULED_PRESET` | `project=<title>;model=<instance>/<model>;workspace=root` | A new task's defaults (live tests use the Replay model). |

`ScheduledTaskUITests` (live, with `ANKIEL_TEST_SCHEDULED=1`) creates a Replay task in the
`ankiel-probe live` project, runs it now, pauses and deletes it; delete the thread its run made.

## Usage cost and tokens

Settings → Usage has three tabs: Limits (as before), Cost and Tokens (RN usage tabs). Cost and
Tokens read one computer at a time with `server.getUsageSummary` (`diagnostics:read`) for the past
24 hours (hourly), 7, 30 or 90 days in the phone's time zone: first the provisional answer from the
computer's last scan, then a fresh scan when that one says it is refreshing, and again on pull to
refresh. `UsageReport` folds the buckets into the headline, a Swift Charts bar chart stacked by
provider, totals (cache savings, cached and uncached input, output with reasoning, the unpriced
share) and rankings by provider and model. RN merges every computer with source de-duplication;
here a picker chooses the computer instead. `ankiel-probe --usage-summary [days]` prints the same
fold, read only. `ANKIEL_DEBUG_USAGE_TAB=cost|tokens` opens a tab (synthetic data with
`ANKIEL_DEBUG_SETTINGS`).

## DPoP keys

New pairings bind to the installation's Secure Enclave key (`SystemEnclaveKeys`, usable after
first unlock without user presence, so background renewals and notification answers keep working);
its device-bound blob is kept in the Keychain as `dpop-enclave-key`. Sessions are bound to a key
thumbprint, so each computer records its key in `dpop-key-kind.<environmentId>`: absent means the
software key (`dpop-proof-key`), which computers paired earlier keep using. Where the enclave is
missing or fails (the simulator), new pairings use the software key. Removing a computer forgets
its record. The probe prints "Secure Enclave key" after pairing when it got one.

## Composer mentions

The composer's field is a `UITextView` (`ComposerTextEditor`), not a `TextField`, so mentions can
be chips: the draft stays plain text, and every `[name](path)` link or `@path` followed by
whitespace is drawn as one attachment character that stands for its source (it deletes as one,
copies as its source). The parsing is RN's (`AnkielKit/Composer`: `ComposerTrigger`,
`ComposerFileLink`, `ComposerInlineTokens`); offsets are UTF-16. Typing `@` searches the thread's
worktree (else its project root) with `projects.searchEntries` (20 results, 200 ms pause; a bare
`@` sends an empty query) and lists results above the composer. Arrows move, Return or Tab picks
and Escape closes it with a hardware keyboard. Sent, pending and queued messages show a mention by
its file name.

With `ANKIEL_DEBUG_COMPOSER`, `@` searches a made-up workspace (`MentionDebug`) instead of a
computer. `ComposerMentionUITests` picks, deletes and sends a mention and walks the list with the
keyboard. `swift run ankiel-probe --state <file> --files <cwd> --search <q>` also runs the `@`
search (bare and with the query) and checks each result's link reads back as its path.

## Composer commands

`/` lists RN mobile's set (`ComposerSlashMenu`): `/model` anywhere; at the start of a message
`/clear` (with the computer's `freshContext` capability, once the thread has run), the provider's
own commands for the composer's folder (a workspace snapshot replaces the provider list there;
`/compact` only with a conversation) and its invocable skills. `$` completes skills, ranked like RN.
`/model` opens the model sheet; `/clear`, picked or typed as the whole message, arms a fresh session
that the next `message.dispatch` carries as `freshContext: true` (a notice offers "Keep the current
session"); `/usage-limits`, which the server adds because the app subscribes with
`usageLimitsCommand`, opens the usage sheet. Other commands are sent as text. `/side` and `/btw`
are not offered: the app cannot start side chats yet.

The fixture Claude (`DebugCatalog`) lists `/review`, `/compact`, `/clear`, `/usage-limits` and a skill
for `ComposerSlashCommandUITests`. `swift run ankiel-probe --state <file> --live slash` prints every
provider's commands, then on Replay arms `/clear` through the composer store and checks the next
message reaches the server as a fresh session (deletes its thread).
