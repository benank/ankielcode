/// What a shown terminal does when its status changes (RN `transitionTerminalLifecycle`, without
/// the read-only observer): a shell that ends while attached is closed and left; an ended shell
/// the user visits on purpose is started again, once.
public struct TerminalLifecycle: Sendable, Hashable {
  public var wasRunning = false
  public var reopened = false

  public init() {}

  public enum Command: Sendable, Hashable {
    /// Close it on the server and leave the screen.
    case exit
    /// Start the ended shell again (`terminal.open`).
    case reopen
  }

  public mutating func detached() {
    wasRunning = false
  }

  public mutating func reopenFailed() {
    reopened = false
  }

  /// `version` 0 is "nothing arrived yet".
  public mutating func status(_ status: TerminalStatus, version: Int) -> Command? {
    guard version > 0 else { return nil }
    if status.isLive {
      wasRunning = true
      reopened = false
      return nil
    }
    guard status == .closed || status == .exited else { return nil }
    if wasRunning {
      wasRunning = false
      reopened = true
      return .exit
    }
    if reopened { return nil }
    reopened = true
    return .reopen
  }
}
