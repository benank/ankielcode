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
    case computers, pairingLink, scanner, help
    var id: String { rawValue }
  }

  let registry: EnvironmentRegistry
  let pairing: PairingFlow
  /// A sheet over home or onboarding.
  var sheet: Sheet?
  /// The Computers sheet's navigation path (environment ids).
  var computersPath: [String] = []
  #if DEBUG
    /// `ANKIEL_DEBUG_ROUTE=onboarding` shows onboarding without forgetting saved environments.
    private(set) var debugForcesOnboarding = false
  #endif

  @ObservationIgnored private var hasBeenActive = false
  /// Kept on onboarding while a pairing started there runs, so its progress is not cut off when
  /// the new environment lands in the registry.
  private var onboardingPairing = false

  init(store: any CredentialStore = KeychainCredentialStore(service: "com.ankiel.code.native")) {
    let connector = EnvironmentConnector(store: store, client: .current)
    registry = EnvironmentRegistry(connector: connector, directory: Self.supportDirectory)
    pairing = PairingFlow(registry: registry)
  }

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
    #if DEBUG
      applyDebugLaunch()
    #endif
  }

  // MARK: Links

  /// `ankielcode-native://pair?pairingUrl=…` (any `ankielcode[-channel]` scheme), and the RN dev
  /// form's `…://connections/new?pairingUrl=…&autoConnect=1`. Links from outside the app always
  /// ask before pairing; only debug builds honor `autoConnect`.
  func open(_ url: URL) {
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
    onboardingPairing = route == .onboarding
    sheet = nil
    pairing.start(input)
  }

  func pair(host: String, code: String) {
    onboardingPairing = route == .onboarding
    sheet = nil
    pairing.start(host: host, code: code)
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
    guard phase == .active else { return }
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
        sheet = .computers
      case "computer":
        sheet = .computers
        computersPath = registry.environments.first.map { [$0.id] } ?? []
      case let value? where value.hasPrefix("pairing-"):
        debugForcesOnboarding = true
        onboardingPairing = true
        pairing.debugPreset(String(value.dropFirst("pairing-".count)))
      default:
        break
      }
      if let status = environment["ANKIEL_DEBUG_STATUS"] {
        registry.debugPresent(status: Self.debugStatus(status))
      }
      if let link = environment["ANKIEL_OPEN_URL"].flatMap(URL.init(string:)) {
        open(link)
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
