import AnkielKit
import Foundation

/// `--live worktree --repo <git checkout under /tmp>`: the new-thread workspace choice end to end.
/// Adds the checkout as a project, reads its branches, launches a Replay thread through the
/// composer store into a new worktree from the default branch, checks the thread's worktree, then
/// deletes the thread and the project. Never point it at a real checkout.
@MainActor
func liveWorktree(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  guard let repo = argument("--repo"), repo.hasPrefix("/tmp/") || repo.hasPrefix("/private/tmp/") else {
    throw ProbeFailure(description: "Pass --repo with a throwaway Git checkout under /tmp.")
  }
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-worktree-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "Not adopted.") }
  let store = ComposerStore(directory: directory.appending(path: "composer"), sink: registry)
  await store.load()
  func wait(_ what: String, _ seconds: Double, _ done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell", 60) { model.isShellLive }

  let side = try await connector.connect(environment)
  let projectId = UUID().uuidString.lowercased()
  let threadId = UUID().uuidString.lowercased()
  _ = try await side.rpc.call(
    "projects.mutate",
    payload: JSONValue.object([
      "type": "project.create", "commandId": .string(UUID().uuidString.lowercased()), "projectId": .string(projectId),
      "title": "ankiel-probe worktree", "workspaceRoot": .string(repo),
    ]), as: JSONValue.self)
  print("project: \(projectId) at \(repo)")
  do {
    let list = try await registry.workspaceRefs(cwd: repo, in: model.id)
    print("refs: isRepo=\(list.isRepo.map(String.init) ?? "?") \(list.refs.map { "\($0.name)\($0.current ? "*" : "")\($0.isDefault ? "(default)" : "")" })")
    let resolved = NewThreadWorkspace.resolve(
      draft: NewThreadWorkspace(mode: .worktree), remembered: nil, defaultMode: .local, isGitRepo: list.isRepo ?? true, refs: list.refs,
      settingsStartFromOrigin: false)
    guard let launch = resolved.launch else { throw ProbeFailure(description: "No base branch resolved.") }
    print("launching with \(launch)")
    let key = "new:\(model.id)"
    store.updateDraft(key) { $0.workspace = NewThreadWorkspace(mode: .worktree) }
    store.setText("Work in a new worktree", for: key)
    let ref = ThreadRef(environmentId: model.id, threadId: threadId)
    guard let sent = store.send(
      key, to: ref, delivery: .start,
      thread: .init(modelSelection: ModelSelection(instanceId: "devReplay", model: "showcase"), runtimeMode: .fullAccess, interactionMode: nil),
      creation: .init(projectId: projectId, title: "probe worktree", workspace: launch))
    else { throw ProbeFailure(description: "The launch did not enter the outbox.") }
    try await wait("the launch to be accepted", 60) {
      if case .sent = store.outbox.first(where: { $0.messageId == sent.messageId })?.state { true } else { false }
    }
    try await wait("the thread's worktree", 60) { model.shell.threads.first { $0.id == threadId }?.worktreePath != nil }
    let row = model.shell.threads.first { $0.id == threadId }
    let path = row?.worktreePath ?? ""
    print("thread worktree: \(path) branch \(row?.branch ?? "-") exists=\(FileManager.default.fileExists(atPath: path))")
    print("remembered for the project: \(store.rememberedWorkspace(environmentId: model.id, projectId: projectId).map { "\($0.mode)" } ?? "none")")
  } catch {
    await cleanUpWorktreeProbe(side, threadId: threadId, projectId: projectId)
    throw error
  }
  await cleanUpWorktreeProbe(side, threadId: threadId, projectId: projectId)
}

private func cleanUpWorktreeProbe(_ side: EnvironmentSession, threadId: String, projectId: String) async {
  await deleteThread(side, threadId)
  do {
    _ = try await side.rpc.call(
      "projects.mutate",
      payload: JSONValue.object(["type": "project.delete", "commandId": .string(UUID().uuidString.lowercased()), "projectId": .string(projectId), "force": true]),
      as: JSONValue.self)
    print("cleanup: deleted project \(projectId)")
  } catch {
    print("cleanup: project delete failed: \(error)")
  }
  await side.close()
}
