import AnkielKit
import Foundation

/// `--live detail`: the thread screen's model through the real registry: the reopen cache, a
/// socket drop in the middle of a streaming turn, command output fetched on expand, subagent
/// child threads, the session's permissions and a refused socket upgrade.
@MainActor
func liveDetail(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-detail-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  registry.threadCacheLifetime = .seconds(3)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "Not adopted.") }
  func wait(_ what: String, _ seconds: Double = 60, _ done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell") { model.isShellLive }
  let environmentId = model.id
  var failures: [String] = []

  // Permissions (`GET /api/auth/session`), read after the session started.
  try await wait("the scopes", 10) { model.grantedScopes != nil }
  print("scopes: \(model.grantedScopes.map { $0.sorted().joined(separator: " ") } ?? "none")")

  // Reopen within the cache lifetime: same model, rows at once; after it: a fresh model.
  guard let seeded = model.shell.threads.first(where: { $0.title == "Open a Damaged Mac App" }) ?? model.shell.threads.first else {
    throw ProbeFailure(description: "No seeded thread.")
  }
  let seededRef = ThreadRef(environmentId: environmentId, threadId: seeded.id)
  let opened = registry.openThread(seededRef)
  try await wait("the seeded thread live", 20) { opened.state.phase == .live }
  let rows = opened.state.timeline.rows.count
  registry.closeThread(opened)
  try await Task.sleep(for: .seconds(1))
  let reopened = registry.openThread(seededRef)
  print("reopen after 1 s: \(reopened === opened ? "same model" : "NEW model"), \(reopened.state.timeline.rows.count)/\(rows) rows at once, phase \(reopened.state.phase)")
  if reopened !== opened || reopened.state.timeline.rows.count != rows { failures.append("reopen cache") }
  try await wait("the reopened thread live", 20) { reopened.state.phase == .live }
  registry.closeThread(reopened)
  try await Task.sleep(for: .seconds(4))
  let cold = registry.openThread(seededRef)
  print("reopen after the cache expired: \(cold === opened ? "same model (!)" : "new model"), phase \(cold.state.phase)")
  if cold === opened { failures.append("cache expiry") }
  registry.closeThread(cold)

  // Subagent child threads of the seeded plan thread.
  if let parent = model.shell.threads.first(where: { $0.title == "Plan Native Swift App Migration" }) {
    let detail = registry.openThread(ThreadRef(environmentId: environmentId, threadId: parent.id))
    try await wait("the plan thread", 20) { detail.state.phase == .live }
    let children = detail.state.timeline.rows.compactMap { if case .subagent(let row) = $0.content { row.childThreadId } else { nil } }
    print("subagent rows: \(children.count), child ids \(children.count)")
    registry.closeThread(detail)
    for child in Set(children) {
      let childDetail = registry.openThread(ThreadRef(environmentId: environmentId, threadId: child))
      do {
        try await wait("child \(child)", 20) {
          if case .unavailable = childDetail.state.phase { return true }
          return childDetail.state.phase == .live
        }
        print("  child \(child.prefix(8)): \(childDetail.state.phase), parent \(childDetail.state.parentThreadId == parent.id ? "matches" : childDetail.state.parentThreadId ?? "nil"), rows \(describeRows(childDetail.state))")
      } catch {
        print("  child \(child.prefix(8)): \(error)")
        failures.append("child \(child)")
      }
      registry.closeThread(childDetail)
    }
  }

  // A refused upgrade: a made-up ticket must answer 401 at the socket.
  do {
    let url = try connector.socketURL(endpoint: environment.endpoint, ticket: "probe-bogus-ticket", key: nil)
    let transport = try await WebSocketTransport.connect(to: url)
    await transport.close()
    print("bogus ticket: the upgrade was ACCEPTED")
    failures.append("401 at upgrade")
  } catch {
    print("bogus ticket: \(error)")
  }

  let side = try await connector.connect(environment)
  defer { Task { await side.close() } }

  // Command output: the stream strips it, `getTurnItem` returns it.
  try await withReplayThread(side, scenario: "command-output", runtimeMode: .fullAccess) { threadId, _, watcher in
    _ = try await watcher.until(60, "the command turn", idle)
    let ref = ThreadRef(environmentId: environmentId, threadId: threadId)
    let detail = registry.openThread(ref)
    try await wait("the command thread", 20) { detail.state.phase == .live }
    let projection = await detail.sync.projection
    let commands = projection?.visibleTurnItems.filter { if case .commandExecution = $0.item.body { true } else { false } } ?? []
    for row in commands {
      guard case .commandExecution(let streamed) = row.item.body else { continue }
      detail.loadDetail(itemId: row.item.id, revision: 0)
      try await wait("the full item", 15) {
        switch detail.detail(itemId: row.item.id, revision: 0) { case .loading?, nil: false; default: true }
      }
      var full: String?
      if case .loaded(let item)? = detail.detail(itemId: row.item.id, revision: 0), case .commandExecution(let command) = item.body {
        full = command.output
      }
      print("  command “\(streamed.input.prefix(40))”: stream output \(streamed.output.map { "\($0.count) chars" } ?? "absent") omitted=\(streamed.outputOmitted.map(String.init) ?? "nil"), getTurnItem \(full.map { "\($0.count) chars: \($0.prefix(40).replacingOccurrences(of: "\n", with: "⏎"))" } ?? "no output")")
      if full == nil { failures.append("command output") }
    }
    if commands.isEmpty {
      print("  no command items")
      failures.append("no command items")
    }
    registry.closeThread(detail)
  }

  // A socket drop while a turn streams: the thread resumes from its cursor with no gaps or dupes.
  try await withReplayThread(side, scenario: "showcase", runtimeMode: .fullAccess) { threadId, _, _ in
    let ref = ThreadRef(environmentId: environmentId, threadId: threadId)
    let detail = registry.openThread(ref)
    try await wait("streaming text", 40) {
      detail.state.timeline.rows.contains { if case .assistant(let reply) = $0.content { reply.streaming } else { false } }
    }
    let before = await detail.sync.sequence ?? -1
    registry.dropSession(environmentId)
    try await wait("the drop", 10) { !model.status.isConnected }
    print("  dropped the socket mid-stream at seq \(before), phase \(detail.state.phase)")
    try await wait("the reconnect", 30) { model.isShellLive }
    try await wait("the thread live again", 30) { detail.state.phase == .live }
    let resumed = await detail.sync.lastSubscription
    print("  resubscribed with afterSequence \(resumed?.afterSequence.map(String.init) ?? "nil")")
    if resumed?.afterSequence == nil { failures.append("resume cursor") }
    try await wait("the turn to finish", 90) { idle(detail.state) }
    var seen = Set<String>()
    let dupes = detail.state.timeline.rows.filter { !seen.insert($0.id).inserted }.map(\.id)
    let streamed = await detail.sync.projection
    let coldProjection = try await decodedSnapshot(side, threadId: threadId)
    let a = streamed?.visibleTurnItems.map { "\($0.item.id)|\($0.item.body.wireType)" } ?? []
    let b = coldProjection?.visibleTurnItems.map { "\($0.item.id)|\($0.item.body.wireType)" } ?? []
    func replies(_ p: ThreadProjection?) -> [String] {
      p?.visibleTurnItems.compactMap { if case .assistantMessage(let m) = $0.item.body { m.text } else { nil } } ?? []
    }
    let sameText = replies(streamed) == replies(coldProjection)
    print("  after the resume: \(a.count) vs cold \(b.count) items, \(a == b ? "same" : "DIFFERENT"); reply text \(sameText ? "identical" : "DIFFERENT"); duplicate rows \(dupes.count)")
    if a != b || !sameText || !dupes.isEmpty { failures.append("mid-stream resume") }
    registry.closeThread(detail)
  }
  if !failures.isEmpty { throw ProbeFailure(description: "Failed: \(failures)") }
}
