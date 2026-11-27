import AnkielKit
import SwiftUI
import WebKit

/// Why a device preview shows no page.
enum PreviewFailure: Equatable {
  /// The tunnel refused or could not open (RN's causes, plus the server switch and the scope).
  case tunnel(PreviewTunnelFailure)
  /// A page that is not the computer's failed on its own (offline, a bad certificate).
  case page(String)
  /// The proxy listener could not start on this device.
  case setup
}

/// One device preview: a web view whose `localhost` is a computer's loopback, reached through its
/// tunnel (RN `AnkielTunnelWebView` and `LocalPreviewScreen`). Main actor only.
@MainActor @Observable
final class PreviewBrowser: NSObject {
  let environmentId: String
  /// The address the bar shows: the page's, else the one asked for (a failed load reports none).
  private(set) var address: URL?
  private(set) var title = ""
  private(set) var isLoading = false
  private(set) var progress: Double = 0
  private(set) var canGoBack = false
  private(set) var canGoForward = false
  private(set) var failure: PreviewFailure?
  /// What the proxy saw at the last failure, so a report carries it.
  private(set) var diagnostics: String?
  /// Pages committed through the tunnel since this preview opened.
  private(set) var tunnelledLoads = 0
  /// The proxy is listening and the web view exists.
  private(set) var isReady = false

  @ObservationIgnored private(set) var webView: WKWebView?
  @ObservationIgnored private let proxy: PreviewProxy
  @ObservationIgnored private var pending: URL?
  @ObservationIgnored private var requested: URL?
  /// A link that failed before its page committed leaves the old page current, so retry it.
  @ObservationIgnored private var failedURL: URL?
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []

  init(environmentId: String, registry: EnvironmentRegistry, initial: URL?) {
    self.environmentId = environmentId
    proxy = PreviewProxy.forEnvironment(environmentId, registry: registry)
    address = initial
    pending = initial
    super.init()
    proxy.ensureListening { [weak self] port in
      guard let self else { return }
      if let port { attach(port: port) } else { failure = .setup }
    }
  }

  private func attach(port: UInt16) {
    guard webView == nil else { return }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = proxy.store(proxyPort: port)
    configuration.allowsInlineMediaPlayback = true
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.isInspectable = true
    webView.isOpaque = false
    webView.backgroundColor = .clear
    self.webView = webView
    isReady = true
    observations = [
      webView.observe(\.url) { [weak self] _, _ in MainActor.assumeIsolated { self?.sync() } },
      webView.observe(\.title) { [weak self] _, _ in MainActor.assumeIsolated { self?.sync() } },
      webView.observe(\.isLoading) { [weak self] _, _ in MainActor.assumeIsolated { self?.sync() } },
      webView.observe(\.canGoBack) { [weak self] _, _ in MainActor.assumeIsolated { self?.sync() } },
      webView.observe(\.canGoForward) { [weak self] _, _ in MainActor.assumeIsolated { self?.sync() } },
      webView.observe(\.estimatedProgress) { [weak self] _, _ in MainActor.assumeIsolated { self?.sync() } },
    ]
    if let pending {
      self.pending = nil
      navigate(pending)
    }
  }

  private func sync() {
    guard let webView else { return }
    if let url = webView.url { address = PreviewLoopback.shown(url) }
    title = webView.title ?? ""
    if webView.isLoading, !isLoading { failure = nil }
    isLoading = webView.isLoading
    progress = webView.estimatedProgress
    canGoBack = webView.canGoBack
    canGoForward = webView.canGoForward
  }

  /// Opens `url`, even when it is the page already showing.
  func navigate(_ url: URL) {
    failure = nil
    address = url
    guard let webView else {
      pending = url
      return
    }
    let target = PreviewLoopback.standIn(url)
    requested = target
    webView.load(URLRequest(url: target))
  }

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  func stop() { webView?.stopLoading() }

  /// After a failed load the web view may show no page or the previous one, so this retries what
  /// failed, restarting the listener first if iOS tore it down.
  func reload() {
    failure = nil
    proxy.ensureListening { [weak self] port in
      guard let self else { return }
      guard port != nil, let webView else {
        failure = .setup
        return
      }
      if let target = failedURL ?? (webView.url == nil ? requested : nil) {
        failedURL = nil
        webView.load(URLRequest(url: target))
      } else {
        webView.reload()
      }
    }
  }

  #if DEBUG
    /// Renders a failure without a server (README, "Previews").
    func debugShow(_ failure: PreviewFailure, address: URL?) {
      self.failure = failure
      self.address = address ?? self.address
      diagnostics = "debug \(PreviewTunnelCounts().summary)"
    }
  #endif

  private func report(_ error: any Error) {
    let error = error as NSError
    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return }
    if error.domain == "WebKitErrorDomain", error.code == 102 { return }  // frame load interrupted (a download)
    let failing = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL
    // A link to another port fails with that port's address, not the one typed earlier.
    if let failing { address = PreviewLoopback.shown(failing) }
    let tunnelled = (failing ?? requested).map(PreviewLoopback.isTunnelled) ?? false
    if tunnelled {
      let cause = proxy.lastAccessGranted ? (proxy.lastFailure ?? .environment) : .environment
      failure = .tunnel(cause)
    } else {
      failure = .page(error.localizedDescription)
    }
    diagnostics = "\(error.domain) \(error.code), port \(proxy.proxyPort.map(String.init) ?? "none"), \(proxy.diagnostics.summary)"
  }
}

extension PreviewBrowser: WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    let nsError = error as NSError
    if !(nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) {
      failedURL = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL ?? requested
    }
    report(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    report(error)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    failedURL = nil
    if let url = webView.url, PreviewLoopback.isTunnelled(url) { tunnelledLoads += 1 }
  }

  /// Links and redirects to loopback go to the stand-in host, which is the one the proxy carries.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame ?? true,
      PreviewLoopback.standIn(url) != url
    else { return decisionHandler(.allow) }
    decisionHandler(.cancel)
    // The same request at the stand-in host, so a form keeps its method, headers and body.
    var request = navigationAction.request
    let target = PreviewLoopback.standIn(url)
    request.url = target
    requested = target
    webView.load(request)
  }
}

/// The browser's web view in SwiftUI; empty until the proxy is listening.
struct PreviewWebView: UIViewRepresentable {
  let browser: PreviewBrowser

  func makeUIView(context: Context) -> UIView {
    let container = UIView()
    container.backgroundColor = .clear
    install(in: container)
    return container
  }

  func updateUIView(_ container: UIView, context: Context) {
    install(in: container)
  }

  private func install(in container: UIView) {
    guard let webView = browser.webView, webView.superview !== container else { return }
    webView.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      webView.topAnchor.constraint(equalTo: container.topAnchor),
      webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
  }
}
