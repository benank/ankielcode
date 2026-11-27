#if DEBUG
  import AnkielKit
  import Foundation

  /// `ANKIEL_DEBUG_SETTINGS=fixture|fail|slow`: Settings over canned computers, with their own
  /// folder, credential store and defaults, a fake settings sink and a fake release lookup, so
  /// removing, clearing and writing never touch a real computer or the real saved state.
  /// `ANKIEL_DEBUG_ROUTE=settings-<page>` opens a page (`computer`, `computer-pairing`,
  /// `computer-off`, `appearance`, `general`, `chat`, `notifications`, `providers`, `threads`,
  /// `about`, `storage`, `diagnostics`, `computers`).
  enum SettingsDebug {
    enum Mode: String {
      case fixture, fail, slow

      init?(_ raw: String?) {
        guard let raw, let mode = Mode(rawValue: raw) else { return nil }
        self = mode
      }
    }

    static let studio = "env-fixture-studio"
    static let buildBox = "env-fixture-buildbox"
    static let laptop = "env-fixture-laptop"

    static let directory: URL = {
      let url = URL.temporaryDirectory.appending(path: "settings-fixture", directoryHint: .isDirectory)
      try? FileManager.default.removeItem(at: url)
      return url
    }()

    static let defaults: UserDefaults = {
      let suite = "com.ankiel.code.native.settings-fixture"
      let defaults = UserDefaults(suiteName: suite)!
      // `ANKIEL_DEBUG_SETTINGS_KEEP=1` keeps the last launch's preferences (theme at cold launch).
      if ProcessInfo.processInfo.environment["ANKIEL_DEBUG_SETTINGS_KEEP"] != "1" { defaults.removePersistentDomain(forName: suite) }
      return defaults
    }()

    @MainActor static func sink(_ mode: Mode) -> any SettingsSink { FakeSettingsSink(mode: mode, settings: settings) }

    /// Always offers 0.1.12, without the network.
    static let releaseLookup = ReleaseLookup { request in
      try await Task.sleep(for: .milliseconds(500))
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (Data(#"{"tag_name":"v0.1.12"}"#.utf8), response)
    }

    static var settings: ServerSettings {
      var settings = ServerSettings()
      settings.defaultRuntimeMode = .auto
      settings.autoResumeLimitedThreads = true
      return settings
    }

    static func fixtures(_ mode: Mode) -> [EnvironmentRegistry.DebugFixture] {
      func endpoint(_ url: String) -> EnvironmentEndpoint { EnvironmentEndpoint(httpBaseURL: URL(string: url)!)! }
      func record(_ id: String, _ label: String, routes: [EnvironmentRoute], version: String) -> EnvironmentRecord {
        var record = EnvironmentRecord(SavedEnvironment(environmentId: id, label: label, endpoint: routes[0].endpoint, serverVersion: version))
        record.routes = routes
        record.lastRouteId = routes[0].id
        record.pairedAt = Date(timeIntervalSince1970: 1_793_000_000)
        record.lastConnectedAt = .now.addingTimeInterval(-90)
        return record
      }
      var claude = ServerProvider(instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", models: [
        ServerProviderModel(slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true),
        ServerProviderModel(slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5"),
        ServerProviderModel(slug: "claude-haiku-5-5", name: "Claude Haiku 5.5"),
      ])
      claude.authStatus = "authenticated"
      claude.authEmail = "harbor@example.com"
      claude.version = "2.4.1"
      var codex = ServerProvider(instanceId: "codex", driver: "codex", models: [ServerProviderModel(slug: "gpt-5.4", name: "GPT-5.4")])
      codex.authStatus = "unauthenticated"
      codex.version = "0.98.0"
      codex.latestVersion = "0.99.2"
      codex.isBehindLatest = true
      var cursor = ServerProvider(instanceId: "cursor", driver: "cursor", installed: false)
      cursor.enabled = false
      let replay = ServerProvider(instanceId: "devReplay", driver: "devReplay", models: [ServerProviderModel(slug: "replay", name: "Replay")])

      var laptop = record(
        laptop, "Old Laptop", routes: [EnvironmentRoute(endpoint: endpoint("http://192.168.1.44:3773/"))], version: "0.1.9")
      laptop.enabled = false
      return [
        .init(
          record: record(
            studio, "Studio Mac",
            routes: [
              EnvironmentRoute(endpoint: endpoint("http://192.168.1.20:3773/")),
              EnvironmentRoute(endpoint: endpoint("https://ankiel-relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/"), kind: .relay, learned: true),
            ], version: "0.1.11"),
          status: .connected, settings: settings, providers: [claude, codex, cursor, replay],
          scopes: Set(AuthScope.grants.filter { $0 != "terminal:operate" }), capabilities: ["serverSelfUpdate": "respawn"]),
        .init(
          record: record(
            buildBox, "Build Box", routes: [EnvironmentRoute(endpoint: endpoint("https://buildbox.tail1234.ts.net/"), kind: .tailnet)],
            version: "0.1.11"),
          status: .needsPairing(ConnectionFailure(.credentialRejected, httpStatus: 401)), settings: settings, providers: [claude]),
        .init(record: laptop, status: .offline),
      ]
    }

    @MainActor static func applyRoute(_ name: String, to model: AppModel) {
      let route: SettingsRoute? =
        switch name {
        case "computers": .computers
        case "computer": .computer(studio)
        case "computer-pairing": .computer(buildBox)
        case "computer-off": .computer(laptop)
        case "provider": .provider(studio, "codex")
        case "computer-access": .access(model.isSettingsFixture ? studio : model.registry.environments.first?.id ?? studio)
        case "general": .general
        case "appearance": .appearance
        case "chat": .chat
        case "notifications": .notifications
        case "providers": .providers
        case "threads": .threads
        case "about": .about
        case "storage": .storage
        case "diagnostics": .diagnostics
        case "voice": .voice
        case "archive": .archive
        case "scheduled": .scheduledTasks
        case "usage": .usage
        default: nil
        }
      if case .provider? = route {
        model.openSettings(.providers)
        model.settingsPath.append(route!)
        return
      }
      if case .access(let id)? = route {
        model.openSettings(.computer(id))
        model.settingsPath.append(.access(id))
        return
      }
      model.openSettings(route)
    }
  }

  /// Accepts settings patches like a server would, after a short wait (`fail` refuses, `slow`
  /// never answers).
  @MainActor final class FakeSettingsSink: SettingsSink {
    let mode: SettingsDebug.Mode
    private var current: [String: ServerSettings] = [:]
    private let initial: ServerSettings

    init(mode: SettingsDebug.Mode, settings: ServerSettings) {
      self.mode = mode
      initial = settings
    }

    func updateSettings(_ patch: ServerSettingsPatch, in environmentId: String) async throws(EnvironmentRequestError) -> ServerSettings {
      try? await Task.sleep(for: .milliseconds(mode == .slow ? 600_000 : 350))
      if mode == .fail { throw .rejected(message: "Settings are read-only on this computer right now.") }
      let next = (current[environmentId] ?? initial).applying(patch)
      current[environmentId] = next
      return next
    }
  }
#endif
