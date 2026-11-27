import AnkielKit
import Foundation

/// `--raw-shell <file>`: the first snapshot item as the server sent it (absent and null keys kept).
func dumpRawShell(_ session: EnvironmentSession, to path: String) async throws {
  let stream = try await session.rpc.stream(
    ShellSubscription.rpcTag, payload: session.initialConfig.shellSubscription, of: JSONValue.self)
  for try await item in stream {
    guard case .object(let object) = item, object["kind"]?.stringValue == "snapshot" else { continue }
    try JSONEncoder().encode(item).write(to: URL(filePath: path))
    print("wrote \(path)")
    return
  }
}

/// `--rows`: one line per thread with the fields list actions change, for before/after diffs of
/// UI tests against the seeded server.
func printRows(_ session: EnvironmentSession) async throws {
  let stream = try await session.subscribeShell(session.initialConfig.shellSubscription)
  var state = ShellState(awaitingCompletion: true)
  for try await item in stream {
    state.apply(item)
    if state.status == .live { break }
  }
  for thread in state.threads.sorted(by: { $0.id < $1.id }) {
    let fields: [String] = [
      thread.id, thread.title, "settled=\(thread.settledOverride?.rawValue ?? "nil")",
      "settledAt=\(thread.settledAt?.rawValue ?? "nil")", "pinned=\(thread.pinnedAt?.rawValue ?? "nil")",
      "snoozed=\(thread.snoozedUntil?.rawValue ?? "nil")", "archived=\(thread.archivedAt?.rawValue ?? "nil")",
      "visited=\(thread.lastVisitedAt?.rawValue ?? "nil")",
    ]
    print(fields.joined(separator: " | "))
  }
}
