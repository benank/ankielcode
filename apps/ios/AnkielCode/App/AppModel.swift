import AnkielKit
import Foundation
import Observation
import SwiftUI
import UIKit

/// The app's root state: the environment registry, the pairing flow, and which sheet is up.
/// No saved environments means onboarding; otherwise home.
@Observable
final class AppModel {
  enum Route: Equatable { case launching, onboarding, home }

  enum Sheet: String, Identifiable {
    case settings, pairingLink, scanner, help
    var id: String { rawValue }
  }

  let registry: EnvironmentRegistry
  let pairing: PairingFlow
  let navigator = Navigator()
  let home: HomeModel
  /// Drafts, uploads and the outbox for every composer.
  let composer: ComposerStore
  /// A sheet over home or onboarding.
  var sheet: Sheet?
  /// Settings' navigation path.
  var settingsPath: [SettingsRoute] = []
  /// Pairing screens opened from inside Settings, presented by Settings itself (one sheet at a
  /// time per presenter, so they cannot go through `sheet` while Settings is up).
  var settingsPairing: Sheet?
  /// Device preferences (theme, code text, follow-ups, grouping, list options).
  let preferences: ClientPreferences
  /// Server settings writes (the registry, or a fake in the settings fixture).
  let settingsWriter: SettingsWriter
  /// Finds newer Ankiel Code releases for the update check.
  let releaseLookup: ReleaseLookup
  /// Settings shows canned computers (`ANKIEL_DEBUG_SETTINGS`): nothing reaches a server.
  private(set) var isSettingsFixture = false
  #if DEBUG
    /// `ANKIEL_DEBUG_ROUTE=onboarding` shows onboarding without forgetting saved environments.
    private(set) var debugForcesOnboarding = false
  #endif

  @ObservationIgnored private var hasBeenActive = false
  /// Kept on onboarding while a pairing started there runs, so its progress is not cut off when
  /// the new environment lands in the registry.
  private var onboardingPairing = false

  init(store: any CredentialStore = KeychainCredentialStore(service: "com.ankiel.code.native")) {
    var store = store
    var directory = Self.supportDirectory
    var defaults = UserDefaults.standard
    var settingsSink: (any SettingsSink)?
    var releaseLookup = ReleaseLookup.live
    #if DEBUG
      let fixture = SettingsDebug.Mode(ProcessInfo.processInfo.environment["ANKIEL_DEBUG_SETTINGS"])
      if let fixture {
        // Its own folder, credentials and defaults: removing or clearing never touches the real ones.
        store = InMemoryCredentialStore()
        directory = SettingsDebug.directory
        defaults = SettingsDebug.defaults
        settingsSink = SettingsDebug.sink(fixture)
        releaseLookup = SettingsDebug.releaseLookup
      }
    #endif
    let connector = EnvironmentConnector(store: store, client: .current)
    registry = EnvironmentRegistry(connector: connector, directory: directory)
    registry.markdownStyle = .thread
    pairing = PairingFlow(registry: registry)
    preferences = ClientPreferences(defaults: defaults)
    home = HomeModel(registry: registry, preferences: preferences)
    settingsWriter = SettingsWriter(sink: settingsSink ?? registry)
    self.releaseLookup = releaseLookup
    #if DEBUG
      if let fixture {
        isSettingsFixture = true
        registry.debugLoad(SettingsDebug.fixtures(fixture))
      }
    #endif
    let (folder, sink, fake) = Self.composerTarget(registry)
    composer = ComposerStore(directory: directory.appending(path: folder, directoryHint: .isDirectory), sink: sink)
    isComposerFake = fake
    composer.titleLabels = .localized
    #if DEBUG
      if fake, ProcessInfo.processInfo.environment["ANKIEL_DEBUG_COMPOSER_RESET"] == "1" { composer.reset() }
    #endif
  }

  /// The composer's folder and sink. `ANKIEL_DEBUG_COMPOSER` (debug builds) picks a fake sink and
  /// a separate folder, so fake drafts and messages never reach a real computer.
  private static func composerTarget(_ registry: EnvironmentRegistry) -> (String, any ComposerSink, Bool) {
    #if DEBUG
      if let mode = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_COMPOSER"].flatMap(FakeComposerSink.Mode.init) {
        return ("composer-debug", FakeComposerSink(mode: mode), true)
      }
    #endif
    return ("composer", registry, false)
  }

  /// The composer sends to the debug fake (`ANKIEL_DEBUG_COMPOSER`).
  private(set) var isComposerFake = false

  /// Where composer commands go (the registry, or the debug fake).
  var composerSink: (any ComposerSink)? { composer.sink }

  var route: Route {
    guard registry.isLoaded else { return .launching }
    #if DEBUG
      if debugForcesOnboarding { return .onboarding }
    #endif
    if registry.environments.isEmpty { return .onboarding }
    if onboardingPairing, pairing.isActive { return .onboarding }
    return .home
  }

  func launch() async {
    await registry.load(adopting: Self.takeLegacyEnvironment())
    await composer.load()
    home.start()
    #if DEBUG
      applyDebugLaunch()
    #endif
    if let pendingThread {
      self.pendingThread = nil
      navigator.open(pendingThread)
    }
  }

  /// A thread link opened before the saved computers loaded; opened once they have.
  @ObservationIgnored private var pendingThread: ThreadRef?

  // MARK: Threads

  /// The open thread's shared model (fixtures in debug builds); pair with `closeThread`.
  func openThread(_ ref: ThreadRef) -> ThreadDetailModel {
    #if DEBUG
      if ThreadDebug.isFixture(ref) {
        let model = ThreadDebug.model(ref, style: registry.markdownStyle)
        applyDebugThreadPresets(model)
        return model
      }
    #endif
    return registry.openThread(ref)
  }

  func closeThread(_ model: ThreadDetailModel) {
    guard !ThreadDebug.isFixture(model.ref) else { return }
    registry.closeThread(model)
  }

  // MARK: Requests

  /// One controller per thread that has shown a pending request, so a half-answered question
  /// survives leaving the thread. Each drops its drafts once their requests end.
  @ObservationIgnored private var requestControllers: [String: PendingRequestController] = [:]

  func requests(_ ref: ThreadRef) -> PendingRequestController {
    if let controller = requestControllers[ref.key] { return controller }
    let controller = PendingRequestController(sink: composer.sink as? any RequestSink)
    requestControllers[ref.key] = controller
    return controller
  }

  /// The session may answer approvals and questions (`orchestration:operate`).
  func canAnswer(_ ref: ThreadRef) -> Bool {
    #if DEBUG
      if ProcessInfo.processInfo.environment["ANKIEL_DEBUG_REQUESTS"] == "readonly" { return false }
      if ThreadDebug.isFixture(ref) { return isComposerFake }
    #endif
    return home.canOperate(ref)
  }

  // MARK: Links

  /// `ankielcode-native://pair?pairingUrl=…` (any `ankielcode[-channel]` scheme), and the RN dev
  /// form's `…://connections/new?pairingUrl=…&autoConnect=1`. Links from outside the app always
  /// ask before pairing; only debug builds honor `autoConnect`.
  func open(_ url: URL) {
    if let ref = ThreadLink.parse(url) {
      sheet = nil
      if registry.isLoaded { navigator.open(ref) } else { pendingThread = ref }
      return
    }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(), scheme.wholeMatch(of: /ankielcode(?:-[a-z]+)?/) != nil
    else { return }
    let route = [components.host, components.path.trimmingCharacters(in: ["/"])]
      .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: "/")
    let pairingURL = components.queryItems?.first { $0.name == "pairingUrl" }?.value
    guard route == "pair" || route == "connections/new", let pairingURL,
      let target = try? PairingInput.resolve(pairingURL: pairingURL)
    else { return }
    sheet = nil
    settingsPairing = nil
    pairing.updatingEnvironmentId = nil
    onboardingPairing = self.route == .onboarding
    #if DEBUG
      if components.queryItems?.contains(where: { $0.name == "autoConnect" && $0.value == "1" }) == true
        || ProcessInfo.processInfo.environment["ANKIEL_OPEN_URL"] == url.absoluteString
      {
        pairing.run(target)
        return
      }
    #endif
    pairing.confirm(target)
  }

  // MARK: Pairing entry points

  func pair(_ input: String) {
    closePairingInput()
    pairing.start(input)
  }

  func pair(host: String, code: String) {
    closePairingInput()
    pairing.start(host: host, code: code)
  }

  /// Leaves the link or scanner screen for the pairing sheet, staying in Settings when pairing
  /// started there.
  private func closePairingInput() {
    onboardingPairing = route == .onboarding
    if sheet == .settings { settingsPairing = nil } else { sheet = nil }
  }

  /// The computer's snooze choices (its server settings), else the defaults.
  func snoozePresets(_ environmentId: String) -> [SnoozePresetSetting] {
    registry.environment(environmentId)?.settings.snoozePresets ?? SnoozePresetSetting.defaults
  }

  /// The scanner or form closed without pairing: a "Pair again" target must not carry over.
  func pairingInputClosed() {
    if !pairing.isActive { pairing.updatingEnvironmentId = nil }
  }

  /// The paste-or-type form, over Settings when it is open.
  func showPairingLink() {
    pairing.updatingEnvironmentId = nil
    if sheet == .settings { settingsPairing = .pairingLink } else { sheet = .pairingLink }
  }

  /// The QR scanner, over Settings when it is open. `updating` names a saved computer the next
  /// pairing may move to a new address (its own Pair again).
  func showScanner(updating environmentId: String? = nil) {
    pairing.updatingEnvironmentId = environmentId
    if sheet == .settings { settingsPairing = .scanner } else { sheet = .scanner }
  }

  /// Settings, optionally on one page.
  func openSettings(_ route: SettingsRoute? = nil) {
    settingsPath = route.map { [$0] } ?? []
    sheet = .settings
  }

  func finishPairing() {
    let succeeded = if case .succeeded = pairing.phase { true } else { false }
    pairing.reset()
    onboardingPairing = false
    #if DEBUG
      if succeeded { debugForcesOnboarding = false }
    #endif
  }

  // MARK: Lifecycle

  func scenePhaseChanged(_ phase: ScenePhase) {
    if phase == .background { Task { await composer.flush() } }
    guard phase == .active else { return }
    composer.wake()
    // The first activation is launch, which connects on its own.
    if hasBeenActive { registry.wake(.foreground) }
    hasBeenActive = true
  }

  // MARK: Storage

  static var supportDirectory: URL {
    URL.applicationSupportDirectory.appending(path: "AnkielCode", directoryHint: .isDirectory)
  }

  /// Phase 2 kept one environment in UserDefaults; the registry adopts it once.
  private static func takeLegacyEnvironment() -> SavedEnvironment? {
    let key = "pairedEnvironment"
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    UserDefaults.standard.removeObject(forKey: key)
    return try? JSONDecoder().decode(SavedEnvironment.self, from: data)
  }

  // MARK: Debug hooks (documented in apps/ios/README.md)

  #if DEBUG
    private func applyDebugLaunch() {
      let environment = ProcessInfo.processInfo.environment
      switch environment["ANKIEL_DEBUG_ROUTE"] {
      case "onboarding":
        debugForcesOnboarding = true
      case "onboarding-help":
        debugForcesOnboarding = true
        sheet = .help
      case "pairing-link":
        debugForcesOnboarding = true
        sheet = .pairingLink
      case "scanner":
        debugForcesOnboarding = true
        sheet = .scanner
      case "computers":
        openSettings(.computers)
      case "computer":
        openSettings(registry.environments.first.map { .computer($0.id) })
      case "settings":
        openSettings()
      case let value? where value.hasPrefix("settings-"):
        SettingsDebug.applyRoute(String(value.dropFirst("settings-".count)), to: self)
      case "new-thread":
        navigator.sheet = .newThread
      case "thread":
        if let first = registry.environments.first, let thread = first.shell.threads.first(where: \.isListed) {
          navigator.open(ThreadRef(environmentId: first.id, threadId: thread.id))
        }
      case let value? where value.hasPrefix("pairing-"):
        debugForcesOnboarding = true
        onboardingPairing = true
        pairing.debugPreset(String(value.dropFirst("pairing-".count)))
      default:
        break
      }
      if let preset = environment["ANKIEL_DEBUG_HOME"] {
        home.debugPreset(preset)
      }
      if let query = environment["ANKIEL_DEBUG_SEARCH"] {
        home.searchQuery = query
      }
      if let status = environment["ANKIEL_DEBUG_STATUS"] {
        registry.debugPresent(status: Self.debugStatus(status))
      }
      if let link = environment["ANKIEL_OPEN_URL"].flatMap(URL.init(string:)) {
        open(link)
      }
      if let fixture = environment["ANKIEL_DEBUG_THREAD"] {
        let ref = ThreadRef(environmentId: ThreadDebug.environmentId, threadId: fixture)
        navigator.open(ref)
        if let preset = environment["ANKIEL_DEBUG_COMPOSER_PRESET"] { applyComposerPreset(preset, ref: ref) }
      }
    }

    /// `ANKIEL_DEBUG_COMPOSER_PRESET` (with `ANKIEL_DEBUG_COMPOSER`): fills a fixture thread's
    /// composer for screenshots. `multiline`, `attachments` (ready, uploading and failed),
    /// `send` (sends one message), `queued` (queues one message), `failed` (with the `fail` mode,
    /// a refused message), `picker` (opens the model sheet), `keyboard` (focuses the field).
    private func applyComposerPreset(_ preset: String, ref: ThreadRef) {
      guard isComposerFake else { return }
      let key = ref.key
      let settings = ComposerStore.ThreadSettings(
        modelSelection: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5"), runtimeMode: .auto, interactionMode: .default)
      switch preset {
      case "multiline":
        composer.setText(
          "Look at the tide station sampler.\nThe harbor readings drift after midnight.\nCan you add a regression test and fix the offset?", for: key)
      case "attachments":
        composer.setText("Here are the charts from last night.", for: key)
        Task {
          _ = try? await composer.addAttachment(
            DebugCatalog.sampleImage(hue: 0.55), name: "tide-chart.png", mimeType: "image/png", kind: .image, to: key, environmentId: ref.environmentId)
          _ = try? await composer.addAttachment(
            DebugCatalog.sampleImage(hue: 0.08), name: "slow-buoy.png", mimeType: "image/png", kind: .image, to: key, environmentId: ref.environmentId)
          _ = try? await composer.addAttachment(
            Data("tide,height\n00:00,1.2\n".utf8), name: "fail-readings.csv", mimeType: "text/csv", kind: .file, to: key,
            environmentId: ref.environmentId)
        }
      case "send", "failed":
        Task {
          try? await Task.sleep(for: .milliseconds(900))
          composer.setText("Also add a regression test for the midnight drift.", for: key)
          composer.send(key, to: ref, delivery: .start, thread: settings)
        }
      case "queued":
        Task {
          try? await Task.sleep(for: .milliseconds(900))
          composer.setText("After that, update the harbor README.", for: key)
          composer.send(key, to: ref, delivery: .queue, thread: settings)
        }
      default:
        break
      }
    }

    /// `ANKIEL_DEBUG_THREAD_EXPAND=all|folds` opens run folds (and work groups) once the rows load;
    /// `ANKIEL_DEBUG_THREAD_SCROLL=top` opens the thread scrolled to its first row.
    private func applyDebugThreadPresets(_ model: ThreadDetailModel) {
      let environment = ProcessInfo.processInfo.environment
      if let ending = environment["ANKIEL_DEBUG_REQUESTS"], ending == "elsewhere" || ending == "expire" {
        // Another device answers (or the provider expires) the first request a moment after it shows.
        Task {
          for _ in 0..<100 where !model.state.isLoaded { try? await Task.sleep(for: .milliseconds(50)) }
          try? await Task.sleep(for: .seconds(2.5))
          let pending = model.state.pending
          guard let id = pending.approvals.first?.requestId ?? pending.userInputs.first?.requestId else { return }
          model.enqueue { await $0.debugResolveRequest(id, status: ending == "expire" ? .expired : .resolved, decision: "accept") }
        }
      }
      guard let expand = environment["ANKIEL_DEBUG_THREAD_EXPAND"] else { return }
      Task {
        for _ in 0..<100 where !model.state.isLoaded { try? await Task.sleep(for: .milliseconds(50)) }
        for row in model.state.timeline.rows {
          switch row.content {
          case .fold(let fold): model.expanded.insert(fold.foldId)
          case .workGroup(let group) where expand == "all": model.expanded.insert(group.groupId)
          case .work where expand == "all": model.expanded.insert(row.id)
          default: break
          }
        }
      }
    }

    /// `ANKIEL_DEBUG_STATUS`: a connection status to show on every computer (display only).
    private static func debugStatus(_ name: String) -> ConnectionStatus {
      switch name {
      case "offline": .offline
      case "connecting": .connecting
      case "needs-pairing": .needsPairing(ConnectionFailure(.credentialRejected, httpStatus: 401))
      case "incompatible": .incompatible(ConnectionFailure(.serverTooOld(serverProtocol: 1)))
      case "mismatch": .failed(ConnectionFailure(.environmentMismatch(found: "env-other")))
      default:
        .reconnecting(
          attempt: 3, retryAt: .now.addingTimeInterval(12),
          lastFailure: ConnectionFailure(.unreachable, detail: "Could not connect to the server."))
      }
    }
  #endif
}

extension ClientIdentity {
  static var current: ClientIdentity {
    let isPad = UIDevice.current.userInterfaceIdiom == .pad
    return ClientIdentity(
      label: isPad ? "Ankiel Code on iPad" : "Ankiel Code on iPhone",
      deviceType: isPad ? .tablet : .phone,
      os: "iOS",
      appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
      osMajorVersion: String(ProcessInfo.processInfo.operatingSystemVersion.majorVersion))
  }
}
