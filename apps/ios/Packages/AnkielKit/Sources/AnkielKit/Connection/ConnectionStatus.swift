import Foundation

/// Why a connect attempt or a live session failed, in terms a UI can explain. The kit stays
/// language-neutral; the app turns causes into localized text.
public struct ConnectionFailure: Sendable, Hashable {
  public enum Cause: Sendable, Hashable {
    /// The host did not answer (network error, refused, DNS).
    case unreachable
    case timedOut
    /// A different environment answered at the saved address.
    case environmentMismatch(found: String)
    /// The server refused the credential after one renewal: revoked, expired or unpaired.
    case credentialRejected
    /// The server refused a DPoP proof's timestamp: this device's clock is off.
    case clockSkew
    /// The server speaks an older orchestration protocol than this app.
    case serverTooOld(serverProtocol: Int)
    /// The server speaks a newer protocol (or refused this client's).
    case serverTooNew(serverProtocol: Int)
    case socketRefused(status: Int)
    /// The server closed a live session, or the socket dropped.
    case sessionEnded
    /// The server sent something this client could not read.
    case protocolError
  }

  /// Where in the path the failure happened, for the diagnosis view.
  public enum Hop: Sendable, Hashable { case device, server }

  public var cause: Cause
  /// Technical detail for diagnostics (not shown as the headline).
  public var detail: String?
  public var httpStatus: Int?

  public init(_ cause: Cause, detail: String? = nil, httpStatus: Int? = nil) {
    self.cause = cause
    self.detail = detail
    self.httpStatus = httpStatus
  }

  public var hop: Hop {
    switch cause {
    case .clockSkew: .device
    default: .server
    }
  }

  /// Failures that retrying on a timer cannot fix. They wait for a wakeup (retry, foreground,
  /// network change) instead of backing off forever.
  public var isBlocking: Bool {
    switch cause {
    case .environmentMismatch, .credentialRejected, .clockSkew, .serverTooOld, .serverTooNew: true
    case .unreachable, .timedOut, .socketRefused, .sessionEnded, .protocolError: false
    }
  }

  public init(_ error: ConnectionError) {
    switch error {
    case .pairingInput:
      self.init(.protocolError, detail: String(describing: error))
    case .unreachable(let detail), .socket(let detail):
      self.init(.unreachable, detail: detail)
    case .environmentMismatch(_, let found):
      self.init(Cause.environmentMismatch(found: found))
    case .incompatibleProtocol(let version):
      self.init(
        version < EnvironmentDescriptor.supportedProtocolVersion
          ? .serverTooOld(serverProtocol: version) : .serverTooNew(serverProtocol: version))
    case .credentialRejected:
      self.init(.credentialRejected, httpStatus: 401)
    case .clockSkew:
      self.init(.clockSkew, httpStatus: 401)
    case .socketRefused(let status):
      // 426: the server refused this client's orchestration protocol.
      self.init(
        status == 426 ? .serverTooNew(serverProtocol: EnvironmentDescriptor.supportedProtocolVersion + 1)
          : .socketRefused(status: status), httpStatus: status)
    case .rpc(let rpc):
      self.init(.protocolError, detail: String(describing: rpc))
    case .configStreamEnded:
      self.init(Cause.sessionEnded)
    case .timedOut:
      self.init(Cause.timedOut)
    }
  }
}

/// One environment's transport state, as the UI shows it. Mirrors the RN presentation phases
/// (`connection/presentation.ts`): the first attempt is "connecting", later ones "reconnecting".
/// This is transport health only; shell freshness is tracked separately.
public enum ConnectionStatus: Sendable, Hashable {
  case connecting
  case connected
  /// Backing off (`retryAt` set) or trying again (`retryAt` nil) after a transient failure.
  case reconnecting(attempt: Int, retryAt: Date?, lastFailure: ConnectionFailure?)
  /// The device reports no network; waits for the network to return.
  case offline
  /// The credential was rejected: pair again.
  case needsPairing(ConnectionFailure)
  /// The server and this app speak different protocol versions.
  case incompatible(ConnectionFailure)
  /// Blocked on something else a timer cannot fix (another machine answered, clock skew).
  case failed(ConnectionFailure)
  /// Turned off on this device; nothing connects until it is turned back on.
  case disabled

  public var isConnected: Bool { self == .connected }

  public var lastFailure: ConnectionFailure? {
    switch self {
    case .connecting, .connected, .offline, .disabled: nil
    case .reconnecting(_, _, let failure): failure
    case .needsPairing(let failure), .incompatible(let failure), .failed(let failure): failure
    }
  }

  public var attempt: Int {
    if case .reconnecting(let attempt, _, _) = self { attempt } else { 0 }
  }

  public var isRetrying: Bool {
    switch self {
    case .connecting, .reconnecting: true
    default: false
    }
  }
}

/// What woke the supervisor. Wakeups probe a live session rather than replacing it.
public enum ConnectionWakeup: Sendable, Hashable {
  /// The app came to the foreground.
  case foreground
  /// The network path changed. `online` is the OS's report, which is often wrong for loopback.
  case networkChanged(online: Bool)
  /// The user asked to retry.
  case retry

  var resetsBackoff: Bool {
    switch self {
    case .foreground, .retry: true
    case .networkChanged(let online): online
    }
  }
}
