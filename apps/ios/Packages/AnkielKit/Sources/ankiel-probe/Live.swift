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
  case "requests":
    let session = try await connector.connect(environment)
    let other = try await connector.connect(environment)
    defer { Task { await session.close(); await other.close() } }
    try await liveRequests(session, other: other)
  case "composer":
    try await liveComposer(environment, connector: connector)
  case "slash":
    try await liveSlash(environment, connector: connector)
  case "detail":
    try await liveDetail(environment, connector: connector)
  case "settings":
    try await liveSettings(environment, connector: connector)
  case "repair":
    try await liveRepair(environment, connector: connector)
  case "release":
    let session = try await connector.connect(environment)
    let version = session.initialConfig.environment.serverVersion
    let update = session.initialConfig.environment.capabilities["serverSelfUpdate"]
    await session.close()
    do {
      let newer = try await ReleaseLookup.live.newerVersion(than: version)
      print("server \(version) (serverSelfUpdate \(update.map { "\($0)" } ?? "absent")): newer release \(newer ?? "none")")
    } catch {
      print("release check failed: \(error)")
    }
  case "config-key":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    let stream = try await session.rpc.stream(ServerConfigSubscription.rpcTag, payload: ServerConfigSubscription(), of: JSONValue.self)
    for try await item in stream {
      let key = argument("--key") ?? ""
      print(findKey(key, in: item).map { String(decoding: (try? JSONEncoder.sorted.encode($0)) ?? Data(), as: UTF8.self) } ?? "absent")
      break
    }
  case "rows-dump":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    let stream = try await session.rpc.stream(
      ShellSubscription.rpcTag, payload: session.initialConfig.shellSubscription, of: JSONValue.self)
    for try await item in stream where item["kind"]?.stringValue == "snapshot" {
      var rows = item["snapshot"]?["threads"]?.arrayValue ?? []
      rows.sort { ($0["id"]?.stringValue ?? "") < ($1["id"]?.stringValue ?? "") }
      print(String(decoding: try JSONEncoder.sorted.encode(JSONValue.array(rows)), as: UTF8.self))
      break
    }
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
  case "push-stage":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await livePushStage(
      session, scenario: argument("--scenario") ?? "approval", out: argument("--out"), wait: Double(argument("--wait") ?? "") ?? 180)
  case "push":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await livePush(session, token: argument("--token"))
  case "archive":
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    try await liveArchive(session)
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
