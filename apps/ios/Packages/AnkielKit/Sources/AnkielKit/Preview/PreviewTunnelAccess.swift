import Foundation

/// The computer's loopback tunnel (`/api/preview/tunnel`) with a media ticket, for a device
/// preview's proxy (RN `createPreviewTunnelUrlReader`). A ticket is reused until shortly before it
/// expires and is re-minted for each new session, so a route switch tunnels through the new route.
public enum PreviewTunnel {
  public static let route = "/api/preview/tunnel"
  public static let ticketRoute = "/api/auth/websocket-ticket/media"
  /// A ticket this close to expiry is replaced before a connection uses it.
  public static let refreshMargin: TimeInterval = 30
  /// How long a page waits for a reconnecting computer before its load fails.
  public static let accessTimeout: Duration = .seconds(10)

  /// `{wsBase}/api/preview/tunnel?wsTicket=…` (the relay prefix survives through the endpoint).
  public static func baseURL(endpoint: EnvironmentEndpoint, ticket: String) -> URL? {
    var components = URLComponents(url: endpoint.socketURL(route), resolvingAgainstBaseURL: false)
    components?.percentEncodedQuery = "wsTicket=\(FormEncoding.escape(ticket))"
    return components?.url
  }

  public static func isReusable(expiresAt: Date?, now: Date) -> Bool {
    guard let expiresAt else { return false }
    return expiresAt.timeIntervalSince(now) > refreshMargin
  }
}

/// Mints and keeps tunnel tickets per computer.
@MainActor
public final class PreviewTunnelTickets {
  private struct Cached {
    var session: ObjectIdentifier
    var url: URL
    var expiresAt: Date?
  }

  private let registry: EnvironmentRegistry
  private var cache: [String: Cached] = [:]
  private var minting: [String: Task<URL?, Never>] = [:]

  public init(registry: EnvironmentRegistry) {
    self.registry = registry
  }

  /// A ticketed tunnel URL, waiting a little for a reconnecting computer; nil when it stays out of
  /// reach or refuses a ticket.
  public func url(for environmentId: String) async -> URL? {
    guard let session = await liveSession(environmentId) else { return nil }
    let id = ObjectIdentifier(session)
    if let cached = cache[environmentId], cached.session == id,
      PreviewTunnel.isReusable(expiresAt: cached.expiresAt, now: .now)
    {
      return cached.url
    }
    if let pending = minting[environmentId] { return await pending.value }
    let task = Task<URL?, Never> {
      guard
        let ticket = try? await session.postJSON(
          PreviewTunnel.ticketRoute, body: EmptyObject(), as: WebSocketTicket.self),
        let url = PreviewTunnel.baseURL(endpoint: session.route.endpoint, ticket: ticket.ticket)
      else { return nil }
      cache[environmentId] = Cached(session: id, url: url, expiresAt: ticket.expiresAt.date)
      return url
    }
    minting[environmentId] = task
    let url = await task.value
    minting[environmentId] = nil
    return url
  }

  private func liveSession(_ environmentId: String) async -> (any LiveSession)? {
    if let session = registry.environment(environmentId)?.session { return session }
    let registry = registry
    let waiter = Task { @MainActor () -> (any LiveSession)? in
      for await _ in Observations({ registry.environment(environmentId)?.activeRoute }) {
        if let session = registry.environment(environmentId)?.session { return session }
      }
      return nil
    }
    let timeout = Task {
      try? await Task.sleep(for: PreviewTunnel.accessTimeout)
      waiter.cancel()
    }
    defer { timeout.cancel() }
    return await waiter.value
  }
}
