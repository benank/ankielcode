import AnkielKit
import Foundation
import Synchronization

/// `--live <mode>`: live proofs of the wire paths the app uses, against a dev server running the
/// free `Replay (dev)` provider. Each mode creates and deletes its own threads (in the scratch
/// project) and puts back anything it changes on seeded threads.
func live(_ mode: String, environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  setvbuf(stdout, nil, _IOLBF, 0)
  let limit = Double(argument("--limit") ?? "") ?? 240
  Thread.detachNewThread {
    Thread.sleep(forTimeInterval: limit)
    FileHandle.standardError.write(Data("ankiel-probe: watchdog fired after \(Int(limit)) s\n".utf8))
    exit(3)
  }
  switch mode {
  case "threads":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await liveThreads(session)
  case "list":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await liveList(session, threadTitle: argument("--title") ?? "Mobile App ID")
  case "turn":
    var tapped = connector
    let tap = TapSlot()
    tapped.transportTap = { base in
      let wrapped = FrameTap(base)
      tap.withLock { $0 = wrapped }
      return wrapped
    }
    let session = try await tapped.connect(environment)
    defer { Task { await session.close() } }
    try await liveTurn(session, tap: tap.withLock { $0! }, scenario: argument("--scenario") ?? "showcase")
  case "undo":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await liveUndo(session)
  case "interrupt":
    var tapped = connector
    let tap = TapSlot()
    tapped.transportTap = { base in
      let wrapped = FrameTap(base)
      tap.withLock { $0 = wrapped }
      return wrapped
    }
    let session = try await tapped.connect(environment)
    defer { Task { await session.close() } }
    try await liveInterrupt(session, tap: tap.withLock { $0! })
  case "cleanup":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await liveCleanup(session)
  case "dispatch":
    // A raw command (JSON) for one-off repairs, e.g. putting back a seeded row's visit time.
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    let command = try JSONDecoder().decode(JSONValue.self, from: Data((argument("--json") ?? "{}").utf8))
    print(try await session.rpc.call(ThreadCommand.rpcTag, payload: command, as: JSONValue.self))
  case "row":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    let stream = try await session.rpc.stream(
      ShellSubscription.rpcTag, payload: session.initialConfig.shellSubscription, of: JSONValue.self)
    for try await item in stream where item["kind"]?.stringValue == "snapshot" {
      let rows = (item["snapshot"]?["threads"]?.arrayValue ?? []) + (item["snapshot"]?["archivedThreads"]?.arrayValue ?? [])
      for row in rows where row["id"]?.stringValue == argument("--thread") || row["title"]?.stringValue == argument("--title") {
        let data = try JSONEncoder.sorted.encode(row)
        print(String(decoding: data, as: UTF8.self))
      }
      break
    }
  default:
    throw ProbeFailure(description: "Unknown --live mode \(mode).")
  }
}

final class TapSlot: Sendable {
  private let slot = Mutex<FrameTap?>(nil)
  func withLock<R>(_ body: (inout FrameTap?) -> R) -> R { slot.withLock { body(&$0) } }
}

extension JSONEncoder {
  static var sorted: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    return encoder
  }
}
