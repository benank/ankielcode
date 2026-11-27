import Foundation
import Observation

/// Where a computer's access list comes from and where its changes go: the registry's live
/// sessions, or a fake for fixtures and tests.
public protocol AccessService: AnyObject, Sendable {
  /// The next session's `subscribeAuthAccess` stream after `previous`; nil when the computer is
  /// gone. Waits while the computer is offline.
  @MainActor func nextStream(after previous: ObjectIdentifier?) async
    -> (id: ObjectIdentifier, events: AsyncThrowingStream<AccessStreamEvent, any Error>)?
  @MainActor func createPairingLink(_ request: CreatePairingLinkRequest) async throws(EnvironmentRequestError) -> PairingCredential
  @MainActor func revokePairingLink(_ id: String) async throws(EnvironmentRequestError) -> Bool
  @MainActor func revokeClient(_ sessionId: String) async throws(EnvironmentRequestError) -> Bool
}

/// One computer's pairing links and signed-in devices (web "Sharing & access"), followed across
/// reconnects while the page shows. Codes of links made here are kept in memory only: the server
/// never shows a code again.
@MainActor @Observable
public final class AccessDirectory {
  public enum State: Sendable, Hashable {
    /// Waiting for the first snapshot (or for the computer to connect).
    case loading
    case live
    /// The session lacks `access:read`.
    case denied(String?)
    /// The stream failed for another reason; it is retried at the next session.
    case failed(String)
  }

  public private(set) var state: State = .loading
  public private(set) var snapshot = AccessSnapshot()
  /// Codes of the links this device created, by link id.
  public private(set) var codes: [String: String] = [:]
  /// The link to open the share panel for, right after it was created.
  public var justCreated: String?

  @ObservationIgnored private let service: any AccessService
  @ObservationIgnored private var run: Task<Void, Never>?

  public init(service: any AccessService) {
    self.service = service
  }

  public func start() {
    guard run == nil else { return }
    run = Task { [weak self] in await self?.follow() }
  }

  public func stop() {
    run?.cancel()
    run = nil
  }

  /// Creates a link; its code is kept for sharing.
  @discardableResult
  public func createLink(label: String?, scopes: [String]) async throws(EnvironmentRequestError) -> PairingCredential {
    let result = try await service.createPairingLink(CreatePairingLinkRequest(label: label, scopes: scopes))
    codes[result.id] = result.credential
    justCreated = result.id
    // Show it now; the stream's upsert replaces this with the server's row.
    if !snapshot.pairingLinks.contains(where: { $0.id == result.id }) {
      snapshot.pairingLinks.append(
        AccessPairingLink(id: result.id, label: result.label, scopes: scopes, createdAt: WireTimestamp(.now), expiresAt: result.expiresAt))
    }
    return result
  }

  public func revokeLink(_ id: String) async throws(EnvironmentRequestError) {
    _ = try await service.revokePairingLink(id)
    snapshot.pairingLinks.removeAll { $0.id == id }
    codes[id] = nil
  }

  public func revokeSession(_ sessionId: String) async throws(EnvironmentRequestError) {
    _ = try await service.revokeClient(sessionId)
    snapshot.clientSessions.removeAll { $0.sessionId == sessionId }
  }

  /// Applies one stream event (tests drive this directly).
  func apply(_ event: AccessStreamEvent) {
    snapshot = event.applied(to: snapshot)
    state = .live
  }

  private func follow() async {
    var previous: ObjectIdentifier?
    while !Task.isCancelled {
      guard let next = await service.nextStream(after: previous) else { return }
      previous = next.id
      do {
        for try await event in next.events {
          apply(event)
        }
      } catch is CancellationError {
        return
      } catch RpcError.failed(let failure) {
        state = failure.tag == "EnvironmentAuthorizationError" ? .denied(failure.message) : .failed(failure.message ?? failure.tag ?? "")
      } catch {
        // Keep the last list while the computer reconnects.
      }
    }
  }
}

/// A computer of the registry as an access service.
@MainActor
public final class EnvironmentAccessService: AccessService {
  private let registry: EnvironmentRegistry
  private let environmentId: String

  public init(registry: EnvironmentRegistry, environmentId: String) {
    self.registry = registry
    self.environmentId = environmentId
  }

  public func nextStream(after previous: ObjectIdentifier?) async
    -> (id: ObjectIdentifier, events: AsyncThrowingStream<AccessStreamEvent, any Error>)?
  {
    let registry = registry
    let environmentId = environmentId
    for await _ in Observations({ registry.environment(environmentId)?.activeRoute }) {
      guard registry.environment(environmentId) != nil else { return nil }
      if let session = registry.environment(environmentId)?.session, ObjectIdentifier(session) != previous {
        let events = AsyncThrowingStream<AccessStreamEvent, any Error> { continuation in
          let task = Task {
            do {
              for try await event in try await session.stream(AccessRpc.subscribe, payload: EmptyObject(), of: AccessStreamEvent.self) {
                continuation.yield(event)
              }
              continuation.finish()
            } catch {
              continuation.finish(throwing: error)
            }
          }
          continuation.onTermination = { _ in task.cancel() }
        }
        return (ObjectIdentifier(session), events)
      }
    }
    return nil
  }

  public func createPairingLink(_ request: CreatePairingLinkRequest) async throws(EnvironmentRequestError) -> PairingCredential {
    try await registry.request(environmentId) { session in
      try await session.postJSON(CreatePairingLinkRequest.path, body: request, as: PairingCredential.self)
    }
  }

  public func revokePairingLink(_ id: String) async throws(EnvironmentRequestError) -> Bool {
    try await registry.request(environmentId) { session in
      try await session.postJSON(RevokePairingLinkRequest.path, body: RevokePairingLinkRequest(id: id), as: RevokeResult.self).revoked
    }
  }

  public func revokeClient(_ sessionId: String) async throws(EnvironmentRequestError) -> Bool {
    try await registry.request(environmentId) { session in
      try await session.postJSON(RevokeClientRequest.path, body: RevokeClientRequest(sessionId: sessionId), as: RevokeResult.self).revoked
    }
  }
}

#if DEBUG
/// Canned access lists for fixtures, screenshots and tests (synthetic devices). Writes change the
/// fake list like the server would; `fail` refuses them.
@MainActor
public final class FakeAccessService: AccessService {
  public enum Mode: Sendable { case normal, fail, denied }

  public let mode: Mode
  public private(set) var snapshot: AccessSnapshot
  public private(set) var writes: [String] = []
  private var continuation: AsyncThrowingStream<AccessStreamEvent, any Error>.Continuation?
  private final class Token {}
  private let token = Token()
  private var counter = 0

  private let delay: Duration

  public init(mode: Mode = .normal, snapshot: AccessSnapshot = FakeAccessService.sample(), delay: Duration = .milliseconds(250)) {
    self.mode = mode
    self.delay = delay
    self.snapshot = snapshot
  }

  public func nextStream(after previous: ObjectIdentifier?) async
    -> (id: ObjectIdentifier, events: AsyncThrowingStream<AccessStreamEvent, any Error>)?
  {
    guard previous != ObjectIdentifier(token) else { return nil }
    let (stream, continuation) = AsyncThrowingStream<AccessStreamEvent, any Error>.makeStream()
    if mode == .denied {
      continuation.finish(
        throwing: RpcError.failed(RpcFailure(error: ["_tag": "EnvironmentAuthorizationError", "message": "This session cannot view access."])))
    } else {
      continuation.yield(.snapshot(snapshot))
      self.continuation = continuation
    }
    return (ObjectIdentifier(token), stream)
  }

  public func createPairingLink(_ request: CreatePairingLinkRequest) async throws(EnvironmentRequestError) -> PairingCredential {
    try await answer("create")
    counter += 1
    let id = "link-fake-\(counter)"
    let expires = WireTimestamp(.now.addingTimeInterval(15 * 60))
    let link = AccessPairingLink(id: id, label: request.label, scopes: request.scopes, createdAt: WireTimestamp(.now), expiresAt: expires)
    emit(.pairingLinkUpserted(link))
    return PairingCredential(id: id, credential: "TIDE7K3MQ2PX", label: request.label, expiresAt: expires)
  }

  public func revokePairingLink(_ id: String) async throws(EnvironmentRequestError) -> Bool {
    try await answer("revoke-link \(id)")
    emit(.pairingLinkRemoved(id: id))
    return true
  }

  public func revokeClient(_ sessionId: String) async throws(EnvironmentRequestError) -> Bool {
    try await answer("revoke-client \(sessionId)")
    if snapshot.clientSessions.first(where: { $0.sessionId == sessionId })?.current == true {
      throw .rejected(message: "This session cannot revoke itself.", tag: "EnvironmentOperationForbiddenError")
    }
    emit(.clientRemoved(sessionId: sessionId))
    return true
  }

  private func answer(_ write: String) async throws(EnvironmentRequestError) {
    writes.append(write)
    if delay > .zero { try? await Task.sleep(for: delay) }
    if mode == .fail { throw .rejected(message: "Access is read-only on this computer right now.") }
  }

  private func emit(_ event: AccessStreamEvent) {
    snapshot = event.applied(to: snapshot)
    continuation?.yield(event)
  }

  /// This phone, a laptop browser that is online, an idle tablet, and one open link.
  public static func sample(now: Date = .now) -> AccessSnapshot {
    func at(_ offset: TimeInterval) -> WireTimestamp { WireTimestamp(now.addingTimeInterval(offset)) }
    let all = AuthScope.grants
    return AccessSnapshot(
      pairingLinks: [
        AccessPairingLink(id: "link-fixture-1", label: "Harbor iPad", scopes: PairingScopes.readOnly, createdAt: at(-120), expiresAt: at(780))
      ],
      clientSessions: [
        AccessClientSession(
          sessionId: "session-fixture-phone", scopes: all.filter { $0 != "terminal:operate" },
          client: AccessClientMetadata(label: "Tide iPhone", ipAddress: "192.168.1.31", deviceType: "mobile", os: "iOS"),
          issuedAt: at(-86_400 * 3), expiresAt: at(86_400 * 27), lastConnectedAt: at(-5), connected: true, current: true),
        AccessClientSession(
          sessionId: "session-fixture-laptop", scopes: all, method: "browser-session-cookie",
          client: AccessClientMetadata(deviceType: "desktop", os: "macOS", browser: "Safari"),
          issuedAt: at(-86_400 * 10), expiresAt: at(86_400 * 20), lastConnectedAt: at(-600), connected: true, current: false),
        AccessClientSession(
          sessionId: "session-fixture-tablet", scopes: PairingScopes.readOnly,
          client: AccessClientMetadata(label: "Galley tablet", ipAddress: "192.168.1.52", deviceType: "tablet", os: "Android"),
          issuedAt: at(-86_400 * 20), expiresAt: at(86_400 * 10), lastConnectedAt: at(-86_400 * 2), connected: false, current: false),
      ])
  }
}
#endif
