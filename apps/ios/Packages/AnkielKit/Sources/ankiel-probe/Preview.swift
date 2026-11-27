import AnkielKit
import Foundation
import Network

/// `--preview-tunnel <port> [--closed-port <port>] [--preview-thread <threadId>]`: read-only.
/// Mints a media ticket, runs the app's SOCKS listener, and loads `http://localhost:<port>/`
/// through a URLSession whose only route to the stand-in host is that proxy, so a page that loads
/// came through the computer's tunnel. A closed port must fail as `port`, a bogus ticket must be
/// refused. With a thread, also lists its browser tabs.
func probePreviewTunnel(
  _ session: EnvironmentSession, environment: SavedEnvironment, connector: EnvironmentConnector, port: UInt16
) async throws {
  let vault = CredentialVault(environmentId: environment.environmentId, connector: connector)
  let ticket = try await connector.postJSON(
    PreviewTunnel.ticketRoute, body: EmptyObject(), endpoint: environment.endpoint, vault: vault, as: WebSocketTicket.self)
  print("media ticket:      expires \(ticket.expiresAt.rawValue)")
  guard let base = PreviewTunnel.baseURL(endpoint: environment.endpoint, ticket: ticket.ticket) else {
    throw ProbeFailure(description: "no tunnel URL")
  }
  print("tunnel base:       \(base.absoluteString.replacingOccurrences(of: ticket.ticket, with: "<ticket>"))")

  let good = try await fetchThroughTunnel(base: base, port: port, path: "/")
  print("tunnelled page:    status \(good.status), \(good.body.count) bytes, failure \(good.failure?.rawValue ?? "-")")
  print("  first line:      \(good.body.split(separator: "\n").first.map(String.init) ?? "")")
  print("  proxy:           \(good.counts.summary)")

  let closed = UInt16(argument("--closed-port") ?? "") ?? 9
  let refused = try await fetchThroughTunnel(base: base, port: closed, path: "/")
  print("closed port \(closed):    status \(refused.status), failure \(refused.failure?.rawValue ?? "-")")
  print("  proxy:           \(refused.counts.summary)")

  var bogus = URLComponents(url: base, resolvingAgainstBaseURL: false)!
  bogus.percentEncodedQuery = "wsTicket=not-a-ticket"
  let rejected = try await fetchThroughTunnel(base: bogus.url!, port: port, path: "/")
  print("bogus ticket:      status \(rejected.status), failure \(rejected.failure?.rawValue ?? "-")")

  if let threadId = argument("--preview-thread") {
    let list = try await session.rpc.call(
      PreviewListRequest.rpcTag, payload: PreviewListRequest(threadId: threadId), as: PreviewList.self)
    var state = PreviewTabsState()
    state.apply(list: list)
    print("browser tabs:      \(list.sessions.count) (server \(state.serverTabs.count)) epoch \(list.serverEpoch) rev \(list.revision)")
    for tab in state.serverTabs { print("  \(tab.tabId): \(tab.displayTitle ?? "New tab") \(tab.url)") }
  }
}

private struct TunnelFetch {
  var status: Int
  var body: String
  var failure: PreviewTunnelFailure?
  var counts: PreviewTunnelCounts
}

private func fetchThroughTunnel(base: URL, port: UInt16, path: String) async throws -> TunnelFetch {
  let listener = PreviewSocksListener { base }
  let proxyPort: UInt16 = try await withCheckedThrowingContinuation { continuation in
    let once = Once()
    listener.start(
      onReady: { port in if once.claim() { continuation.resume(returning: port) } },
      onFailed: { if once.claim() { continuation.resume(throwing: ProbeFailure(description: "listener failed")) } })
  }
  defer { listener.stop() }
  let configuration = URLSessionConfiguration.ephemeral
  var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxyPort)!))
  proxy.matchDomains = [PreviewLoopback.standInHost]
  proxy.allowFailover = false
  configuration.proxyConfigurations = [proxy]
  configuration.timeoutIntervalForRequest = 20
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let url = PreviewLoopback.standIn(URL(string: "http://localhost:\(port)\(path)")!)
  do {
    let (data, response) = try await session.data(from: url)
    return TunnelFetch(
      status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: String(decoding: data, as: UTF8.self),
      failure: listener.lastFailure, counts: listener.diagnostics)
  } catch {
    return TunnelFetch(status: 0, body: "\(error.localizedDescription)", failure: listener.lastFailure, counts: listener.diagnostics)
  }
}

private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}

/// `--preview-seed <url>`: a Replay thread in the probe project whose message links `url`, for
/// opening a preview from a real thread in the app. Prints its id; `--preview-delete <id>` removes it.
func probePreviewSeed(_ session: EnvironmentSession, url: String) async throws {
  let (result, launch) = try await launchReplayThread(
    session, scenario: "showcase", text: "Check the page at [the tide preview](\(url)) and \(url)", runtimeMode: .fullAccess)
  print("seeded thread:     \(launch.threadId) (sequence \(result.sequence.map(String.init) ?? "-"))")
}
