import AnkielKit
import Foundation
import SwiftUI

/// Connection status as words and colors, ported from `connection/presentation.ts`,
/// `connection/diagnosis.ts` and the RN `environmentStatusText.ts`.
enum ConnectionPresentation {
  /// One line under an environment's name.
  static func statusText(_ status: ConnectionStatus, host: String) -> String {
    switch status {
    case .connecting:
      return String(localized: "Connecting…")
    case .connected:
      return String(localized: "Connected", comment: "connection status")
    case .reconnecting(_, _, let failure):
      if let failure {
        return String(localized: "Could not connect: \(reason(failure, host: host)) Reconnecting…")
      }
      return String(localized: "Reconnecting…")
    case .offline:
      return String(localized: "Offline", comment: "connection status")
    case .needsPairing:
      return String(localized: "Needs pairing again")
    case .disabled:
      return String(localized: "Turned off on this device")
    case .incompatible(let failure), .failed(let failure):
      return reason(failure, host: host)
    }
  }

  /// A short title for the home indicator.
  static func indicatorText(_ status: ConnectionStatus, host: String) -> String {
    switch status {
    case .offline: String(localized: "Offline", comment: "connection status")
    case .disabled: String(localized: "\(host) is turned off")
    case .needsPairing: String(localized: "\(host) needs pairing")
    case .incompatible, .failed: String(localized: "\(host) is unavailable")
    case .connecting, .reconnecting: String(localized: "Reconnecting to \(host)…")
    case .connected: String(localized: "Connected", comment: "connection status")
    }
  }

  /// The failure in one plain sentence.
  static func reason(_ failure: ConnectionFailure, host: String) -> String {
    switch failure.cause {
    case .unreachable: String(localized: "\(host) did not answer.")
    case .timedOut: String(localized: "\(host) did not respond in time.")
    case .environmentMismatch: String(localized: "A different machine answered at this address.")
    case .credentialRejected: String(localized: "This device's sign-in to \(host) expired or was revoked.")
    case .clockSkew: String(localized: "This device's clock is off.")
    case .serverTooOld: String(localized: "\(host) runs an older Ankiel Code.")
    case .serverTooNew: String(localized: "This app is too old for \(host).")
    case .socketRefused(let status): String(localized: "The server refused the connection (HTTP \(status)).")
    case .sessionEnded: String(localized: "The connection dropped.")
    case .protocolError: String(localized: "The server sent something this app couldn't read.")
    }
  }

  static func tint(_ status: ConnectionStatus) -> Color {
    switch status {
    case .connected: Palette.success
    case .connecting, .reconnecting: Palette.attention
    case .offline, .needsPairing, .incompatible, .failed: Palette.danger
    case .disabled: Palette.textTertiary
    }
  }

  static func symbol(_ status: ConnectionStatus) -> String {
    switch status {
    case .offline: "wifi.slash"
    case .disabled: "power"
    case .needsPairing: "key.slash"
    case .incompatible: "arrow.up.circle"
    case .failed: "exclamationmark.triangle"
    case .connecting, .reconnecting: "arrow.triangle.2.circlepath"
    case .connected: "checkmark.circle"
    }
  }

  static func routeName(_ kind: ConnectionRouteKind) -> String {
    switch kind {
    case .relay: String(localized: "Relay")
    case .lan: String(localized: "Local network")
    case .tailnet: String(localized: "Tailnet")
    case .direct: String(localized: "Direct", comment: "a direct internet connection route")
    }
  }

  static func routeSymbol(_ kind: ConnectionRouteKind) -> String {
    switch kind {
    case .relay: "cloud"
    case .lan: "wifi"
    case .tailnet: "point.3.connected.trianglepath.dotted"
    case .direct: "globe"
    }
  }
}

/// What failed, in order, and what to try (`presentConnectionDiagnosis`). nil when nothing failed.
struct ConnectionDiagnosis {
  enum HopResult { case ok, failed, unchecked }

  struct Hop: Identifiable {
    let id: Int
    let label: String
    let result: HopResult
  }

  let headline: String
  let hops: [Hop]
  let steps: [String]
  let facts: [(label: String, value: String)]

  init?(status: ConnectionStatus, host: String, serverVersion: String?) {
    enum Cause { case offline, outdated, clockSkew }
    let failure = status.lastFailure
    let cause: Cause?
    let hop: ConnectionFailure.Hop
    switch (status, failure?.cause) {
    case (.offline, _):
      cause = .offline
      hop = .device
    case (_, .serverTooOld?):
      cause = .outdated
      hop = .server
    case (_, .clockSkew?):
      cause = .clockSkew
      hop = .device
    case (_, _?):
      cause = nil
      hop = failure?.hop ?? .server
    default:
      return nil
    }

    switch cause {
    case .offline:
      headline = String(localized: "This device is offline")
      steps = [String(localized: "Connect this device to the internet. Ankiel Code reconnects on its own.")]
    case .outdated:
      headline = String(localized: "\(host) runs an older Ankiel Code")
      steps = [String(localized: "Update Ankiel Code on \(host).")]
    case .clockSkew:
      headline = String(localized: "This device's clock is off")
      steps = [String(localized: "Turn on automatic date and time on this device and on \(host), then retry.")]
    case nil:
      if failure?.cause == .credentialRejected {
        headline = String(localized: "Ankiel Code on \(host) did not accept this device")
        steps = [
          String(
            localized:
              "This device's sign-in to \(host) expired or was revoked. Pair it again with a new pairing link from \(host).")
        ]
      } else if case .serverTooNew? = failure?.cause {
        headline = String(localized: "This app is too old for \(host)")
        steps = [String(localized: "Update Ankiel Code on this device.")]
      } else if case .environmentMismatch? = failure?.cause {
        headline = String(localized: "A different machine answered for \(host)")
        steps = [
          String(localized: "The saved address now reaches another computer. Remove \(host) and pair it again.")
        ]
      } else {
        headline = String(localized: "Ankiel Code on \(host) did not answer")
        steps = [
          String(localized: "Make sure Ankiel Code is running on \(host)."),
          String(localized: "Retry. If it keeps failing, copy the diagnostics."),
        ]
      }
    }

    let order: [ConnectionFailure.Hop] = [.device, .server]
    let failedIndex = order.firstIndex(of: hop) ?? 1
    hops = order.enumerated().map { index, item in
      Hop(
        id: index,
        label: item == .device ? String(localized: "This device") : String(localized: "Ankiel Code on \(host)"),
        result: index == failedIndex ? .failed : (index < failedIndex ? .ok : .unchecked))
    }

    var facts: [(String, String)] = []
    func add(_ label: String, _ value: String?) {
      if let value, !value.isEmpty { facts.append((label, value)) }
    }
    add(String(localized: "Cause", comment: "diagnostics field label"), failure.map { String(describing: $0.cause) })
    add(String(localized: "HTTP status"), failure?.httpStatus.map(String.init))
    add(String(localized: "Attempts", comment: "diagnostics field label"), status.attempt > 0 ? String(status.attempt) : nil)
    if case .reconnecting(_, let retryAt?, _) = status {
      add(String(localized: "Next retry"), retryAt.formatted(.iso8601))
    }
    add(String(localized: "App version"), Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
    add(String(localized: "Host version"), serverVersion)
    add(String(localized: "Error", comment: "diagnostics field label"), failure?.detail)
    self.facts = facts
  }

  /// One plain-text block for bug reports.
  func text(host: String) -> String {
    let marks: [HopResult: String] = [.ok: "ok", .failed: "FAILED", .unchecked: "not checked"]
    return ([String(localized: "Ankiel Code connection to \(host): \(headline)"), ""]
      + hops.map { "\($0.label): \(marks[$0.result] ?? "")" } + [""]
      + facts.map { "\($0.label): \($0.value)" }).joined(separator: "\n")
  }
}
