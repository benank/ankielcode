import AnkielKit
import Foundation
import Synchronization

/// Counts the raw RPC frames on one socket: chunks the server sent per request, acks and
/// interrupts the client sent, and exits that arrived after the client interrupted.
final class FrameTap: RpcTransport, @unchecked Sendable {
  struct Counts: Sendable {
    var chunks: [String: Int] = [:]
    var acks: [String: Int] = [:]
    var interrupted: Set<String> = []
    var exitsAfterInterrupt: [String: String] = [:]
    var largestFrame = 0
    var partFrames = 0
  }

  final class Box: Sendable {
    let mutex = Mutex(Counts())
    func withLock<R>(_ body: (inout Counts) -> R) -> R { mutex.withLock { body(&$0) } }
  }

  let base: any RpcTransport
  let counts = Box()
  let incoming: AsyncThrowingStream<String, any Error>

  init(_ base: any RpcTransport) {
    self.base = base
    let counts = counts
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: String.self)
    incoming = stream
    Task {
      do {
        for try await text in base.incoming {
          counts.withLock { c in
            c.largestFrame = max(c.largestFrame, text.utf8.count)
            if !text.hasPrefix("{") && !text.hasPrefix("[") { c.partFrames += 1 }
            if let (tag, id) = Self.header(text) {
              if tag == "Chunk" { c.chunks[id, default: 0] += 1 }
              if tag == "Exit", c.interrupted.contains(id) {
                c.exitsAfterInterrupt[id] = String(text.prefix(300))
              }
            }
          }
          continuation.yield(text)
        }
        continuation.finish()
      } catch {
        continuation.finish(throwing: error)
      }
    }
  }

  static func header(_ text: String) -> (String, String)? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
      let tag = object["_tag"] as? String
    else { return nil }
    let id = (object["requestId"] as? String) ?? (object["requestId"] as? Int).map(String.init) ?? ""
    return (tag, id)
  }

  func send(_ text: String) async throws {
    if let (tag, id) = Self.header(text) {
      counts.withLock { c in
        if tag == "Ack" { c.acks[id, default: 0] += 1 }
        if tag == "Interrupt" { c.interrupted.insert(id) }
      }
    }
    try await base.send(text)
  }

  func close() async { await base.close() }
}

/// Feeds a `ThreadDetailSync` from a plain session (the app goes through its supervisor).
struct SessionItemSource: ThreadItemSource {
  let session: EnvironmentSession
  func threadItems(_ subscription: ThreadSubscription) async throws -> RpcStream<ThreadStreamItem> {
    try await session.rpc.stream(ThreadSubscription.rpcTag, payload: subscription, of: ThreadStreamItem.self)
  }
}

/// Watches a sync's published states and checks streaming invariants as they arrive.
actor TurnWatcher {
  var last = ThreadDetailState()
  var states = 0
  var sawWorking = false
  var sawWorkRow = false
  var streamingSamples = 0
  var textRegressions: [String] = []
  var assistantText: [String: String] = [:]
  var phases: [String] = []
  var statuses: [String] = []
  var duplicateRowIds: [String] = []

  func observe(_ state: ThreadDetailState) {
    states += 1
    last = state
    let phase = "\(state.phase)"
    if phases.last != phase { phases.append(phase) }
    let status = "\(state.timeline.status)"
    if statuses.last != status { statuses.append(status) }
    if state.timeline.status == .working { sawWorking = true }
    var ids = Set<String>()
    for row in state.timeline.rows {
      if !ids.insert(row.id).inserted { duplicateRowIds.append(row.id) }
      switch row.content {
      case .work, .workGroup: sawWorkRow = true
      case .assistant(let reply):
        if reply.streaming { streamingSamples += 1 }
        if let before = assistantText[reply.messageId], !reply.text.hasPrefix(before) {
          textRegressions.append("\(reply.messageId): \(before.count) → \(reply.text.count) chars, not a prefix")
        }
        assistantText[reply.messageId] = reply.text
      default: break
      }
    }
  }

  func until(_ seconds: Double, _ what: String, _ done: @Sendable (ThreadDetailState) -> Bool) async throws -> ThreadDetailState {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done(last) {
      guard Date.now < deadline else {
        throw ProbeFailure(description: "Timed out waiting for \(what); phase \(last.phase), status \(last.timeline.status), rows \(last.timeline.rows.count)")
      }
      try await Task.sleep(for: .milliseconds(50))
    }
    return last
  }
}

func follow(_ sync: ThreadDetailSync, into watcher: TurnWatcher) -> Task<Void, Never> {
  Task {
    for await state in sync.states { await watcher.observe(state) }
  }
}

func describeRows(_ state: ThreadDetailState) -> String {
  var kinds: [String: Int] = [:]
  for row in state.timeline.rows { kinds[rowKind(row.content), default: 0] += 1 }
  return kinds.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
}

/// A Replay thread in the scratch project ("No project"), launched the way the composer does.
func launchReplayThread(
  _ session: EnvironmentSession, scenario: String, text: String = "go", runtimeMode: RuntimeMode = .approvalRequired
) async throws -> (ThreadLaunchResult, ThreadLaunch) {
  let projectId = try await probeProject(session)
  let launch = ThreadLaunch(
    commandId: CommandID(), threadId: UUID().uuidString.lowercased(), projectId: projectId, title: "probe \(scenario)",
    modelSelection: ModelSelection(instanceId: "devReplay", model: scenario), runtimeMode: runtimeMode,
    messageId: UUID().uuidString.lowercased(), text: text)
  let result = try await session.rpc.call(ThreadLaunch.rpcTag, payload: launch, as: ThreadLaunchResult.self)
  return (result, launch)
}

func deleteThread(_ session: EnvironmentSession, _ threadId: String) async {
  do {
    _ = try await session.rpc.call(ThreadCommand.rpcTag, payload: ThreadCommand(.delete, threadId: threadId), as: DispatchResult.self)
    print("cleanup: deleted \(threadId)")
  } catch {
    print("cleanup: delete \(threadId) failed: \(error)")
  }
}

/// `--live turn`: launch → stream → approval → completion → a follow-up → delete.
func liveTurn(_ session: EnvironmentSession, tap: FrameTap, scenario: String) async throws {
  var created: String?
  do {
    try await liveTurnBody(session, tap: tap, scenario: scenario) { created = $0 }
  } catch {
    if let created { await deleteThread(session, created) }
    throw error
  }
  if let created { await deleteThread(session, created) }
}

func liveTurnBody(
  _ session: EnvironmentSession, tap: FrameTap, scenario: String, created: (String) -> Void
) async throws {
  let (result, launch) = try await launchReplayThread(session, scenario: scenario)
  let threadId = result.threadId
  created(threadId)
  print("launched \(threadId) seq \(result.sequence ?? -1), projection \(result.projection == nil ? "absent" : "present")")

  // Retrying the launch with the same command id must not create a second thread or message.
  let replay = try await session.rpc.call(ThreadLaunch.rpcTag, payload: launch, as: ThreadLaunchResult.self)
  print("launch retry (same commandId): thread \(replay.threadId == threadId ? "same" : "DIFFERENT \(replay.threadId)"), seq \(replay.sequence ?? -1)")

  let sync = ThreadDetailSync(threadId: threadId)
  if let projection = result.projection, let sequence = result.sequence { await sync.seed(projection, sequence: sequence) }
  let watcher = TurnWatcher()
  let feed = follow(sync, into: watcher)
  defer { feed.cancel() }
  await sync.attach(SessionItemSource(session: session))

  var answered = Set<String>()
  let deadline = Date.now.addingTimeInterval(90)
  while Date.now < deadline {
    let state = await watcher.last
    for approval in state.pending.approvals where !answered.contains(approval.requestId) {
      answered.insert(approval.requestId)
      print("approval \(approval.requestKind) live=\(approval.isLive) feedback=\(approval.supportsFeedback): \(approval.detail?.prefix(60) ?? "")")
      let command = RequestCommand(.decision("accept"), threadId: threadId, requestId: approval.requestId)
      let sequence = try await session.rpc.call(ThreadCommand.rpcTag, payload: command, as: DispatchResult.self).sequence
      print("  accepted, seq \(sequence)")
    }
    if state.phase == .live, state.timeline.status == .idle, state.revision > 1, !state.activity.isRunning,
      await watcher.sawWorking
    {
      break
    }
    try await Task.sleep(for: .milliseconds(100))
  }
  let done = await watcher.last
  print("turn: phases \(await watcher.phases) statuses \(await watcher.statuses)")
  print("  rows: \(describeRows(done)); streaming samples \(await watcher.streamingSamples); work rows \(await watcher.sawWorkRow)")
  print("  states published \(await watcher.states), skipped items \(await sync.skippedCount)")
  let regressions = await watcher.textRegressions
  let duplicates = await watcher.duplicateRowIds
  if !regressions.isEmpty { print("  ✗ text regressions: \(regressions.prefix(3))") }
  if !duplicates.isEmpty { print("  ✗ duplicate row ids: \(Set(duplicates).prefix(3))") }
  if case .assistant(let last)? = done.timeline.rows.last(where: { if case .assistant = $0.content { true } else { false } })?.content {
    print("  last reply (\(last.text.count) chars, footer \(last.footer?.rawValue ?? "none")): \(last.text.prefix(80).replacingOccurrences(of: "\n", with: " "))")
  }

  // Compare the streamed projection with a cold snapshot of the same thread.
  let cold = try await decodedSnapshot(session, threadId: threadId)
  let streamed = await sync.projection
  let coldKinds = cold?.visibleTurnItems.map(\.item.body.wireType) ?? []
  let streamedKinds = streamed?.visibleTurnItems.map(\.item.body.wireType) ?? []
  print("  streamed vs cold: \(streamedKinds.count) vs \(coldKinds.count) items, \(streamedKinds == coldKinds ? "same kinds in order" : "DIFFERENT")")
  if streamedKinds != coldKinds { print("    streamed \(streamedKinds)\n    cold     \(coldKinds)") }
  let coldTimeline = cold.map { ThreadTimelineBuilder.build($0, markdown: MarkdownParser()) }
  if let coldTimeline {
    let same = coldTimeline.rows.map(\.id) == done.timeline.rows.map(\.id)
    print("  timeline rows streamed vs cold: \(done.timeline.rows.count) vs \(coldTimeline.rows.count) \(same ? "same ids" : "DIFFERENT ids")")
  }

  let counts = tap.counts.withLock { $0 }
  let streamChunks = counts.chunks.values.max() ?? 0
  let busiest = counts.chunks.max { $0.value < $1.value }?.key ?? ""
  print("frames: busiest stream \(busiest) got \(streamChunks) chunks, client acked \(counts.acks[busiest] ?? 0); largest frame \(counts.largestFrame / 1024) KB; part frames \(counts.partFrames)")
  await sync.detach()
  if !regressions.isEmpty || !duplicates.isEmpty || streamedKinds != coldKinds {
    throw ProbeFailure(description: "The streamed turn differs from the server.")
  }
}

let probeProjectTitle = "ankiel-probe live"
let probeProjectRoot = "/tmp/ankiel-live/probe-project"

/// The probe's own project (a folder outside any repository), created on first use. The dev
/// server refuses "No project" threads when its home sits inside a Git checkout.
func probeProject(_ session: EnvironmentSession) async throws -> String {
  let shell = try await shellSnapshot(session)
  if let existing = shell.projects.first(where: { $0.title == probeProjectTitle }) { return existing.id }
  let projectId = UUID().uuidString.lowercased()
  let mutation: JSONValue = .object([
    "type": .string("project.create"), "commandId": .string(UUID().uuidString.lowercased()),
    "projectId": .string(projectId), "title": .string(probeProjectTitle),
    "workspaceRoot": .string(probeProjectRoot), "createWorkspaceRootIfMissing": .bool(true),
  ])
  _ = try await session.rpc.call("projects.mutate", payload: mutation, as: JSONValue.self)
  print("created project \(probeProjectTitle) \(projectId)")
  return projectId
}

/// `--live cleanup`: deletes the probe project and every thread left in it.
func liveCleanup(_ session: EnvironmentSession) async throws {
  let shell = try await shellSnapshot(session)
  guard let project = shell.projects.first(where: { $0.title == probeProjectTitle }) else {
    print("cleanup: no probe project")
    return
  }
  for thread in shell.threads + shell.archivedThreads where thread.projectId == project.id {
    await deleteThread(session, thread.id)
  }
  let mutation: JSONValue = .object([
    "type": .string("project.delete"), "commandId": .string(UUID().uuidString.lowercased()),
    "projectId": .string(project.id), "force": .bool(true),
  ])
  _ = try await session.rpc.call("projects.mutate", payload: mutation, as: JSONValue.self)
  print("cleanup: deleted project \(project.id)")
}
