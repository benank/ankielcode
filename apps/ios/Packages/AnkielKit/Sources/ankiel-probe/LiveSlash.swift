import AnkielKit
import Foundation

/// `--live slash`: the composer's commands against Replay. Lists the slash menu for the Replay
/// provider (the config stream adds `/usage-limits` because the app opts in), then launches a thread,
/// arms `/clear` the way the composer does and checks the next message reached the server as a
/// fresh session. Deletes its thread.
@MainActor
func liveSlash(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-slash-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "Not adopted.") }
  let store = ComposerStore(directory: directory.appending(path: "composer"), sink: registry)
  await store.load()

  func wait(_ what: String, _ seconds: Double = 60, _ done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell") { model.isShellLive }
  let replay = model.providers.first { $0.driver == "devReplay" }
  for provider in model.providers {
    print("slash \(provider.instanceId): \(provider.slashCommands.map(\.name)) skills \(provider.skills.count) snapshots \(provider.workspaceSnapshots.map(\.cwd))")
  }
  let menu = ComposerSlashMenu.slashItems(
    query: "", atMessageStart: true, context: .init(hasThread: true, offersUsageLimits: true, offersFreshSession: true), provider: replay,
    cwd: nil)
  print("menu for Replay: \(menu.map(\.label))")
  print("freshContext capability: \(model.capabilities["freshContext"]?.boolValue == true)")

  let side = try await connector.connect(environment)
  let threadId = UUID().uuidString.lowercased()
  do {
    try await clearRoundTrip(side, threadId: threadId, model: model, registry: registry, store: store, wait: wait)
  } catch {
    await deleteThread(side, threadId)
    await side.close()
    throw error
  }
  await deleteThread(side, threadId)
  await side.close()
}

@MainActor
private func clearRoundTrip(
  _ side: EnvironmentSession, threadId: String, model: EnvironmentModel, registry: EnvironmentRegistry, store: ComposerStore,
  wait: (String, Double, () -> Bool) async throws -> Void
) async throws {
  let projectId = try await probeProject(side)
  let ref = ThreadRef(environmentId: model.id, threadId: threadId)
  let newKey = "new:\(model.id)"
  store.setText("First message before a clear", for: newKey)
  let settings = ComposerStore.ThreadSettings(
    modelSelection: ModelSelection(instanceId: "devReplay", model: "showcase"), runtimeMode: .fullAccess, interactionMode: nil)
  guard let launched = store.send(newKey, to: ref, delivery: .start, thread: settings, creation: .init(projectId: projectId, title: "probe slash"))
  else { throw ProbeFailure(description: "The launch did not enter the outbox.") }
  try await wait("the launch to be accepted", 30) {
    if case .sent = store.outbox.first(where: { $0.messageId == launched.messageId })?.state { true } else { false }
  }
  let detail = registry.openThread(ref)
  defer { registry.closeThread(detail) }
  try await wait("the first turn", 120) { idle(detail.state) && !detail.state.timeline.rows.isEmpty }

  // What `/clear` does in the composer: arm the draft, then the next message carries it.
  store.updateDraft(ref.key) { $0.freshContext = true }
  store.setText("After the clear", for: ref.key)
  let row = model.shell.threads.first { $0.id == threadId }
  guard let sent = store.send(ref.key, to: ref, delivery: .start, thread: .init(modelSelection: row?.modelSelection, runtimeMode: nil, interactionMode: nil))
  else { throw ProbeFailure(description: "The message did not enter the outbox.") }
  print("outbox freshContext=\(sent.freshContext == true), draft disarmed=\(store.draft(ref.key).freshContext == nil)")
  try await wait("the fresh message on the server", 90) {
    detail.state.timeline.rows.contains { if case .user(let user) = $0.content { user.text == "After the clear" && user.freshContext } else { false } }
  }
  print("server: the message after /clear is a fresh session (the feed shows its \"New session\" divider)")
}
