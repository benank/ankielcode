import AnkielKit
import Foundation

/// `--supervise`: runs the real registry (supervisor, routes, shell sync, cache) against the
/// server and checks, without touching the server: connect, shell live, a foreground wakeup
/// probes without reconnecting, an in-place renewal keeps the socket, a dropped socket reconnects
/// and resumes the shell from its cursor, and a cold registry shows the cached rows.
@MainActor
func supervise(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else {
    throw ProbeFailure(description: "The registry did not adopt the environment.")
  }
  var seen: [String] = []
  func note(_ status: ConnectionStatus) {
    let text = String(describing: status)
    if seen.last != text {
      seen.append(text)
      print("  status → \(text.prefix(140))")
    }
  }
  func wait(_ what: String, seconds: Double = 20, until done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      note(model.status)
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
    note(model.status)
  }

  print("supervise: connecting")
  try await wait("a live shell") { model.isShellLive }
  let firstSequence = model.shell.sequence ?? -1
  let firstConnectedAt = model.record.lastConnectedAt
  print("  live via \(model.activeRoute?.kind.rawValue ?? "?") \(model.activeRoute?.id ?? ""), seq \(firstSequence), \(model.shell.threads.count) threads")
  print("  routes: \(model.record.routes.map { "\($0.kind.rawValue)\($0.learned ? "(learned)" : ""):\($0.id)" })")

  print("supervise: foreground wakeup (expect a probe, no reconnect)")
  registry.wake(.foreground)
  try await Task.sleep(for: .seconds(2))
  guard model.status == .connected, model.record.lastConnectedAt == firstConnectedAt else {
    throw ProbeFailure(description: "The foreground wakeup replaced a healthy session.")
  }
  print("  still connected on the same session")

  print("supervise: renew the token in place")
  if let renewed = try await registry.renewCredential(model.id) {
    print("  renewed, expires \(renewed.formatted(.iso8601))")
    registry.wake(.retry)
    try await Task.sleep(for: .seconds(1.5))
    guard model.status == .connected, model.record.lastConnectedAt == firstConnectedAt else {
      throw ProbeFailure(description: "Renewal disturbed the live session.")
    }
    print("  probe after renewal answered on the same session")
  } else {
    print("  bearer credential: nothing to renew")
  }

  print("supervise: drop the socket (expect reconnect and a resumed shell)")
  registry.dropSession(model.id)
  try await wait("a reconnect") { model.status != .connected }
  try await wait("a live shell again") { model.isShellLive && model.record.lastConnectedAt != firstConnectedAt }
  let resume = await registry.lastShellSubscription(model.id)
  print("  resubscribed with afterSequence=\(resume?.afterSequence.map(String.init) ?? "nil") httpSnapshotFallback=\(resume?.httpSnapshotFallback ?? false)")
  guard resume?.afterSequence == firstSequence || (resume?.afterSequence ?? -1) >= firstSequence else {
    throw ProbeFailure(description: "The reconnect did not resume from the held cursor.")
  }
  print("  live again, seq \(model.shell.sequence ?? -1), \(model.shell.threads.count) threads")

  print("supervise: cold registry from the cache")
  try await Task.sleep(for: .seconds(1.5))  // let the debounced cache write land
  // Rewind the cached cursor so the cold resume hits a gap the server cannot replay: expect
  // snapshot-required, the HTTP snapshot, then a resubscribe with its project identities.
  let cacheURL = try FileManager.default.contentsOfDirectory(
    at: directory.appending(path: "shell"), includingPropertiesForKeys: nil
  ).first { $0.pathExtension == "json" }
  if let cacheURL {
    var entry = try JSONDecoder().decode(ShellCacheEntry.self, from: Data(contentsOf: cacheURL))
    entry.snapshot.snapshotSequence = 1
    try JSONEncoder().encode(entry).write(to: cacheURL)
  }
  let cold = EnvironmentRegistry(connector: connector, directory: directory)
  await cold.load()
  guard let coldModel = cold.environment(model.id) else { throw ProbeFailure(description: "No saved record.") }
  let deadline = Date.now.addingTimeInterval(5)
  while coldModel.shell.snapshot == nil, Date.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
  print("  cached rows: \(coldModel.shell.threads.count) threads, live=\(coldModel.isShellLive) status=\(coldModel.status)")
  guard coldModel.shell.snapshot != nil else { throw ProbeFailure(description: "The cache did not restore.") }
  while !coldModel.isShellLive, Date.now < deadline.addingTimeInterval(15) { try await Task.sleep(for: .milliseconds(50)) }
  let coldResume = await cold.lastShellSubscription(model.id)
  print("  cold resume afterSequence=\(coldResume?.afterSequence.map(String.init) ?? "nil") fallback=\(coldResume?.httpSnapshotFallback ?? false) knownProjectIdentities=\(coldResume?.knownProjectIdentities == nil ? "absent" : "present"), live=\(coldModel.isShellLive), seq \(coldModel.shell.sequence ?? -1)")
  guard coldModel.isShellLive, coldResume?.knownProjectIdentities != nil else {
    throw ProbeFailure(description: "The snapshot-required fallback did not resubscribe from the HTTP snapshot.")
  }
  await cold.remove(model.id, forgetCredential: false)
  await registry.remove(model.id, forgetCredential: false)
  print("supervise: ok")
}

/// `--stale-resume`: subscribes with an old cursor and `httpSnapshotFallback` to see whether the
/// server answers `snapshot-required`, and loads the HTTP snapshot.
func staleResume(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let session = try await connector.connect(environment)
  var subscription = session.initialConfig.shellSubscription
  subscription.afterSequence = 1
  subscription.httpSnapshotFallback = true
  var items: [String] = []
  let reader = Task {
    for try await item in try await session.subscribeShell(subscription) {
      items.append(describe(item))
      if case .snapshotRequired = item { break }
      if case .synchronized = item { break }
    }
    return items
  }
  let timeout = Task {
    try await Task.sleep(for: .seconds(15))
    reader.cancel()
  }
  let seen = try await reader.value
  timeout.cancel()
  print("afterSequence=1 items: \(seen.prefix(6))")
  let vault = CredentialVault(environmentId: environment.environmentId, connector: connector)
  let http = try await connector.shellSnapshot(
    session.initialConfig.shellSubscription, endpoint: environment.endpoint, vault: vault)
  print("HTTP snapshot: seq \(http.snapshot.snapshotSequence), \(http.snapshot.threads.count) threads, projectIdentities \(http.projectIdentities == nil ? "absent" : "present")")
  await session.close()
}
