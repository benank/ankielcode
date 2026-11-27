# Native iOS app

`apps/ios` is a SwiftUI client that talks to the same server as the other clients. It has no
`package.json` and no CI job: `vp run check:changed` runs its checks locally on a Mac.

## Wire types are hand-written

The Swift wire types in `AnkielKit` are written by hand, not generated from `packages/contracts`.
Two checks keep them honest, and both must pass after any contracts change that touches a command
or settings shape the app sends:

- `CommandEncodingTests` compares the Swift encoders byte for byte with
  `Tests/AnkielKitTests/Fixtures/commands/*.json`.
- [`check-schemas.mjs`](../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/commands/check-schemas.mjs)
  decodes the same files with the server's Effect schemas (strict: unknown keys fail) and
  re-encodes the provider catalog fixture. Run it from `packages/contracts`; `--check` compares
  instead of writing. `check:changed` runs it when contracts or the fixtures change.

The thread fixtures are produced the same way, by a script that decodes each item with the
server's stream schema and records the TypeScript reducer's output for the Swift reducer to match.

## Decoding tolerates the future

Servers outlive clients. Decoding never fails on an unknown field or an unknown enum value: string
enums use `WireEnum` (unknown values keep their raw string), and item and activity kinds have an
`unknown` case the UI renders as unsupported. Only a frame that cannot be read at all is dropped.

## Connection traps

- **Ack every chunk.** The server's RPC stream sends the next chunk only after the client acks the
  previous one. `RpcClient` acks each `Chunk` after delivering it; a stream that is never acked
  stalls without an error.
- **The config stream is the session.** `subscribeServerConfig` is the first request on every
  socket and stays open for the session's life; its first item must be a snapshot, and when it
  ends the session is over. Shell and thread subscriptions open after it, on the same socket.
- **One retry owner.** `ConnectionSupervisor` is the only code that retries or reconnects an
  environment. Links, routes and RPC calls fail once and report; adding a retry loop below the
  supervisor fights its backoff and wake-up probes.

## Debug hooks and fixtures

Debug builds read `ANKIEL_DEBUG_*` and `ANKIEL_OPEN_URL` launch variables (listed in
`apps/ios/README.md`) so agents can reach any screen without taps. They live behind `#if DEBUG`,
use their own storage and fake sinks, and must never forget saved computers or write to a real
server. Release builds leave them and the bundled fixtures out.

Fixtures are synthetic: invented conversations about a made-up project, marked
`"synthetic": true`. A test rejects home paths, real emails and tokens. Never paste a recorded
thread from a real machine.

## Strings

The String Catalog is the source of truth and ships the RN app's 10 locales. `xcodebuild` extracts
new keys but never writes them to the catalog (only the Xcode editor does), so after adding strings
run `node apps/ios/scripts/import-translations.mjs --sync <derived-data>`. `vp run i18n:check` fails
on a missing locale, a placeholder mismatch or a stale key.

## The widget shares the app's catalog

An app extension's bundle has no String Catalog of its own, and the translation scripts manage one
catalog. The widget's views live in `AnkielWidgets/` but are also members of the app target, so
the app build extracts their strings into `Localizable.xcstrings`; at run time the widget reads that
catalog from its containing app bundle (`WidgetCopy.bundle`). Only App Intent metadata (the widget's
configuration titles) cannot do this and stays English. The widget reads one JSON snapshot from the
App Group the app writes; it must never open a connection.
