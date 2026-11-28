import AnkielKit
import Foundation

/// Debug launch hooks for device previews (README, "Debug hooks"), in the thread a launch opens (an
/// `ANKIEL_OPEN_URL` thread link or `ANKIEL_DEBUG_THREAD` fixture), once per launch:
/// `ANKIEL_DEBUG_PREVIEW=start` opens the empty browser, `open:<url>` opens that address (a
/// `localhost` URL goes through the tunnel), `host` only installs the link handling. `ANKIEL_DEBUG_PREVIEW_STATE=<state>` shows a state
/// with no server: `port`, `environment`, `outdated`, `disabled`, `permission`, `setup`, `page`,
/// `tunnel-off`. `ANKIEL_DEBUG_PREVIEW_TABS=fixture` lists two synthetic browser tabs.
@MainActor
enum PreviewDebug {
  #if DEBUG
    private static var opened = false
    private static var environment: [String: String] { ProcessInfo.processInfo.environment }
    private static var state: String? { environment["ANKIEL_DEBUG_PREVIEW_STATE"] }
  #endif

  /// A hook is set, so fixture threads get a preview host too.
  static var isEnabled: Bool {
    #if DEBUG
      environment["ANKIEL_DEBUG_PREVIEW"] != nil
    #else
      false
    #endif
  }

  static var tunnelOff: Bool {
    #if DEBUG
      state == "tunnel-off"
    #else
      false
    #endif
  }

  static var permissionMissing: Bool {
    #if DEBUG
      state == "permission"
    #else
      false
    #endif
  }

  static var tabs: [PreviewTab]? {
    #if DEBUG
      guard environment["ANKIEL_DEBUG_PREVIEW_TABS"] == "fixture" else { return nil }
      let now = WireTimestamp(.now)
      return [
        PreviewTab(
          threadId: "debug", tabId: "tab-1", navStatus: .success(url: "http://localhost:5173/", title: "Tide chart"),
          updatedAt: now),
        PreviewTab(
          threadId: "debug", tabId: "tab-2", navStatus: .success(url: "http://localhost:6006/?path=/story/tides", title: ""),
          updatedAt: now),
      ]
    #else
      nil
    #endif
  }

  static func apply(to presenter: PreviewPresenter) {
    #if DEBUG
      guard !opened, let value = environment["ANKIEL_DEBUG_PREVIEW"], value != "host" else { return }
      opened = true
      Task {
        try? await Task.sleep(for: .milliseconds(800))
        if value.hasPrefix("open:") {
          presenter.open(URL(string: String(value.dropFirst(5))))
        } else {
          presenter.open(nil)
        }
      }
    #endif
  }

  static func apply(to browser: PreviewBrowser) {
    #if DEBUG
      guard let state else { return }
      let address = URL(string: "http://localhost:5173/")
      let failure: PreviewFailure? =
        switch state {
        case "port": .tunnel(.port)
        case "environment": .tunnel(.environment)
        case "outdated": .tunnel(.outdated)
        case "disabled": .tunnel(.disabled)
        case "setup": .setup
        case "page": .page(String(localized: "The Internet connection appears to be offline.", comment: "debug"))
        default: nil
        }
      guard let failure else { return }
      Task {
        try? await Task.sleep(for: .milliseconds(300))
        browser.debugShow(failure, address: address)
      }
    #endif
  }
}
