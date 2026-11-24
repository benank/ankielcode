import ExpoModulesCore
import Foundation

public final class AnkielPreviewTunnelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AnkielPreviewTunnel")

    Function("resolveAccess") { (requestId: String, url: String?) in
      AnkielTunnelAccess.shared.resolve(requestId: requestId, url: url)
    }

    View(AnkielTunnelWebView.self) {
      Events("onAccessRequest", "onNavigationChange", "onLoadError", "onPageScroll")

      Prop("environmentId") { (view: AnkielTunnelWebView, environmentId: String) in
        view.setEnvironment(environmentId)
      }

      Prop("topInset") { (view: AnkielTunnelWebView, inset: Double) in
        view.setTopInset(CGFloat(inset))
      }

      Prop("url") { (view: AnkielTunnelWebView, url: String) in
        view.load(url)
      }

      AsyncFunction("loadUrl") { (view: AnkielTunnelWebView, url: String) in
        view.navigate(url)
      }.runOnQueue(.main)

      AsyncFunction("goBack") { (view: AnkielTunnelWebView) in
        view.goBack()
      }.runOnQueue(.main)

      AsyncFunction("goForward") { (view: AnkielTunnelWebView) in
        view.goForward()
      }.runOnQueue(.main)

      AsyncFunction("reload") { (view: AnkielTunnelWebView) in
        view.reload()
      }.runOnQueue(.main)
    }
  }
}

/// Pending asks for a tunnel URL. JavaScript owns the environment's credentials and the route in
/// use, so every connection asks it for a freshly ticketed URL.
final class AnkielTunnelAccess {
  static let shared = AnkielTunnelAccess()

  private let lock = NSLock()
  private var pending: [String: (String?) -> Void] = [:]
  private var nextId = 0

  func request(ask: (String) -> Void, completion: @escaping (String?) -> Void) {
    let requestId: String = lock.withLock {
      nextId += 1
      let requestId = "preview-tunnel-\(nextId)"
      pending[requestId] = completion
      return requestId
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 15) { [weak self] in
      self?.resolve(requestId: requestId, url: nil)
    }
    ask(requestId)
  }

  func resolve(requestId: String, url: String?) {
    let completion = lock.withLock { pending.removeValue(forKey: requestId) }
    completion?(url)
  }
}
