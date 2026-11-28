# Ankiel Code for iOS (native)

A SwiftUI client for Ankiel Code servers: iOS 26+, Swift 6, no third-party Swift packages (the
terminal links the prebuilt `GhosttyKit.xcframework` that RN vendors). Bundle id
`com.ankiel.ankielcode.native` and URL scheme `ankielcode-native`, so it installs next to the RN app.
Architecture notes and traps: [docs/internals/18_ios-native.md](../../docs/internals/18_ios-native.md).

| Folder                | What                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AnkielCode/`         | The app: SwiftUI views, `DesignSystem/` (Geist type scale, generated theme palettes, motion), platform glue. A synchronized group: files on disk join the target.       |
| `AnkielWidgets/`      | The usage widget extension (App Group `group.com.ankiel.ankielcode.native`; reads a JSON snapshot the app writes, never connects).                                      |
| `AnkielCodeUITests/`  | XCUITests, on fixtures unless listed under "The full UI suite".                                                                                                         |
| `Packages/AnkielKit/` | Everything without UI: wire types, pairing and DPoP, the RPC client, the connection supervisor and registry, reducers, stores. `swift test` on the Mac; `ankiel-probe`. |
| `Packages/Ghostty/`   | The terminal renderer as a binary target (only the app links it).                                                                                                       |
| `Config/`, `scripts/` | Info.plist and entitlements; theme, translation and push-sample scripts.                                                                                                |

On the device: saved computers in `Application Support/AnkielCode/environments.json`, their last
shell in `shell/`, composer drafts and the outbox in `composer/`; credentials and DPoP keys in the
Keychain (new pairings use a Secure Enclave key; the simulator falls back to a software key); device
preferences in `UserDefaults` under `ankiel.preferences.v1`; media in `Caches/AnkielCode/media`.

## Build

```sh
SIM=<simulator udid>
xcodebuild -project apps/ios/AnkielCode.xcodeproj -scheme AnkielCode \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath apps/ios/build build
xcrun simctl install $SIM apps/ios/build/Build/Products/Debug-iphonesimulator/AnkielCode.app
SIMCTL_CHILD_ANKIEL_OPEN_URL='ankielcode-native://pair?pairingUrl=<urlencoded>' \
  xcrun simctl launch --terminate-running-process $SIM com.ankiel.ankielcode.native
```

Mint a pairing link on a dev server with `node apps/server/src/bin.ts auth pairing create --base-dir
<worktree>/.ankiel --base-url http://127.0.0.1:<port>`. Use `ANKIEL_OPEN_URL`, not `simctl openurl`,
whose confirmation prompt nobody can tap. `-configuration Release` leaves out every `#if DEBUG` hook
and the bundled fixtures. The project sets no `DEVELOPMENT_TEAM`; see "Needs signing".

On a paired iPhone, `apps/ios/scripts/run-on-device.sh [Release|Debug]` (default Release) builds,
installs and launches, signed like the RN personal-team build (`TEAM`, `BUNDLE_ID`, `RN_BUNDLE_ID`
override it). Capabilities the team refuses are dropped for that build: personal teams have no push,
and `xcodebuild` cannot register the App Group (assign it once in Xcode's Signing & Capabilities).

The first launch with no computers imports the RN app's pairings (`RNAppImport`): the app shares
the Keychain group of `ANKIEL_RN_BUNDLE_ID`, readable only when both apps are signed by one team.
The RN app's DPoP key comes along, so both apps use the same sessions.

## Test

```sh
(cd apps/ios/Packages/AnkielKit && swift test)
(cd packages/contracts && node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/commands/check-schemas.mjs --check)
node apps/ios/scripts/check-translations.mjs --build apps/ios/build
node apps/ios/scripts/generate-theme-palettes.mjs --check     # after a theme change in shared or mobile
xcodebuild test -project apps/ios/AnkielCode.xcodeproj -scheme AnkielCode \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath apps/ios/build \
  -only-testing:AnkielCodeUITests/PairDeviceUITests           # one class; drop it for the suite
```

`vp run check:changed` runs `swift test` when AnkielKit changed, `check-schemas.mjs --check` when its
fixtures or `packages/contracts` changed, and the translation check when app sources changed. CI
builds none of this.

Wire types are hand-written. `CommandEncodingTests` and each area's request samples compare the
Swift encoders with `Tests/AnkielKitTests/Fixtures/commands/*.json` (`ANKIEL_WRITE_COMMAND_FIXTURES=1`
on `swift test` rewrites them); `check-schemas.mjs` decodes the same files strictly with the
server's Effect schemas and writes `provider-catalog.json`, `access-stream.json` and
`pairing-invite-golden.json` from the server's schemas and `packages/shared` (without `--check` it
rewrites them). Other goldens say in their header which package to run them from:
`Fixtures/threads/make-thread-fixtures.mjs` and `Fixtures/review/make-review-golden.mjs`. Fixtures
are synthetic (`"synthetic": true`); a test rejects home paths, real emails and tokens.

### The full UI suite

About 140 tests, 45–60 minutes. Most run on fixtures. The classes below need the dev server
(`127.0.0.1:14527`, paired on the simulator) and skip without it or their variable;
`TEST_RUNNER_<NAME>` reaches the test as `<NAME>`. `TEST_RUNNER_SHOTS_DIR=<dir>` keeps screenshots.

| Class                                                                                             | Needs                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LiveListUITests`, `LiveThreadUITests`, `ShortcutUITests`, `MediaFilesUITests`, `TerminalUITests` | The dev server only (`TEST_RUNNER_ANKIEL_TEST_THREAD_LINK` / `…_TERMINAL_THREAD_LINK` override the thread).                                                                                                                                                                                 |
| `ArchiveUITests` (live test)                                                                      | Archived threads from `ankiel-probe --live archive --seed 3`; `--live archive --seed-clean` removes the rest.                                                                                                                                                                               |
| `LiveIssuesGateUITests`                                                                           | Two runs: `TEST_RUNNER_ANKIEL_TEST_ISSUES=shown` after `ankiel-probe --set-github on`, `hidden` after `--set-github off`. Put the setting back.                                                                                                                                             |
| `PreviewUITests`                                                                                  | `TEST_RUNNER_ANKIEL_TEST_PREVIEW_THREAD_LINK=<thread link>`, `TEST_RUNNER_ANKIEL_TEST_PREVIEW_PORT=<port>` of a static page server whose index has the heading "Tide chart preview", a script that writes "Script: loaded" and a "Second page" link to `/second.html` (stop it by its PID). |
| `WorkflowUITests`                                                                                 | `TEST_RUNNER_ANKIEL_TEST_WORKFLOWS=1` and the two runs below.                                                                                                                                                                                                                               |
| `ScheduledTaskUITests`                                                                            | `TEST_RUNNER_ANKIEL_TEST_SCHEDULED=1` and the `ankiel-probe live` project (any writing `--live` mode creates it); delete the thread the run made.                                                                                                                                           |
| `LivePairDeviceUITests`                                                                           | `TEST_RUNNER_ANKIEL_TEST_PAIR_INVITE=<file>`, `TEST_RUNNER_ANKIEL_TEST_PAIR_BASE=http://127.0.0.1:<port>/`, with `ankiel-probe --claim-invite <file>` running; revoke the session it creates.                                                                                               |
| `ReviewLiveGitUITests`                                                                            | `TEST_RUNNER_LIVE_GIT_THREAD=<thread link>` from `ankiel-probe --git-thread <throwaway checkout under /tmp>` (`_EXPECT`, `_DONE`, `_CONFIRM` per step).                                                                                                                                     |
| `PushNotificationUITests`                                                                         | `TEST_RUNNER_PUSH_UI_TESTS=1` while an alert is pushed with `simctl push` about 45 s in (`TEST_RUNNER_PUSH_THREAD_URL` for the quiet test).                                                                                                                                                 |
| `SplitLayoutUITests`                                                                              | An iPad simulator.                                                                                                                                                                                                                                                                          |

The workflow runs come from a throwaway `ios-check.ts` shaped like the example in
`docs/user/workflows.md`: titled `Tide chart <name>`, asking `Ship tide chart <name>? …`, with a code
step that fails (pausing the run) when `fail` is set.

```sh
swift run --package-path apps/ios/Packages/AnkielKit ankiel-probe --state <file> --workflow-setup ios-check.ts
node apps/server/src/bin.ts workflow start ios-check --base-dir <worktree>/.ankiel --input '{"name":"v1.4"}' --key v1.4
node apps/server/src/bin.ts workflow start ios-check --base-dir <worktree>/.ankiel --input '{"name":"v1.5","fail":true}' --key v1.5
# afterwards: --workflow-teardown ios-check.ts
```

## Translations

`Localizable.xcstrings` ships RN's 10 locales. `xcodebuild` extracts new keys but never writes them,
so after adding strings run `node apps/ios/scripts/import-translations.mjs --sync apps/ios/build`.
It copies a translation when the English matches an RN string (placeholders normalized, plurals and
JSX variables kept), else from `scripts/manual-translations.json` (all 9 locales, marked
`needs_review`). Debug-only strings (comment starting `debug`) are not translated. Intermediates of
another configuration in the same derived data feed it removed strings: delete
`Build/Intermediates.noindex/AnkielCode.build/<other configuration>` first.

## Type and color

Geist and Geist Mono (RN's OFL files via `UIAppFonts`; license under Settings → About). Theme
palettes are generated from RN's (`apps/mobile/src/lib/mobileTheme.ts`) into AnkielKit's
`Theme/ThemePalettes.generated.swift` by `scripts/generate-theme-palettes.mjs`;
`ThemeContrastTests` checks WCAG AA in every theme. Use the tokens in `AnkielCode/DesignSystem`.

## Debug hooks (Debug builds only)

Launch variables (`SIMCTL_CHILD_<NAME>=… xcrun simctl launch …`). None forgets saved computers or
writes to a real server unless its row says live.

| Variable                                                                                        | Values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANKIEL_OPEN_URL`                                                                               | A deep link opened at launch (pairing links pair at once): `…://pair?pairingUrl=`, `…://thread/<environmentId>/<threadId>`, `…://settings/usage`, `…://usage`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `ANKIEL_DEBUG_ROUTE`                                                                            | `onboarding`, `onboarding-help`, `pairing-link`, `scanner`, `computers`, `settings`, `new-thread`, `thread`, `computer`, `pairing-<confirm, checking, exchanging, connecting, success, expired, unreachable, incompatible, claims, clock, invalid>`, or `settings-<page>`: `general`, `appearance`, `chat`, `notifications`, `providers`, `provider`, `threads`, `about`, `storage`, `diagnostics`, `voice`, `archive`, `scheduled`, `usage`, `computers`, `computer`, `computer-pairing`, `computer-off`, `computer-access`, `computer-pair`. |
| `ANKIEL_DEBUG_SETTINGS` (`_KEEP=1`)                                                             | `fixture`, `fail`, `slow`: three canned computers with their own storage, a fake settings sink and release check. `_KEEP` keeps the last launch's preferences.                                                                                                                                                                                                                                                                                                                                                                                 |
| `ANKIEL_DEBUG_STATUS`                                                                           | `reconnecting`, `offline`, `connecting`, `needs-pairing`, `incompatible`, `mismatch` on every computer (display only).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ANKIEL_DEBUG_THEME`                                                                            | `<id>`, `<light>/<dark>`, or `<id>@<seconds>` (a switch after launch).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ANKIEL_DEBUG_HOME`, `ANKIEL_DEBUG_SEARCH`                                                      | `sample`, `empty` canned list; a typed query.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ANKIEL_DEBUG_THREAD` (`_EXPAND`, `_SCROLL`, `_DELAY`)                                          | A bundled fixture: `short`, `markdown`, `rich-markdown`, `subagents`, `pending`, `failed`, `kinds`, `replay`, `long`, and requests (`approval-*`, `question-*`, `secret`, `secret-fields`, `requests-mixed`). `_EXPAND=folds or all`, `_SCROLL=top`, `_DELAY=<seconds>`.                                                                                                                                                                                                                                                                       |
| `ANKIEL_DEBUG_COMPOSER` (`_RESET=1`, `_PRESET`)                                                 | `fake`, `slow`, `fail`, `offline` sink and store. `_PRESET`: `multiline`, `attachments`, `send`, `queued`, `failed`, `picker`, `keyboard`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ANKIEL_DEBUG_REQUESTS`                                                                         | `readonly`, `elsewhere`, `expire` (with a request fixture).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ANKIEL_DEBUG_FILES`                                                                            | `browser` (with a thread route or link).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ANKIEL_DEBUG_REVIEW` (`_OPEN`, `_EXPAND=1`)                                                    | `fixture`, `readonly`. `_OPEN`: `review[:<section>]`, `file:<path>[@<section>]`, `git`, `commit`, `confirm`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ANKIEL_DEBUG_PUSH`                                                                             | `on`, `on-more`, `denied`, `unavailable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ANKIEL_DEBUG_VOICE`, `ANKIEL_DEBUG_AUDIO_SESSION=1`                                            | Scripted dictation `listen`, `download`, `unsupported`, `unavailable`, `fail`, `interrupt`, `denied`; print the audio session setup.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ANKIEL_DEBUG_INTENT`, `ANKIEL_DEBUG_RECENTS=1`                                                 | An App Intent at cold launch: `new[:<prompt>]`, `open`, `search:<query>`; print recent threads.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ANKIEL_DEBUG_USAGE` (`_OPEN`, `_TAB`), `ANKIEL_DEBUG_CONTEXT`, `ANKIEL_DEBUG_WIDGET_*`         | Limits `fresh`, `near`, `stale`, `unavailable`, `pooled`, `empty`; `_OPEN=home, thread or widgets`; `_TAB=cost or tokens`; context `low`, `high`, `over`, `compacting`, `compacted`, `unknown`; `WIDGET_STALE=1`, `WIDGET_PAGE=2`.                                                                                                                                                                                                                                                                                                             |
| `ANKIEL_DEBUG_TERMINAL` (`_SEND`, `_PASTE`, `_KEYBOARD=1`, `_SELECT=1`, `_INPUT=1`, `_HISTORY`) | Live: `open[:<id>]` or `new` in the thread a link opens; text to type or paste once live; `_HISTORY=<folder>` keeps zsh off the user's rc and history.                                                                                                                                                                                                                                                                                                                                                                                         |
| `ANKIEL_DEBUG_ISSUES` (`_OPEN`)                                                                 | `fixture`, `empty`, `fail`; `_OPEN=list or detail`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ANKIEL_DEBUG_ACCESS` (`_OPEN`)                                                                 | With `ANKIEL_DEBUG_SETTINGS`: `fail`, `denied`; `_OPEN=create or share`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ANKIEL_DEBUG_PAIR_DEVICE`                                                                      | With `ANKIEL_DEBUG_SETTINGS`: fake invites `ready`, `claimed`, `expired`, `fail`, `limit`; `noaccess` and `unsupported` take `access:write` or the capability off the fixture computer.                                                                                                                                                                                                                                                                                                                                                        |
| `ANKIEL_DEBUG_PAIR_BASE_URL`, `ANKIEL_DEBUG_PAIR_INVITE_OUT`                                    | Live: the address invites carry (the simulator's own is loopback, which is never shared) and a host path that receives each live invite's `.ankielpair` for `ankiel-probe --claim-invite`.                                                                                                                                                                                                                                                                                                                                                     |
| `ANKIEL_DEBUG_PREVIEW` (`_STATE`, `_TABS`)                                                      | `start`, `open:<url>`; `_STATE`: `port`, `environment`, `outdated`, `disabled`, `permission`, `setup`, `page`, `tunnel-off`; `_TABS=fixture`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ANKIEL_DEBUG_WORKFLOWS` (`_OPEN`, `_ENVIRONMENT`)                                              | `fixture`, `readonly`; `_OPEN=list or run:<runId>` (a live run also needs `_ENVIRONMENT=<environmentId>`).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ANKIEL_DEBUG_SCHEDULED` (`_OPEN`, `_PRESET`)                                                   | `fixture`, `readonly`; `_OPEN=new or edit:<taskId>`; `_PRESET=project=<title>;model=<instance>/<model>;workspace=root`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ANKIEL_DEBUG_LAUNCH_STALLS=1`                                                                  | Prints main-thread stalls over 100 ms in the first ten seconds (launch milestones always print in Debug).                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## The live probe

`ankiel-probe` drives AnkielKit against a real server from the command line. Pair it once into its
own state file (pair a separate one to test revoking: sessions sharing a DPoP key are revoked
together). Modes that write create their own data and remove it.

```sh
cd apps/ios/Packages/AnkielKit
swift run ankiel-probe --pair-url 'http://127.0.0.1:<port>/pair#token=<CODE>' --state /tmp/probe.json
swift run ankiel-probe --state /tmp/probe.json [--trace]       # connect, read the shell, summary
```

| Flags                                                                                                                                                                                                                                                                                 | Proves                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--supervise`, `--stale-resume`, `--force-renew`, `--routes`                                                                                                                                                                                                                          | The registry's reconnects, renewal, resume and snapshot fallback; the server's answer to an unreplayable resume; route preflight.                                                                                                                                               |
| `--live <mode>`: `threads`, `list`, `turn`, `undo`, `interrupt`, `requests`, `composer`, `slash`, `worktree`, `detail`, `settings`, `release`, `archive`, `push`, `push-stage`, `repair`, `cleanup`                                                                                   | The app's own stores against Replay threads in an `ankiel-probe live` project (`--limit <s>`, default 240; `cleanup` removes the project).                                                                                                                                      |
| `--files <cwd>`, `--diff`, `--git-actions <repo>`, `--git-pull <repo>`, `--git-thread <repo>`                                                                                                                                                                                         | File reads and media; review diffs; git actions (throwaway repositories under `/tmp` with a local bare remote only).                                                                                                                                                            |
| `--access [--revoke-session <id>]`                                                                                                                                                                                                                                                    | Sharing & access: the list, a link created and revoked, self-revoke refused, one other session revoked.                                                                                                                                                                         |
| `--pair-invite [--deny] [--edges]`                                                                                                                                                                                                                                                    | A device pairing invite end to end, with a throwaway DPoP key as the other device: claim, the same code on both sides, approve or deny, the credential spent once, the new session signed in, creator-only reads, revoke. `--edges`: cancel, a wrong code, the 16-invite limit. |
| `--claim-invite <file>`                                                                                                                                                                                                                                                               | Only the other device, for the simulator: claims the invite the app wrote and waits for the app's decision.                                                                                                                                                                     |
| `--terminal <cwd>`, `--terminal-list <threadId>`, `--preview-tunnel`, `--usage`, `--usage-summary <days>`, `--issues`, `--set-github on or off`, `--workflows`, `--workflow-setup`, `--workflow-teardown`, `--scheduled-tasks`, `--streaming-setting`, `--rows`, `--raw-shell <file>` | One area each; read-only unless the name says otherwise.                                                                                                                                                                                                                        |

## Pair a device

The computer page's "Pair another device" section, and a row on Sharing & access, open a page that
creates a one-time invite (`/api/auth/pairing-invites`, needs `access:write`), advertises it over
Handoff (`NSUserActivity` `com.ankiel.ankielcode.pair-environment`, listed in `NSUserActivityTypes`),
shares it as an `.ankielpair` file (type imported: RN and the desktop app export it) or an
`ankielcode://pair-invite` link, polls it once a second while the app is active, shows the claiming
device and its `123-456` code, and approves or denies. Invites last two minutes, at most 16 per
server, and only the creating session can read one; leaving the page denies a live invite. As on
RN, the phone never claims an invite: desktop and web receive them.

## Needs signing

An unsigned simulator build cannot exercise:

- **Handoff** to the desktop app: both apps signed by one team. Only the payload is tested (golden).
- **Push**: an APNs key from the signing team on the computer's Cloudflare relay
  (`docs/user/mobile-notifications.md`). `scripts/push-samples/*.apns` with `simctl push` test the
  app's side.
- **The widget's App Group**, **Secure Enclave DPoP keys**, **on-device dictation** (unavailable on
  the simulator) and **camera QR scanning**: device features under the team's provisioning.
