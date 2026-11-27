import AnkielKit
import Foundation

/// Debug launch hooks for the terminal (README, "Terminal"). In the thread a launch opens (an
/// `ANKIEL_OPEN_URL` thread link), once per launch: `ANKIEL_DEBUG_TERMINAL` opens the terminal
/// (`open`, `open:<terminalId>`, `new`); `ANKIEL_DEBUG_TERMINAL_SEND` types its text once the
/// shell is live (`\r` is Enter); `ANKIEL_DEBUG_TERMINAL_KEYBOARD=1` shows the keyboard and its
/// accessory bar; `ANKIEL_DEBUG_TERMINAL_SELECT=1` opens "Select text" a moment after the send.
/// `ANKIEL_DEBUG_TERMINAL_HISTORY=<folder>` points a new shell's history files there. The shell is
/// real: send only harmless commands.
@MainActor
enum TerminalDebug {
  #if DEBUG
    private static var opened = false
    private static var sent = false
    private static var environment: [String: String] { ProcessInfo.processInfo.environment }
  #endif

  /// Extra environment for shells a debug launch starts.
  static var env: [String: String]? {
    #if DEBUG
      environment["ANKIEL_DEBUG_TERMINAL_HISTORY"].map { ["HISTFILE": "\($0)/.history", "LESSHISTFILE": "-"] }
    #else
      nil
    #endif
  }

  static func apply(to presenter: TerminalPresenter) {
    #if DEBUG
      guard !opened, let value = environment["ANKIEL_DEBUG_TERMINAL"] else { return }
      Task {
        // The workspace arrives with the shell, the permission with the session.
        for _ in 0..<150 where !presenter.canOpen { try? await Task.sleep(for: .milliseconds(100)) }
        guard !opened, presenter.canOpen else { return }
        opened = true
        if value == "new" {
          for _ in 0..<50 where presenter.directory.terminals == nil { try? await Task.sleep(for: .milliseconds(100)) }
          presenter.openNew()
        } else if value.hasPrefix("open:") {
          presenter.open(String(value.dropFirst(5)))
        } else {
          presenter.open()
        }
      }
    #endif
  }

  static func applyToSession(_ session: TerminalSessionModel, focus: @escaping () -> Void, select: @escaping () -> Void) {
    #if DEBUG
      guard !sent else { return }
      let text = environment["ANKIEL_DEBUG_TERMINAL_SEND"]?.replacingOccurrences(of: "\\r", with: "\r")
      let keyboard = environment["ANKIEL_DEBUG_TERMINAL_KEYBOARD"] == "1"
      let selecting = environment["ANKIEL_DEBUG_TERMINAL_SELECT"] == "1"
      guard text != nil || keyboard || selecting else { return }
      sent = true
      Task {
        for _ in 0..<150 where !session.isLive { try? await Task.sleep(for: .milliseconds(100)) }
        guard session.isLive else { return }
        if keyboard { focus() }
        try? await Task.sleep(for: .milliseconds(600))
        if let text { session.write(text) }
        if selecting {
          try? await Task.sleep(for: .seconds(2))
          select()
        }
      }
    #endif
  }
}
