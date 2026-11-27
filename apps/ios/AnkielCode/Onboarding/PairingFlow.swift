import AnkielKit
import Foundation
import Observation

/// A pairing in progress: confirm (for links from outside the app), the steps, and a specific
/// failure with what to do next.
@Observable
final class PairingFlow {
  enum Phase: Equatable {
    case idle
    /// A link opened the app; pairing waits for the user to confirm the host.
    case confirm(PairingTarget)
    case working(PairingStep, host: String)
    case failed(PairingProblem)
    case succeeded(host: String)
  }

  private(set) var phase = Phase.idle
  @ObservationIgnored private let registry: EnvironmentRegistry
  @ObservationIgnored private var lastTarget: PairingTarget?
  @ObservationIgnored private var task: Task<Void, Never>?

  init(registry: EnvironmentRegistry) {
    self.registry = registry
  }

  var isActive: Bool { phase != .idle }
  var isWorking: Bool { if case .working = phase { true } else { false } }

  /// Pairs from anything typed, pasted or scanned.
  func start(_ input: String) {
    do {
      run(try PairingInput.resolve(Self.unwrapScanned(input)))
    } catch {
      phase = .failed(PairingProblem(.input(error), host: nil))
      Haptics.error()
    }
  }

  func start(host: String, code: String) {
    do {
      run(try PairingInput.resolve(host: host, code: code))
    } catch {
      phase = .failed(PairingProblem(.input(error), host: nil))
      Haptics.error()
    }
  }

  /// A link from outside the app: ask before spending its code on a host the user did not pick.
  func confirm(_ target: PairingTarget) {
    guard !isWorking else { return }
    phase = .confirm(target)
  }

  func run(_ target: PairingTarget) {
    guard !isWorking else { return }
    lastTarget = target
    let host = Self.host(target.endpoint)
    phase = .working(.checkingServer, host: host)
    task = Task {
      do {
        let model = try await registry.pair(target) { step in
          self.phase = .working(step, host: host)
        }
        await waitUntilSettled(model)
        Haptics.success()
        phase = .succeeded(host: model.label)
      } catch let error as PairingFailure {
        phase = .failed(PairingProblem(error, host: host))
        Haptics.error()
      } catch {
        return  // Cancelled.
      }
    }
  }

  /// Tries the same target again (only offered when the code may still be unspent).
  func retry() {
    guard let lastTarget else { return reset() }
    run(lastTarget)
  }

  func reset() {
    task?.cancel()
    task = nil
    phase = .idle
  }

  /// Waits briefly for the first connect so the user lands on a home that has data. A slow host
  /// keeps connecting in the background.
  private func waitUntilSettled(_ model: EnvironmentModel) async {
    let settled = Task {
      for await status in Observations({ model.status }) where Self.isSettled(status) { return }
    }
    let timeout = Task {
      try? await Task.sleep(for: .seconds(10))
      settled.cancel()
    }
    await settled.value
    timeout.cancel()
  }

  private static func isSettled(_ status: ConnectionStatus) -> Bool {
    switch status {
    case .connecting: false
    case .reconnecting(_, _, let failure): failure != nil
    default: true
    }
  }

  #if DEBUG
    /// `ANKIEL_DEBUG_ROUTE=pairing-<state>`: shows a pairing state without a server.
    func debugPreset(_ name: String) {
      let target = try! PairingInput.resolve(pairingURL: "http://192.168.1.20:3773/pair#token=ABCDEFGHJKMN")
      let host = Self.host(target.endpoint)
      lastTarget = target
      phase =
        switch name {
        case "confirm": .confirm(target)
        case "checking": .working(.checkingServer, host: host)
        case "exchanging": .working(.exchangingCode, host: host)
        case "connecting": .working(.connecting, host: host)
        case "success": .succeeded(host: host)
        case "expired": .failed(PairingProblem(.connection(.credentialRejected), host: host))
        case "incompatible": .failed(PairingProblem(.connection(.incompatibleProtocol(serverVersion: 1)), host: host))
        case "claims": .failed(PairingProblem(.claimsSavedEnvironment(label: "Hyperspeed"), host: host))
        case "clock": .failed(PairingProblem(.connection(.clockSkew), host: host))
        case "invalid": .failed(PairingProblem(.input(.pairingURLInvalid), host: nil))
        default: .failed(PairingProblem(.connection(.unreachable("Could not connect to the server.")), host: host))
        }
    }
  #endif

  /// QR codes may carry an `ankielcode:` app link or the pairing URL itself.
  static func unwrapScanned(_ payload: String) -> String {
    PairingInput.appLinkPairingURL(payload.trimmingCharacters(in: .whitespacesAndNewlines)) ?? payload
  }

  static func host(_ endpoint: EnvironmentEndpoint) -> String {
    let url = endpoint.httpBaseURL
    let host = url.host() ?? url.absoluteString
    return url.port.map { "\(host):\($0)" } ?? host
  }
}

/// A pairing failure as the user reads it.
struct PairingProblem: Equatable {
  let title: String
  let message: String
  let systemImage: String
  /// The same link may still work (the code was not spent).
  let canRetry: Bool

  init(_ failure: PairingFailure, host: String?) {
    let host = host ?? String(localized: "the computer")
    switch failure {
    case .input(let input):
      systemImage = "link.badge.plus"
      canRetry = false
      switch input {
      case .backendURLMissing:
        title = String(localized: "Paste a pairing link")
        message = String(localized: "Pairing links look like https://your-computer/pair#token=…")
      case .pairingURLInvalid, .backendURLInvalid:
        title = String(localized: "That isn't a pairing link")
        message = String(localized: "Pairing links look like https://your-computer/pair#token=…")
      case .tokenMissing, .codeMissing:
        title = String(localized: "The pairing code is missing")
        message = String(localized: "Copy the whole link, including the part after #token=, or enter the code.")
      }
    case .claimsSavedEnvironment(let label):
      systemImage = "exclamationmark.shield"
      canRetry = false
      title = String(localized: "That address claims to be \(label)")
      message = String(
        localized:
          "\(label) is already saved with a different address. Remove it from Computers first if it really moved.")
    case .connection(let error):
      (title, message, systemImage, canRetry) = Self.describe(error, host: host)
    }
  }

  private static func describe(_ error: ConnectionError, host: String) -> (String, String, String, Bool) {
    switch error {
    case .pairingInput:
      return (
        String(localized: "That isn't a pairing link"),
        String(localized: "Pairing links look like https://your-computer/pair#token=…"), "link.badge.plus", false
      )
    case .credentialRejected:
      return (
        String(localized: "This pairing link has expired or was already used"),
        String(
          localized:
            "Pairing links work once and expire after a few minutes. Create a new one on your computer and scan it again."
        ), "clock.badge.xmark", false
      )
    case .incompatibleProtocol(let version) where version < EnvironmentDescriptor.supportedProtocolVersion:
      return (
        String(localized: "\(host) runs an older Ankiel Code"),
        String(localized: "Update Ankiel Code on that computer, then pair again."), "arrow.up.circle", false
      )
    case .incompatibleProtocol, .socketRefused(426):
      return (
        String(localized: "This app is too old for \(host)"),
        String(localized: "Update Ankiel Code on this device, then pair again."), "arrow.up.circle", false
      )
    case .environmentMismatch:
      return (
        String(localized: "A different computer answered"),
        String(localized: "The address reached another Ankiel Code computer than the link was made for."),
        "exclamationmark.shield", false
      )
    case .clockSkew:
      return (
        String(localized: "This device's clock is off"),
        String(localized: "Turn on automatic date and time in Settings, then try again."), "clock.badge.exclamationmark",
        true
      )
    case .unreachable, .socket, .timedOut:
      return (
        String(localized: "Couldn't reach \(host)"),
        String(
          localized:
            "Make sure Ankiel Code is running on that computer and this device can reach it: the same Wi-Fi, your tailnet, or the relay."
        ), "wifi.exclamationmark", true
      )
    case .socketRefused(let status):
      return (
        String(localized: "\(host) refused the connection"),
        String(localized: "The server answered with HTTP \(status). Try again in a moment."), "xmark.octagon", true
      )
    case .rpc, .configStreamEnded:
      return (
        String(localized: "The connection dropped"),
        String(localized: "\(host) closed the connection while pairing. Try again in a moment."), "bolt.horizontal",
        true
      )
    }
  }
}
