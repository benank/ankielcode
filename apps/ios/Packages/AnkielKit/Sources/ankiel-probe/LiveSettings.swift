import AnkielKit
import Foundation

/// Sends an out-of-range patch whatever it is given, so the server refuses the write.
@MainActor
final class RefusingSettingsSink: SettingsSink {
  let session: EnvironmentSession
  init(_ session: EnvironmentSession) { self.session = session }

  func updateSettings(_: ServerSettingsPatch, in _: String) async throws(EnvironmentRequestError) -> ServerSettings {
    let bad: JSONValue = .object(["patch": .object(["sidebarAutoSettleAfterDays": .number(0)])])
    do {
      return try await session.rpc.call(UpdateSettingsRequest.rpcTag, payload: bad, as: ServerSettings.self)
    } catch {
      throw EnvironmentRequestError(error)
    }
  }
}

func findKey(_ key: String, in value: JSONValue) -> JSONValue? {
  switch value {
  case .object(let object):
    if let hit = object[key] { return hit }
    for child in object.values { if let hit = findKey(key, in: child) { return hit } }
    return nil
  case .array(let values):
    for child in values { if let hit = findKey(key, in: child) { return hit } }
    return nil
  default: return nil
  }
}

/// `--live settings`: what the Threads page shows and writes, against the server's own values.
@MainActor
func liveSettings(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-settings-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "Not adopted.") }
  func wait(_ what: String, _ seconds: Double = 20, _ done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell") { model.isShellLive }
  let side = try await connector.connect(environment)
  defer { Task { await side.close() } }

  func serverSettings() async throws -> [String: JSONValue] {
    let stream = try await side.rpc.stream("subscribeServerConfig", payload: EmptyObject(), of: JSONValue.self)
    for try await item in stream {
      if case .object(let settings)? = findKey("settings", in: item) { return settings }
    }
    return [:]
  }
  let keys = ["sidebarAutoSettleOnMerge", "sidebarAutoSettleAfterDays", "autoResumeLimitedThreads", "snoozeLimitedThreads", "defaultRuntimeMode", "snoozePresets"]
  let raw = try await serverSettings()
  print("server: \(keys.map { "\($0)=\(raw[$0].map { "\($0)" } ?? "absent")" }.joined(separator: " "))")
  let s = model.settings
  print("client: autoSettleOnMerge=\(s.autoSettleOnMerge) autoSettleAfterDays=\(s.autoSettleAfterDays.map(String.init) ?? "off") autoResume=\(s.autoResumeLimitedThreads) snoozeLimited=\(s.snoozeLimitedThreads) defaultRuntimeMode=\(s.defaultRuntimeMode?.rawValue ?? "nil") presets=\(s.snoozePresets.count)")
  var failures: [String] = []
  let original = s
  let writer = SettingsWriter(sink: registry)

  func check(_ name: String, _ patch: ServerSettingsPatch, _ expect: @escaping (ServerSettings) -> Bool) async throws {
    let failed = await writer.write(patch, to: [model])
    let confirmed = expect(model.settings)
    let raw = try await serverSettings()
    let key = patch.keys.first ?? ""
    print("  \(failed.isEmpty && confirmed ? "✓" : "✗") \(name): server \(key)=\(raw[key].map { "\($0)" } ?? "absent")\(failed.isEmpty ? "" : " refused \(failed.map(\.error))")")
    if !failed.isEmpty || !confirmed { failures.append(name) }
  }
  try await check("auto-settle on merge", .autoSettleOnMerge(!original.autoSettleOnMerge)) { $0.autoSettleOnMerge == !original.autoSettleOnMerge }
  try await check("auto-settle after 14 days", .autoSettleAfterDays(14)) { $0.autoSettleAfterDays == 14 }
  try await check("auto-settle off", .autoSettleAfterDays(nil)) { $0.autoSettleAfterDays == nil }
  try await check("auto-resume limited", .autoResumeLimitedThreads(!original.autoResumeLimitedThreads)) { $0.autoResumeLimitedThreads == !original.autoResumeLimitedThreads }
  try await check("snooze limited", .snoozeLimitedThreads(!original.snoozeLimitedThreads)) { $0.snoozeLimitedThreads == !original.snoozeLimitedThreads }
  let otherMode: RuntimeMode = original.defaultRuntimeMode == .fullAccess ? .approvalRequired : .fullAccess
  try await check("default permissions", .defaultRuntimeMode(otherMode)) { $0.defaultRuntimeMode == otherMode }

  // Restore.
  _ = await writer.write(.autoSettleOnMerge(original.autoSettleOnMerge), to: [model])
  _ = await writer.write(.autoSettleAfterDays(original.autoSettleAfterDays), to: [model])
  _ = await writer.write(.autoResumeLimitedThreads(original.autoResumeLimitedThreads), to: [model])
  _ = await writer.write(.snoozeLimitedThreads(original.snoozeLimitedThreads), to: [model])
  if let mode = original.defaultRuntimeMode { _ = await writer.write(.defaultRuntimeMode(mode), to: [model]) }
  let restored = try await serverSettings()
  let same = keys.allSatisfy { restored[$0] == raw[$0] }
  print("restored: \(same ? "yes" : "NO: \(keys.filter { restored[$0] != raw[$0] }.map { "\($0) \(raw[$0].map { "\($0)" } ?? "absent") → \(restored[$0].map { "\($0)" } ?? "absent")" })")")
  if !same { failures.append("restore") }

  // A refused write: the optimistic value shows while pending and rolls back on refusal.
  let refusing = SettingsWriter(sink: RefusingSettingsSink(side))
  let before = model.effectiveSettings.autoSettleAfterDays
  var sawOptimistic = false
  let watcher = Task { @MainActor in
    while !Task.isCancelled {
      if model.effectiveSettings.autoSettleAfterDays == 30 { sawOptimistic = true }
      await Task.yield()
    }
  }
  let refused = await refusing.write(.autoSettleAfterDays(30), to: [model])
  watcher.cancel()
  print("refused write: optimistic 30 \(sawOptimistic ? "shown" : "not observed"), then \(model.effectiveSettings.autoSettleAfterDays.map(String.init) ?? "off") (was \(before.map(String.init) ?? "off")); error \(refused.first.map { "\($0.error)" } ?? "none")")
  if refused.isEmpty || model.effectiveSettings.autoSettleAfterDays != before { failures.append("refused rollback") }
  if !failures.isEmpty { throw ProbeFailure(description: "Failed: \(failures)") }
}
