import AnkielKit
import Foundation

// ankiel-probe: pair (or reuse a saved credential), connect, start the session, read the shell,
// print a summary and exit 0. Proof that the wire layer works against a live server.

struct ProbeFailure: Error, CustomStringConvertible {
  let description: String
}

func argument(_ name: String) -> String? {
  let arguments = CommandLine.arguments
  guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
  return arguments[index + 1]
}

func describe(_ item: ShellStreamItem) -> String {
  switch item {
  case .synchronized: "synchronized"
  case .snapshotRequired: "snapshot-required"
  case .snapshot(let snapshot, let roots):
    "snapshot seq=\(snapshot.snapshotSequence) threads=\(snapshot.threads.count) projects=\(snapshot.projects.count) ~\((try? JSONEncoder().encode(snapshot).count) ?? 0) bytes"
      + (roots.map { " resolvedRoots=\($0.count)" } ?? " (authoritative)")
  case .delta(let delta): "delta seq=\(delta.sequence)"
  case .unknown(let kind): "unknown \(kind)"
  case .undecodable(let kind, let reason): "undecodable \(kind): \(reason)"
  }
}

func run() async throws {
  if let file = argument("--claim-invite") {
    try await probeClaimInvite(file)
    return
  }
  let pairURL = argument("--pair-url")
  let statePath = argument("--state")
  guard pairURL != nil || statePath != nil else {
    throw ProbeFailure(description: "usage: ankiel-probe [--pair-url <url>] [--state <file>] [--force-renew] [--trace] [--supervise | --stale-resume]")
  }
  let store: any CredentialStore =
    if let statePath { try FileCredentialStore(url: URL(filePath: statePath)) } else { InMemoryCredentialStore() }
  let connector = EnvironmentConnector(
    store: store,
    client: ClientIdentity(
      label: "ankiel-probe", deviceType: .desktop, os: "macOS", appVersion: "0.0.1-probe"))

  let environment: SavedEnvironment
  if let pairURL {
    let target = try PairingInput.resolve(pairURL)
    let paired = try await connector.pair(target)
    environment = paired
    try store.set(paired, for: "environment")
    let kind = if case .dpop? = try connector.loadCredential(paired.environmentId) { "DPoP" } else { "bearer" }
    let hardware = (try? store.data(for: CredentialKeys.keyKind(paired.environmentId))) != nil
    print("paired:            \(paired.label) via \(paired.endpoint.httpBaseURL.absoluteString) (\(kind)\(hardware ? ", Secure Enclave key" : ""))")
  } else if let saved = try store.value(SavedEnvironment.self, for: "environment") {
    environment = saved
    print("reusing:           \(saved.label) via \(saved.endpoint.httpBaseURL.absoluteString)")
  } else {
    throw ProbeFailure(description: "No saved environment in the state file; pass --pair-url.")
  }

  if CommandLine.arguments.contains("--force-renew"),
    let credential = try connector.loadCredential(environment.environmentId), case .dpop = credential
  {
    let renewed = try await connector.renew(
      credential, environmentId: environment.environmentId, endpoint: environment.endpoint)
    if case .dpop(_, let expiresAt) = renewed { print("renewed:           expires \(expiresAt.formatted(.iso8601))") }
  }

  if CommandLine.arguments.contains("--supervise") {
    try await supervise(environment, connector: connector)
    return
  }
  if CommandLine.arguments.contains("--routes") {
    try await probeRoutes(environment, connector: connector)
    return
  }
  if CommandLine.arguments.contains("--stale-resume") {
    try await staleResume(environment, connector: connector)
    return
  }
  if CommandLine.arguments.contains("--pair-invite") {
    try await probePairInvite(environment, connector: connector)
    return
  }
  if let mode = argument("--live") {
    try await live(mode, environment: environment, connector: connector)
    return
  }

  let session = try await connector.connect(environment)
  let config = session.initialConfig
  if let rawPath = argument("--raw-shell") {
    try await dumpRawShell(session, to: rawPath)
    await session.close()
    return
  }
  if let cwd = argument("--files") {
    try await probeFiles(session, base: environment.endpoint.httpBaseURL, cwd: cwd)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--usage-summary") {
    try await probeUsageSummary(session)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--streaming-setting") {
    try await probeStreamingSetting(session)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--access") {
    try await probeAccess(session, environment: environment, connector: connector)
    await session.close()
    return
  }
  if let value = argument("--set-github") {
    // Sets the computer's GitHub integration and leaves it (for the live Issues gate test).
    let before = session.initialConfig.settings.githubIntegrationEnabled
    let after = try await session.rpc.call(
      UpdateSettingsRequest.rpcTag, payload: UpdateSettingsRequest(patch: .githubIntegration(value == "on")), as: ServerSettings.self)
    print("github integration: \(before ? "on" : "off") -> \(after.githubIntegrationEnabled ? "on" : "off")")
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--issues") {
    // `--enable-github` turns the computer's GitHub integration on for this read, then restores it.
    let before = session.initialConfig.settings.githubIntegrationEnabled
    let capable = session.initialConfig.environment.capabilities["issues"]?.boolValue == true
    print("github integration: \(before ? "on" : "off"), capabilities.issues: \(capable) -> Issues \(before && capable ? "shown" : "hidden")")
    let toggle = CommandLine.arguments.contains("--enable-github") && !before
    if toggle {
      _ = try await session.rpc.call(UpdateSettingsRequest.rpcTag, payload: UpdateSettingsRequest(patch: .githubIntegration(true)), as: ServerSettings.self)
      print("github integration: on for this read")
    }
    do {
      try await probeIssues(session)
    } catch {
      print("probe error: \(error)")
    }
    if toggle {
      _ = try await session.rpc.call(UpdateSettingsRequest.rpcTag, payload: UpdateSettingsRequest(patch: .githubIntegration(false)), as: ServerSettings.self)
      print("github integration: restored to off")
    }
    await session.close()
    return
  }
  if argument("--workflow-setup") != nil || argument("--workflow-teardown") != nil {
    try await probeWorkflowSetup(session, file: argument("--workflow-setup"), teardown: argument("--workflow-teardown"))
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--scheduled-tasks") {
    try await probeScheduledTasks(session)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--workflows") {
    try await probeWorkflows(session)
    await session.close()
    return
  }
  if let url = argument("--preview-seed") {
    try await probePreviewSeed(session, url: url)
    await session.close()
    return
  }
  if let threadId = argument("--preview-delete") {
    await deleteThread(session, threadId)
    await session.close()
    return
  }
  if let port = argument("--preview-tunnel").flatMap(UInt16.init) {
    try await probePreviewTunnel(session, environment: environment, connector: connector, port: port)
    await session.close()
    return
  }
  if let threadId = argument("--terminal-list") {
    try await probeTerminalList(session, threadId: threadId)
    await session.close()
    return
  }
  if let cwd = argument("--terminal") {
    try await probeTerminal(session, cwd: cwd)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--rows") {
    try await printRows(session)
    await session.close()
    return
  }
  if let cwd = argument("--git-pull") {
    let status = try await ReviewCalls.status(cwd: cwd, via: session.rpc)
    print("  before: behind=\(status.behindCount) quick=\(GitActionRules.quickAction(status, busy: false))")
    let pulled = try await ReviewCalls.pull(cwd: cwd, via: session.rpc)
    print("  pull: \(pulled.status) on \(pulled.refName)")
    await session.close()
    return
  }
  if let ids = argument("--git-thread-cleanup") {
    try await probeGitThreadCleanup(session, ids: ids)
    await session.close()
    return
  }
  if let repo = argument("--git-thread") {
    await session.close()
    try await probeGitThread(environment, connector: connector, repo: repo)
    return
  }
  if let cwd = argument("--git-actions") {
    try await probeGitActions(session, cwd: cwd)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--usage") {
    try await probeUsage(session, label: environment.label)
    await session.close()
    return
  }
  if CommandLine.arguments.contains("--diff") {
    let threadId = argument("--diff").flatMap { $0.hasPrefix("--") ? nil : $0 }
    try await probeDiff(session, only: threadId)
    await session.close()
    return
  }
  print("environment id:    \(config.environment.environmentId)")
  print("environment label: \(config.environment.label)")
  print("server version:    \(config.environment.serverVersion)")
  print("protocol:          \(config.environment.protocolVersion)")
  if let platform = config.environment.platform {
    print("platform:          \(platform.os.rawValue)/\(platform.arch.rawValue)")
  }
  if let serverTime = config.serverTime { print("server time:       \(serverTime.rawValue)") }

  let subscription = config.shellSubscription
  print(
    "shell flags:       omitIdleSubagents=\(subscription.omitIdleSubagents ?? false) omitOlderSettled=\(subscription.omitOlderSettled ?? false) requestCompletionMarker=true"
  )

  let shell = try await session.subscribeShell(subscription)
  let trace = CommandLine.arguments.contains("--trace")
  let reader = Task {
    var state = ShellState(awaitingCompletion: true)
    var items = 0
    for try await item in shell {
      items += 1
      if trace { print("  item \(items): \(describe(item))") }
      state.apply(item)
      if state.status == .live { break }
    }
    return (state, items)
  }
  let timeout = Task {
    try await Task.sleep(for: .seconds(20))
    reader.cancel()
  }
  let final: ShellState
  let items: Int
  do {
    (final, items) = try await reader.value
  } catch {
    throw ProbeFailure(description: "Shell stream failed: \(error)")
  }
  timeout.cancel()

  guard let snapshot = final.snapshot else {
    throw ProbeFailure(description: "No shell snapshot within 20 s.")
  }
  print("shell status:      \(final.status) after \(items) items, sequence \(snapshot.snapshotSequence)")
  print("projects:          \(snapshot.projects.count)")
  print("threads:           \(snapshot.threads.count)")
  if let older = snapshot.olderSettled {
    print("older settled:     \(older.counts.reduce(0) { $0 + $1.count }) before \(older.before.rawValue)")
  }
  if snapshot.droppedRows.count > 0 {
    print("dropped rows:      \(snapshot.droppedRows.count) (\(snapshot.droppedRows.firstReason ?? "?"))")
  }
  if final.undecodableItems > 0 { print("undecodable items: \(final.undecodableItems)") }
  let recent = snapshot.threads.sorted { $0.updatedAt > $1.updatedAt }.prefix(5)
  for thread in recent {
    let title = thread.title.isEmpty ? "(untitled)" : thread.title
    print("  - [\(thread.status.rawValue)] \(title.prefix(70))")
  }

  let probe = try await session.probe()
  print("server.probe:      \(probe.compactDescription)")
  await session.close()
}

do {
  try await run()
  exit(0)
} catch {
  FileHandle.standardError.write(Data("ankiel-probe failed: \(error)\n".utf8))
  exit(1)
}
