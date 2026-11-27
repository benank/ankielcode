import Foundation
import Testing

@testable import AnkielKit

@MainActor @Suite struct ClientPreferencesTests {
  func defaults() -> UserDefaults {
    let suite = "prefs-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
  }

  @Test func `phase 4 thread list keys move into the one value and are removed`() {
    let defaults = defaults()
    defaults.set("env-2", forKey: "threadList.environmentId")
    defaults.set("env-2:proj", forKey: "threadList.projectKey")
    defaults.set(true, forKey: "threadList.settledShelfExpanded")
    defaults.set(["env-2:a", "env-2:b"], forKey: "threadList.collapsedProjectGroups")

    let preferences = ClientPreferences(defaults: defaults)
    #expect(preferences.values.threadListEnvironmentId == "env-2")
    #expect(preferences.values.threadListProjectKey == "env-2:proj")
    #expect(preferences.values.settledShelfExpanded)
    #expect(!preferences.values.snoozedShelfExpanded)
    #expect(preferences.values.collapsedProjectGroups == ["env-2:a", "env-2:b"])
    for key in ClientPreferences.LegacyKeys.all { #expect(defaults.object(forKey: key) == nil) }

    // A later launch reads the migrated value, not the (gone) legacy keys.
    defaults.set("stale", forKey: "threadList.environmentId")
    #expect(ClientPreferences(defaults: defaults).values.threadListEnvironmentId == "env-2")
  }

  @Test func `changes persist and an unreadable field keeps the others`() throws {
    let defaults = defaults()
    let preferences = ClientPreferences(defaults: defaults)
    preferences.values.themeMode = .dark
    preferences.values.followUpBehavior = .queue
    preferences.values.codeFontSize = 15
    #expect(ClientPreferences(defaults: defaults).values.themeMode == .dark)

    let mangled = #"{"themeMode":"sepia","followUpBehavior":"queue","codeFontSize":99,"projectGroupingMode":"separate"}"#
    defaults.set(Data(mangled.utf8), forKey: ClientPreferences.storageKey)
    let reloaded = ClientPreferences(defaults: defaults).values
    #expect(reloaded.themeMode == .system)
    #expect(reloaded.followUpBehavior == .queue)
    #expect(reloaded.codeFontSize == 18)
    #expect(reloaded.projectGroupingMode == .separate)
  }
}

@Suite struct ServerSettingsTests {
  func decode(_ json: String) throws -> ServerSettings {
    try JSONDecoder().decode(ServerSettings.self, from: Data(json.utf8))
  }

  @Test func `absent auto-settle days is the server default; null is off`() throws {
    #expect(try decode("{}").autoSettleAfterDays == 7)
    #expect(try decode(#"{"sidebarAutoSettleAfterDays":null}"#).autoSettleAfterDays == nil)
    #expect(try decode(#"{"sidebarAutoSettleAfterDays":30}"#).autoSettleAfterDays == 30)
    #expect(try decode("{}").autoSettleOnMerge)
    #expect(try decode(#"{"sidebarAutoSettleOnMerge":"yes"}"#).autoSettleOnMerge)
  }

  @Test func `snooze presets decode the wire shape and skip bad entries`() throws {
    let settings = try decode(#"{"snoozePresets":[{"kind":"after","minutes":30},{"kind":"at","day":"friday","time":"17:30"},{"kind":"at","day":"someday","time":"09:00"}]}"#)
    #expect(settings.snoozePresets == [.after(minutes: 30), .at(day: .friday, hour: 17, minute: 30)])
    #expect(try decode(#"{"snoozePresets":[]}"#).snoozePresets == SnoozePresetSetting.defaults)
  }

  @Test func `a pending patch overlays the confirmed settings`() {
    let settings = ServerSettings()
    let next = settings.applying(.autoSettleAfterDays(nil)).applying(.defaultRuntimeMode(.fullAccess))
    #expect(next.autoSettleAfterDays == nil)
    #expect(next.defaultRuntimeMode == .fullAccess)
    #expect(settings.applying(.autoResumeLimitedThreads(true)).autoResumeLimitedThreads)
  }
}

/// Answers each write when the test says so.
@MainActor final class ScriptedSettingsSink: SettingsSink {
  var answers: [String: Result<ServerSettings, EnvironmentRequestError>] = [:]
  var gate: CheckedContinuation<Void, Never>?
  var holds = false
  private(set) var calls: [(String, ServerSettingsPatch)] = []

  func updateSettings(_ patch: ServerSettingsPatch, in environmentId: String) async throws(EnvironmentRequestError) -> ServerSettings {
    calls.append((environmentId, patch))
    if holds { await withCheckedContinuation { gate = $0 } }
    switch answers[environmentId] ?? .failure(.notConnected) {
    case .success(let settings): return settings
    case .failure(let error): throw error
    }
  }

  func release() {
    gate?.resume()
    gate = nil
  }
}

@MainActor @Suite struct SettingsWriterTests {
  func model(_ id: String, scopes: Set<String>? = [AuthScope.settingsWrite], connected: Bool = true) -> EnvironmentModel {
    let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: "http://127.0.0.1:9/")!)!
    let model = EnvironmentModel(record: EnvironmentRecord(SavedEnvironment(environmentId: id, label: id, endpoint: endpoint, serverVersion: "1")))
    model.status = connected ? .connected : .offline
    model.grantedScopes = scopes
    return model
  }

  @Test func `a write shows at once, then adopts the server's answer`() async {
    let sink = ScriptedSettingsSink()
    var confirmed = ServerSettings()
    confirmed.autoSettleAfterDays = 21
    sink.answers["a"] = .success(confirmed)
    sink.holds = true
    let target = model("a")
    let writer = SettingsWriter(sink: sink)
    let task = Task { await writer.write(.autoSettleAfterDays(14), to: [target]) }
    await eventually { sink.gate != nil }
    #expect(target.effectiveSettings.autoSettleAfterDays == 14)
    #expect(target.settings.autoSettleAfterDays == 7)
    sink.release()
    #expect(await task.value.isEmpty)
    #expect(target.pendingSettings.isEmpty)
    #expect(target.effectiveSettings.autoSettleAfterDays == 21)
  }

  @Test func `a refusal rolls back without clobbering a config event that landed meanwhile`() async {
    let sink = ScriptedSettingsSink()
    sink.answers["a"] = .failure(.rejected(message: "No."))
    sink.holds = true
    let target = model("a")
    let writer = SettingsWriter(sink: sink)
    let task = Task { await writer.write(.autoSettleOnMerge(false), to: [target]) }
    await eventually { sink.gate != nil }
    #expect(!target.effectiveSettings.autoSettleOnMerge)
    // Another device changed a different setting while the write was in flight.
    var fromServer = ServerSettings()
    fromServer.snoozeLimitedThreads = true
    target.settings = fromServer
    sink.release()
    let failures = await task.value
    #expect(failures.map(\.environmentId) == ["a"])
    #expect(failures.first?.error == .rejected(message: "No."))
    #expect(target.effectiveSettings.autoSettleOnMerge)
    #expect(target.effectiveSettings.snoozeLimitedThreads)
  }

  @Test func `bulk writes report each target and never redirect an unavailable one`() async {
    let sink = ScriptedSettingsSink()
    sink.answers["a"] = .success(ServerSettings())
    let writer = SettingsWriter(sink: sink)
    let failures = await writer.write(
      .snoozeLimitedThreads(true),
      to: [model("a"), model("b", connected: false), model("c", scopes: nil), model("d", scopes: [AuthScope.orchestrationRead])])
    #expect(sink.calls.map(\.0) == ["a"])
    #expect(failures.map(\.environmentId) == ["b", "c", "d"])
    #expect(failures.first?.error == .notConnected)
  }
}

@Suite struct ReleaseTests {
  @Test func `semver compares like the shared helper`() {
    #expect(SemanticVersion.compare("20", "9") > 0)
    #expect(SemanticVersion.compare("18", "18.0.0") == 0)
    #expect(SemanticVersion.compare("1.0.0-Z", "1.0.0-a") < 0)
    #expect(SemanticVersion.compare("1.0.0-alpha-1", "1.0.0-alpha1") < 0)
    #expect(SemanticVersion.compare("1.0.0-9007199254740992", "1.0.0-9007199254740993") < 0)
    #expect(SemanticVersion.compare("2.1.111-beta.1", "2.1.111") < 0)
    #expect(SemanticVersion.normalize("20-alpha-1") == "20.0.0-alpha-1")
    #expect(SemanticVersion.parse("1.2.3-alpha-1.2") == .init(major: 1, minor: 2, patch: 3, prerelease: ["alpha-1", "2"]))
    #expect(SemanticVersion.compare("1.2.3-alpha-1", "1.2.3-alpha-2") < 0)
    #expect(SemanticVersion.compare("1.2.3-alpha-2", "1.2.3-alpha-1") > 0)
    #expect(SemanticVersion.compare("1.2.3-alpha-1.2", "1.2.3-alpha-1.10") < 0)
    #expect(SemanticVersion.compare("1.2.3-alpha.1+build-2", "1.2.3-alpha.1+build-3") == 0)
  }

  @Test func `channels and the newest release per channel`() {
    let releases: [(tag: String, draft: Bool)] = [
      ("v1.2.4-preview.20260912.9", true), ("v1.2.4-preview.20260912.8", false), ("v1.2.4-nightly.20260912.7", false),
      ("desktop-preview", false), ("v1.2.3", false), ("v1.2.3-nightly.20260911.2", false),
    ]
    #expect(ReleaseChannel.preview.newest(in: releases) == "1.2.4-preview.20260912.8")
    #expect(ReleaseChannel.nightly.newest(in: releases) == "1.2.4-nightly.20260912.7")
    #expect(ReleaseChannel.stable.newest(in: releases) == "1.2.3")
    #expect(ReleaseChannel.preview.newest(in: [("v1.2.3", false)]) == nil)
    #expect(ReleaseChannel(version: "0.1.12-nightly.20261126.3") == .nightly)
    #expect(ReleaseChannel(version: "0.1.11") == .stable)
  }

  @Test func `the lookup offers only a newer version on the server's channel`() async throws {
    let lookup = ReleaseLookup { request in
      #expect(request.url?.absoluteString == "https://github.com/benank/ankielcode/releases/latest")
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data(#"{"tag_name":"v0.1.12"}"#.utf8), response)
    }
    #expect(try await lookup.newerVersion(than: "0.1.11") == "0.1.12")
    #expect(try await lookup.newerVersion(than: "0.1.12") == nil)

    let feed = ReleaseLookup { request in
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      let atom = "<feed><entry><id>tag:github.com,2008:Repository/1/v0.1.12-nightly.20261127.1</id></entry></feed>"
      return (Data(atom.utf8), response)
    }
    #expect(try await feed.newerVersion(than: "0.1.12-nightly.20261126.4") == "0.1.12-nightly.20261127.1")

    let down = ReleaseLookup { request in
      (Data(), HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!)
    }
    await #expect(throws: ReleaseLookup.Failure.http(503)) { try await down.newerVersion(than: "0.1.11") }
  }
}

@Suite struct ProjectGroupingModeTests {
  func project(_ id: String, root: String, repoRoot: String?, key: String?) throws -> ProjectShell {
    var object: [String: JSONValue] = [
      "id": .string(id), "title": .string(id), "workspaceRoot": .string(root),
      "createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-01T00:00:00.000Z",
    ]
    if let key {
      object["repositoryIdentity"] = .object([
        "canonicalKey": .string(key), "locator": .object(["source": "git-remote", "remoteName": "origin", "remoteUrl": .string("git@example.com:\(key).git")]),
        "rootPath": repoRoot.map(JSONValue.string) ?? .null, "name": "tides",
      ])
    }
    return try JSONDecoder().decode(ProjectShell.self, from: JSONEncoder().encode(JSONValue.object(object)))
  }

  @Test func `repository, repository path and separate modes`() throws {
    let root = ScopedProject(environmentId: "a", project: try project("p1", root: "/src/tides", repoRoot: "/src/tides", key: "example.com/tides"))
    let app = ScopedProject(environmentId: "a", project: try project("p2", root: "/src/tides/apps/ios", repoRoot: "/src/tides", key: "example.com/tides"))
    let other = ScopedProject(environmentId: "b", project: try project("p3", root: "/work/tides", repoRoot: "/work/tides", key: "example.com/tides"))
    let groupingKey = try #require(root.project.repositoryIdentity?.groupingKey)

    #expect(Set(ProjectGrouping.scopes([root, app, other], mode: .repository).map(\.key)) == [groupingKey])
    #expect(Set(ProjectGrouping.scopes([root, app, other], mode: .repositoryPath).map(\.key)) == [groupingKey, "\(groupingKey)::apps/ios"])
    #expect(ProjectGrouping.scopes([root, app, other], mode: .separate).count == 3)
    #expect(ProjectGrouping.relativePath(app.project) == "apps/ios")
    #expect(ProjectGrouping.relativePath(root.project) == "")
  }
}

@Suite struct EnvironmentRecordFileTests {
  @Test func `a phase 7 file without the enabled flag still loads`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "records-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: "http://192.168.1.20:3773/")!)!
    let record = EnvironmentRecord(SavedEnvironment(environmentId: "env-1", label: "Mac", endpoint: endpoint, serverVersion: "0.1.11"))
    var json = try #require(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(record)).objectValue)
    json["enabled"] = nil
    let file: JSONValue = ["version": 1, "environments": [.object(json)]]
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appending(path: "environments.json")
    try JSONEncoder().encode(file).write(to: url)
    let loaded = try #require(await EnvironmentRecordStore(url: url).load())
    #expect(loaded.map(\.environmentId) == ["env-1"])
    #expect(loaded.first?.enabled == nil)
  }
}

extension JSONValue {
  fileprivate var objectValue: [String: JSONValue]? {
    if case .object(let object) = self { object } else { nil }
  }
}

@Suite struct FollowUpDefaultTests {
  @Test func `queue as the default swaps the primary and the alternate`() {
    let running = ThreadRunActivity(activeRunId: "run-1", activeRunStatus: .running)
    let settingUp = ThreadRunActivity(activeRunId: "run-1", activeRunStatus: .starting)
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: running) == .steer)
    #expect(ComposerPrimaryAction.alternate(.steer, activity: running) == .queue)
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: running, followUp: .queue) == .queue)
    #expect(ComposerPrimaryAction.alternate(.queue, activity: running) == .steer)
    // A turn still setting up can only queue, whatever the default.
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: settingUp) == .queue)
    #expect(ComposerPrimaryAction.alternate(.queue, activity: settingUp) == nil)
    #expect(ComposerPrimaryAction.resolve(hasContent: false, activity: running, followUp: .queue) == .stop)
  }
}
