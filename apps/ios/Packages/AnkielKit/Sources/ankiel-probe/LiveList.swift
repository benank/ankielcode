import AnkielKit
import Foundation

/// `--live list`: every list action the home screen sends, on one seeded thread, each followed by
/// the undo the app would send; the row's fields must end where they started. Then server search
/// and an older-settled page.
func liveList(_ session: EnvironmentSession, threadTitle: String) async throws {
  let environmentId = session.environmentId
  let watched: [String] = [
    "title", "settledAt", "unsettledAt", "settledOverride", "snoozedUntil", "snoozedAt", "pinnedAt",
    "pinOrderKey", "archivedAt", "lastVisitedAt",
  ]
  func rawRow(_ id: String) async throws -> [String: JSONValue]? {
    let stream = try await session.rpc.stream(
      ShellSubscription.rpcTag, payload: session.initialConfig.shellSubscription, of: JSONValue.self)
    for try await item in stream where item["kind"]?.stringValue == "snapshot" {
      for row in item["snapshot"]?["threads"]?.arrayValue ?? [] where row["id"]?.stringValue == id {
        if case .object(let object) = row { return object }
      }
      return nil
    }
    return nil
  }
  func fields(_ row: [String: JSONValue]?) -> [String: String] {
    var out: [String: String] = [:]
    for key in watched {
      out[key] = row.flatMap { $0[key] }.map { value in
        switch value {
        case .null: "null"
        case .string(let s): s
        default: "\(value)"
        }
      } ?? "absent"
    }
    return out
  }
  func send(_ action: ThreadAction, _ id: String) async throws {
    _ = try await session.rpc.call(ThreadCommand.rpcTag, payload: ThreadCommand(action, threadId: id), as: DispatchResult.self)
  }

  let threads = try await shellThreads(session)
  guard let thread = threads.first(where: { $0.title == threadTitle }) else {
    throw ProbeFailure(description: "No seeded thread titled \(threadTitle).")
  }
  let id = thread.id
  let start = fields(try await rawRow(id))
  print("row \(threadTitle): \(start.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
  var failures: [String] = []

  func step(_ name: String, _ action: ThreadAction, expect: (([String: String]) -> Bool)) async throws {
    try await send(action, id)
    let now = fields(try await rawRow(id))
    let ok = expect(now)
    if !ok { failures.append(name) }
    print("  \(ok ? "✓" : "✗") \(name): \(now.filter { start[$0.key] != $0.value }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" })")
  }

  // Settle, then the app's undo (unsettle back to the old position).
  let current = try await currentThread(session, id)
  try await step("settle", .settle) { $0["settledAt"] != "null" && $0["settledAt"] != "absent" }
  try await step("undo settle", .unsettle(restoreUnsettledAt: .some(current.unsettledAt))) {
    $0["settledAt"] == start["settledAt"] && $0["unsettledAt"] == start["unsettledAt"]
  }
  try await step("snooze 1 h", .snooze(until: .now.addingTimeInterval(3600))) { $0["snoozedUntil"] != start["snoozedUntil"] }
  try await step("wake", .unsnooze) { $0["snoozedUntil"] == start["snoozedUntil"] }
  let keys = threads.filter { $0.pinnedAt != nil }.map(\.pinOrderKey)
  try await step("pin", .pin(orderKey: ThreadOrder.topOfPinned(keys))) { $0["pinnedAt"] != start["pinnedAt"] }
  try await step("unpin", .unpin) { $0["pinnedAt"] == start["pinnedAt"] }
  try await step("rename", .rename("\(threadTitle) (probe)")) { $0["title"] == "\(threadTitle) (probe)" }
  try await step("rename back", .rename(threadTitle)) { $0["title"] == threadTitle }
  let facts = ThreadFacts(environmentId: environmentId, thread: try await currentThread(session, id))
  switch ThreadRules.readToggle(facts, wokeAt: nil) {
  case .markUnread?:
    try await step("mark unread", .markUnread) { $0["lastVisitedAt"] != start["lastVisitedAt"] }
    let unread = ThreadFacts(environmentId: environmentId, thread: try await currentThread(session, id))
    if case .markRead(let visitedAt)? = ThreadRules.readToggle(unread, wokeAt: nil) {
      try await step("mark read", .markRead(visitedAt: visitedAt)) { $0["lastVisitedAt"] != "null" }
    } else {
      failures.append("mark read offered after mark unread")
      print("  ✗ the row offers no mark read after mark unread")
    }
  case .markRead(let visitedAt)?:
    try await step("mark read", .markRead(visitedAt: visitedAt)) { $0["lastVisitedAt"] != start["lastVisitedAt"] }
    try await step("mark unread", .markUnread) { _ in true }
  case nil:
    print("  – no read toggle on this row")
  }
  try await step("archive", .archive) { $0["archivedAt"] != start["archivedAt"] }
  try await step("unarchive", .unarchive) { $0["archivedAt"] == start["archivedAt"] }

  let end = fields(try await rawRow(id))
  let changed = end.filter { start[$0.key] != $0.value && $0.key != "lastVisitedAt" }
  print("restored: \(changed.isEmpty ? "yes" : "no, \(changed)")\(end["lastVisitedAt"] != start["lastVisitedAt"] ? " (lastVisitedAt \(start["lastVisitedAt"]!) → \(end["lastVisitedAt"]!))" : "")")
  if !changed.isEmpty { failures.append("restore") }

  let word = threadTitle.split(separator: " ").first.map(String.init) ?? threadTitle
  let search = try await session.rpc.call(
    ThreadSearchRequest.rpcTag, payload: ThreadSearchRequest(query: word, limit: 20), as: ThreadSearchResult.self)
  print("search \"\(word)\": \(search.matches.count) matches, \(search.threads.count) older rows; first: \(search.matches.first.map { "\($0.threadId == id ? "this thread" : $0.threadId) “\($0.snippet.prefix(60))”" } ?? "none")")
  let shell = try await shellSnapshot(session)
  if let older = shell.olderSettled {
    let page = try await session.rpc.call(
      OlderSettledRequest.rpcTag, payload: OlderSettledRequest(before: OlderSettledCursor(settledAt: older.before), limit: OlderSettledRequest.pageSize),
      as: OlderSettledPage.self)
    print("older settled before \(older.before.rawValue): \(page.threads.count) rows, counts \(page.counts.count), seq \(page.snapshotSequence)")
  }
  if !failures.isEmpty { throw ProbeFailure(description: "Failed: \(failures)") }
}

func shellSnapshot(_ session: EnvironmentSession) async throws -> ShellSnapshot {
  let stream = try await session.subscribeShell(session.initialConfig.shellSubscription)
  for try await item in stream {
    if case .snapshot(let snapshot, nil) = item { return snapshot }
  }
  throw ProbeFailure(description: "The shell ended without a snapshot.")
}

func currentThread(_ session: EnvironmentSession, _ id: String) async throws -> ThreadShell {
  guard let thread = try await shellThreads(session).first(where: { $0.id == id }) else {
    throw ProbeFailure(description: "Thread \(id) is not in the shell.")
  }
  return thread
}
