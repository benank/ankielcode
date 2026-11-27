import AnkielKit
import Foundation
import Synchronization

/// A socket that loses the reply to the first `message.dispatch` whose text contains `marker`, as
/// if the connection hiccuped after the server committed it.
final class ReplyDropper: RpcTransport, @unchecked Sendable {
  final class State: Sendable {
    let mutex = Mutex<(target: String?, dropped: Bool, dispatches: [String])>((nil, false, []))
  }

  let base: any RpcTransport
  let marker: String
  let state = State()
  let incoming: AsyncThrowingStream<String, any Error>

  init(_ base: any RpcTransport, marker: String) {
    self.base = base
    self.marker = marker
    let state = state
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: String.self)
    incoming = stream
    Task {
      do {
        for try await text in base.incoming {
          let drop = state.mutex.withLock { s -> Bool in
            guard !s.dropped, let target = s.target, let (tag, id) = FrameTap.header(text), tag == "Exit", id == target else { return false }
            s.dropped = true
            return true
          }
          if !drop { continuation.yield(text) }
        }
        continuation.finish()
      } catch {
        continuation.finish(throwing: error)
      }
    }
  }

  func send(_ text: String) async throws {
    if text.contains("\"message.dispatch\""), text.contains(marker),
      let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    {
      let id = (object["id"] as? String) ?? (object["id"] as? Int).map(String.init) ?? ""
      let commandId = ((object["payload"] as? [String: Any])?["commandId"] as? String) ?? "?"
      state.mutex.withLock { s in
        if s.target == nil { s.target = id }
        s.dispatches.append(commandId)
      }
    }
    try await base.send(text)
  }

  func close() async { await base.close() }
}

final class DropperSlot: Sendable {
  let slot = Mutex<ReplyDropper?>(nil)
}

/// `--live composer`: the real registry and composer store against the server.
@MainActor
func liveComposer(_ environment: SavedEnvironment, connector base: EnvironmentConnector) async throws {
  var connector = base
  let dropper = DropperSlot()
  connector.transportTap = { transport in
    let wrapped = ReplyDropper(transport, marker: "[drop-reply]")
    dropper.slot.withLock { $0 = wrapped }
    return wrapped
  }
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-composer-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "Not adopted.") }
  let store = ComposerStore(directory: directory.appending(path: "composer"), sink: registry)
  await store.load()
  store.sendTimeout = .seconds(4)
  store.retryDelay = { _ in .milliseconds(300) }

  func wait(_ what: String, _ seconds: Double = 60, _ done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell") { model.isShellLive }
  let environmentId = model.id
  print("composer: live, \(model.shell.threads.count) threads")

  // A side session for setup and checks that should not go through the app objects.
  let side = try await base.connect(environment)
  let projectId = try await probeProject(side)

  // New thread with an image and a file, launched through the outbox (upload → launch).
  let threadId = UUID().uuidString.lowercased()
  let ref = ThreadRef(environmentId: environmentId, threadId: threadId)
  let newKey = "new:\(environmentId)"
  let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
  let text = Data("probe attachment \(UUID().uuidString)\n".utf8)
  store.setText("Look at these files.", for: newKey)
  let image = try await store.addAttachment(png, name: "pixel.png", mimeType: "image/png", kind: .image, to: newKey, environmentId: environmentId)
  let file = try await store.addAttachment(text, name: "notes.txt", mimeType: "text/plain", kind: .file, to: newKey, environmentId: environmentId)
  try await wait("uploads", 30) {
    [image, file].allSatisfy { if case .ready? = store.uploadState($0, environmentId: environmentId) { true } else { false } }
  }
  print("  uploaded image and file before sending")
  let settings = ComposerStore.ThreadSettings(
    modelSelection: ModelSelection(instanceId: "devReplay", model: "showcase"), runtimeMode: .fullAccess, interactionMode: nil)
  guard let launched = store.send(newKey, to: ref, delivery: .start, thread: settings, creation: .init(projectId: projectId, title: "probe composer"))
  else { throw ProbeFailure(description: "The launch did not enter the outbox.") }
  try await wait("the launch to be accepted", 30) { if case .sent = store.outbox.first(where: { $0.messageId == launched.messageId })?.state { true } else { false } }
  print("  launched \(threadId) through the outbox")

  let detail = registry.openThread(ref)
  defer { registry.closeThread(detail) }
  func finished() -> Bool { idle(detail.state) }
  try await wait("the first turn", 90) { finished() }
  var failures: [String] = []
  let firstUser = detail.state.timeline.rows.compactMap { if case .user(let row) = $0.content { row } else { nil } }.first
  print("  first message attachments: \(firstUser?.attachments.map { "\($0.type):\($0.name)" } ?? [])")
  for attachment in firstUser?.attachments ?? [] {
    do {
      let url = try await registry.assetURL(.attachment(id: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType), in: environmentId)
      let (data, response) = try await URLSession.shared.data(from: url)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let expected = attachment.type == "image" ? png : text
      print("    GET \(attachment.name): HTTP \(status), \(data.count) bytes, \(data == expected ? "same bytes" : "DIFFERENT bytes")")
      if status != 200 || data != expected { failures.append("asset \(attachment.name)") }
    } catch {
      print("    asset \(attachment.name) failed: \(error)")
      failures.append("asset \(attachment.name)")
    }
  }
  if firstUser?.attachments.count != 2 { failures.append("attachments on the first message") }

  let threadKey = ref.key
  func userTexts() -> [String] {
    detail.state.timeline.rows.compactMap { if case .user(let row) = $0.content { row.text } else { nil } }
  }
  func send(_ text: String, _ delivery: MessageDelivery, runtimeMode: RuntimeMode? = nil) -> OutboxMessage? {
    store.setText(text, for: threadKey)
    if let runtimeMode { store.updateDraft(threadKey) { $0.runtimeMode = runtimeMode } }
    let row = model.shell.threads.first { $0.id == threadId }
    return store.send(
      threadKey, to: ref, delivery: delivery,
      thread: .init(modelSelection: row?.modelSelection, runtimeMode: row?.runtimeMode.known, interactionMode: row?.interactionMode.known))
  }

  // A dropped reply: the store times out, resends the same command id, and the server keeps one message.
  let dropText = "Second message [drop-reply]"
  _ = send(dropText, .start)
  try await wait("the dropped send to be resent and accepted", 30) {
    store.outbox.contains { $0.text == dropText && { if case .sent = $0.state { true } else { false } }($0) }
  }
  let dispatches = dropper.slot.withLock { $0?.state.mutex.withLock { $0.dispatches } } ?? []
  try await wait("the turn after the dropped reply", 90) { finished() && userTexts().contains(dropText) }
  let copies = userTexts().filter { $0 == dropText }.count
  print("  dropped reply: sent \(dispatches.count)× with command ids \(Set(dispatches).count == 1 ? "all equal" : "DIFFERENT"); \(copies) message(s) on the server")
  if copies != 1 || Set(dispatches).count != 1 || dispatches.count < 2 { failures.append("dropped reply retry") }

  // Settings before a message: the draft's permission mode goes first under a derived command id.
  _ = send("Third message with approval required", .start, runtimeMode: .approvalRequired)
  try await wait("the runtime mode to land on the row", 30) {
    model.shell.threads.first { $0.id == threadId }?.runtimeMode.known == .approvalRequired
  }
  print("  runtime mode applied before the message: \(model.shell.threads.first { $0.id == threadId }?.runtimeMode.rawValue ?? "?")")
  // Answer the approvals this turn raises, then let it finish.
  let sink = SessionRequestSink(side)
  let controller = PendingRequestController(sink: sink)
  let deadline = Date.now.addingTimeInterval(90)
  while !finished(), Date.now < deadline {
    for approval in detail.state.pending.approvals {
      _ = await controller.approve(approval, decision: "accept", label: "Allow once", thread: ref)
    }
    try await Task.sleep(for: .milliseconds(100))
  }
  try await dispatch(side, .setRuntimeMode(.fullAccess), threadId)

  // Model change on a started thread (`thread.model-selection.set`).
  let multi = ModelSelection(instanceId: "devReplay", model: "multi-turn")
  _ = try await registry.dispatch(ThreadCommand(.setModelSelection(multi), threadId: threadId), in: environmentId)
  try await wait("the model to land on the row", 20) { model.shell.threads.first { $0.id == threadId }?.modelSelection.model == "multi-turn" }
  print("  model change applied: \(model.shell.threads.first { $0.id == threadId }?.modelSelection.model ?? "?")")
  try await dispatch(side, .setModelSelection(ModelSelection(instanceId: "devReplay", model: "showcase")), threadId)
  try await wait("the model back", 20) { model.shell.threads.first { $0.id == threadId }?.modelSelection.model == "showcase" }

  // While running: steer (Replay cannot steer, so the server queues it) and queue, then edit and
  // remove queued messages.
  _ = send("Run again", .start)
  try await wait("the next turn to run", 30) { detail.state.activity.isRunning && !detail.state.activity.isSettingUp }
  _ = send("Steer: also mention tests", .steer)
  _ = send("Queued: then summarize", .queue)
  try await wait("two queued messages", 30) { detail.state.activity.queued.count >= 2 }
  print("  while running: active \(detail.state.activity.activeRunId ?? "none") queued \(detail.state.activity.queued.map(\.text)); users \(userTexts().suffix(3)); outbox \(store.outbox.suffix(3).map { "\($0.text): \($0.state)" })")
  if let runs = await detail.sync.projection?.runs.suffix(4) {
    for run in runs { print("    run \(run.id.suffix(10)) \(run.status.rawValue) msg \(run.userMessageId?.prefix(8) ?? "-")") }
  }
  if let first = detail.state.activity.queued.first {
    _ = try await registry.dispatch(ThreadCommand(.editQueuedRun(runId: first.runId, text: "Edited: mention tests"), threadId: threadId), in: environmentId)
    try await wait("the edit", 20) { detail.state.activity.queued.first?.text == "Edited: mention tests" }
    print("  edited the first queued message")
  }
  if let last = detail.state.activity.queued.last {
    _ = try await registry.dispatch(ThreadCommand(.cancelQueuedRun(runId: last.runId), threadId: threadId), in: environmentId)
    try await wait("the removal", 20) { !detail.state.activity.queued.contains { $0.runId == last.runId } }
    print("  removed the last queued message; queue now \(detail.state.activity.queued.map(\.text))")
  }
  _ = try await registry.dispatch(ThreadCommand(.stop, threadId: threadId), in: environmentId)
  try await wait("the stop", 30) { !detail.state.activity.isRunning || detail.state.activity.queueHeld }
  print("  stopped: running \(detail.state.activity.isRunning), queue held \(detail.state.activity.queueHeld), queued \(detail.state.activity.queued.count), status \(detail.state.timeline.status)")
  for queued in detail.state.activity.queued {
    _ = try? await registry.dispatch(ThreadCommand(.cancelQueuedRun(runId: queued.runId), threadId: threadId), in: environmentId)
  }
  try await wait("the thread to go idle", 60) { !detail.state.activity.isRunning && detail.state.activity.queued.isEmpty }

  // Offline: a send with no connection waits in the outbox and goes once the computer is back.
  registry.dropSession(environmentId)
  try await wait("the drop", 10) { !model.status.isConnected }
  let offlineText = "Sent while offline"
  _ = send(offlineText, .start)
  let queuedOffline = store.outbox.first { $0.text == offlineText }?.state
  print("  offline: outbox state \(queuedOffline.map { "\($0)" } ?? "none")")
  try await wait("the reconnect", 30) { model.isShellLive }
  try await wait("the offline message to reach the thread", 60) { userTexts().contains(offlineText) }
  print("  offline message delivered after the reconnect")
  try await wait("the last turn", 90) { finished() }
  print("  final rows: \(describeRows(detail.state)); user messages \(userTexts())")

  await deleteThread(side, threadId)
  await side.close()
  withExtendedLifetime(sink) {}
  if !failures.isEmpty { throw ProbeFailure(description: "Failed: \(failures)") }
}
