import AnkielKit
import Network
import UIKit
import WebKit

/// Each computer keeps one SOCKS listener on one port for the app's life, restarted there if iOS
/// tore it down, and one in-memory website data store pointed at it (RN `AnkielEnvironmentProxy`):
/// cookies survive closing a page and never reach another computer's pages. A store saved on disk
/// kept an old launch's proxy port on devices, so the store is not persistent.
@MainActor
final class PreviewProxy {
  private static var proxies: [String: PreviewProxy] = [:]
  private static var foregroundObserver: (any NSObjectProtocol)?
  private static var tickets: PreviewTunnelTickets?

  static func forEnvironment(_ environmentId: String, registry: EnvironmentRegistry) -> PreviewProxy {
    if let proxy = proxies[environmentId] { return proxy }
    // A real device can drop listening sockets while the app is suspended; the simulator never does.
    foregroundObserver = foregroundObserver
      ?? NotificationCenter.default.addObserver(
        forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
      ) { _ in
        MainActor.assumeIsolated {
          for proxy in proxies.values { proxy.ensureListening { _ in } }
        }
      }
    let tickets = tickets ?? PreviewTunnelTickets(registry: registry)
    Self.tickets = tickets
    let proxy = PreviewProxy(environmentId: environmentId, tickets: tickets)
    proxies[environmentId] = proxy
    return proxy
  }

  let environmentId: String
  private let tickets: PreviewTunnelTickets
  private var listener: PreviewSocksListener?
  private var port: UInt16?
  private var waiting: [(UInt16?) -> Void] = []
  private var dataStore: WKWebsiteDataStore?
  /// Whether the last connection got a tunnel URL at all (false: the computer was out of reach).
  private(set) var lastAccessGranted = true

  private init(environmentId: String, tickets: PreviewTunnelTickets) {
    self.environmentId = environmentId
    self.tickets = tickets
  }

  var lastFailure: PreviewTunnelFailure? { listener?.lastFailure }
  var diagnostics: PreviewTunnelCounts { listener?.diagnostics ?? PreviewTunnelCounts() }
  var proxyPort: UInt16? { port }

  func store(proxyPort: UInt16) -> WKWebsiteDataStore {
    if let dataStore { return dataStore }
    let store = WKWebsiteDataStore.nonPersistent()
    var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxyPort)!))
    // Only the stand-in host is the computer's; with no failover a dead tunnel errors instead of
    // reaching this device's own localhost.
    proxy.matchDomains = [PreviewLoopback.standInHost]
    proxy.allowFailover = false
    store.proxyConfigurations = [proxy]
    dataStore = store
    return store
  }

  /// Starts the listener, or restarts it on its port if iOS tore it down. Nil when it cannot start.
  func ensureListening(_ onReady: @escaping (UInt16?) -> Void) {
    if let port, listener?.isListening == true { return onReady(port) }
    waiting.append(onReady)
    guard waiting.count == 1 else { return }
    startListener(attempt: 0)
  }

  private func startListener(attempt: Int) {
    listener?.stop()
    let tickets = tickets
    let environmentId = environmentId
    let listener = PreviewSocksListener { [weak self] in
      let url = await tickets.url(for: environmentId)
      await MainActor.run { self?.lastAccessGranted = url != nil }
      return url
    }
    self.listener = listener
    listener.start(
      port: port,
      onReady: { [weak self] port in Task { @MainActor in self?.ready(port) } },
      onFailed: { [weak self, weak listener] in
        Task { @MainActor in
          guard let self, let listener, self.listener === listener else { return }
          if self.waiting.isEmpty { return self.ensureListening { _ in } }
          // Startup failed before it was ready: try again shortly, then give the waiters up so a
          // later reload starts over instead of queueing behind a listener that never came.
          guard attempt < 4 else {
            self.listener = nil
            let waiting = self.waiting
            self.waiting = []
            for onReady in waiting { onReady(nil) }
            return
          }
          try? await Task.sleep(for: .milliseconds(500))
          guard self.listener === listener, !self.waiting.isEmpty else { return }
          self.startListener(attempt: attempt + 1)
        }
      })
  }

  private func ready(_ port: UInt16) {
    self.port = port
    let waiting = self.waiting
    self.waiting = []
    for onReady in waiting { onReady(port) }
  }
}
