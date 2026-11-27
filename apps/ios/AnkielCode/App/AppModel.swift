import AnkielKit
import Foundation
import Observation
import UIKit

/// Owns the one paired environment, its session and the shell rows the UI shows.
@Observable
final class AppModel {
  enum Phase: Equatable {
    case launching
    case onboarding
    case connecting
    case connected
    case disconnected(String)
  }

  private(set) var phase = Phase.launching
  private(set) var environment: SavedEnvironment?
  private(set) var shell = ShellState()
  private(set) var isPairing = false
  private(set) var pairingError: String?

  @ObservationIgnored private let connector: EnvironmentConnector
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private var session: EnvironmentSession?
  @ObservationIgnored private var sessionTasks: [Task<Void, Never>] = []
  /// Bumped by every connect, so a slower connect that loses a race closes its own socket.
  @ObservationIgnored private var connectGeneration = 0
  private static let environmentKey = "pairedEnvironment"

  init(
    store: any CredentialStore = KeychainCredentialStore(service: "com.ankiel.code.native"),
    defaults: UserDefaults = .standard
  ) {
    connector = EnvironmentConnector(store: store, client: .current)
    self.defaults = defaults
  }

  /// Reconnects to the saved environment, or shows onboarding.
  func restore() async {
    guard phase == .launching else { return }
    if let data = defaults.data(forKey: Self.environmentKey),
      let saved = try? JSONDecoder().decode(SavedEnvironment.self, from: data)
    {
      environment = saved
      await connect()
    } else {
      phase = .onboarding
    }
  }

  /// `ankielcode-native://pair?pairingUrl=<urlencoded>` (and the other channel schemes).
  func open(_ url: URL) {
    guard let pairingURL = PairingInput.appLinkPairingURL(url.absoluteString) else { return }
    Task { await pair(pairingURL) }
  }

  func pair(_ input: String) async {
    guard !isPairing else { return }
    isPairing = true
    pairingError = nil
    defer { isPairing = false }
    do {
      let target = try PairingInput.resolve(input)
      let (paired, _) = try await connector.pair(target)
      if let previous = environment, previous.environmentId != paired.environmentId {
        connector.forget(previous.environmentId)
      }
      environment = paired
      defaults.set(try JSONEncoder().encode(paired), forKey: Self.environmentKey)
      Haptics.success()
      await connect()
    } catch let error as PairingInputError {
      pairingError = Self.message(for: ConnectionError.pairingInput(error))
      Haptics.error()
    } catch let error as ConnectionError {
      pairingError = Self.message(for: error)
      Haptics.error()
    } catch {
      pairingError = error.localizedDescription
      Haptics.error()
    }
  }

  func connect() async {
    guard let environment else {
      phase = .onboarding
      return
    }
    connectGeneration += 1
    let generation = connectGeneration
    closeSession()
    phase = .connecting
    do {
      let session = try await connector.connect(environment)
      guard generation == connectGeneration else {
        await session.close()
        return
      }
      self.session = session
      shell = ShellState()
      phase = .connected
      sessionTasks = [
        Task { await followShell(session) },
        Task { await followConfig(session) },
      ]
    } catch {
      guard generation == connectGeneration else { return }
      phase = .disconnected(Self.message(for: error))
    }
  }

  /// Forgets the paired environment and its credential.
  func forget() {
    connectGeneration += 1
    closeSession()
    if let environment { connector.forget(environment.environmentId) }
    defaults.removeObject(forKey: Self.environmentKey)
    environment = nil
    shell = ShellState()
    phase = .onboarding
  }

  private func followShell(_ session: EnvironmentSession) async {
    do {
      for try await item in try await session.subscribeShell() {
        shell.apply(item)
      }
      end(String(localized: "The server ended the session."))
    } catch {
      end(Self.message(for: error))
    }
  }

  /// Drains the config stream (later phases read its events). Its end is the session's end.
  private func followConfig(_ session: EnvironmentSession) async {
    do {
      while try await session.nextConfigEvent() != nil {}
      end(String(localized: "The server ended the session."))
    } catch {
      end(Self.message(for: error))
    }
  }

  private func end(_ message: String) {
    guard !Task.isCancelled else { return }
    closeSession()
    phase = .disconnected(message)
  }

  private func closeSession() {
    for task in sessionTasks { task.cancel() }
    sessionTasks = []
    if let session {
      Task { await session.close() }
    }
    session = nil
  }

  static func message(for error: any Error) -> String {
    switch error {
    case ConnectionError.pairingInput(let input):
      switch input {
      case .backendURLMissing: String(localized: "Paste a pairing link.")
      case .pairingURLInvalid, .backendURLInvalid: String(localized: "That doesn't look like a pairing link.")
      case .tokenMissing, .codeMissing: String(localized: "The pairing link is missing its code.")
      }
    case ConnectionError.credentialRejected:
      String(localized: "The server didn't accept this device. Pair again with a new link.")
    case ConnectionError.environmentMismatch:
      String(localized: "A different Ankiel Code server answered at this address.")
    case ConnectionError.incompatibleProtocol:
      String(localized: "This server runs a different version of Ankiel Code. Update the server or the app.")
    case ConnectionError.unreachable(let detail), ConnectionError.socket(let detail):
      String(localized: "Couldn't reach the server. \(detail)")
    case ConnectionError.socketRefused(let status):
      String(localized: "The server refused the connection (HTTP \(status)).")
    case ConnectionError.rpc(let rpc), let rpc as RpcError:
      String(localized: "The connection failed: \(String(describing: rpc))")
    case ConnectionError.configStreamEnded:
      String(localized: "The server closed the session.")
    default:
      error.localizedDescription
    }
  }
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
