import Foundation

/// Which computer answers a pull request read or write (client-runtime `pullRequestRouting.ts`
/// and `pullRequestRoutingPermissions.ts`). A pull request is read by the computer it was opened
/// on unless the person trusts two computers to share: then another computer signed in to the
/// same host account may answer for it. Credentials never cross; only a verified host and account
/// do. Trust belongs to the saved addresses, never to an id a server advertises: adding or
/// changing an address revokes it, reordering does not (`docs/internals/05_remote.md`).
public enum PullRequestRoutingPermission: String, Sendable, Codable, CaseIterable {
  case off
  case read
  case readWrite = "read-write"
}

public struct StoredPullRequestRoutingPermission: Sendable, Hashable, Codable {
  public var environmentId: String
  public var connectionKey: String
  public var permission: PullRequestRoutingPermission
}

public enum PullRequestRoutingRules {
  /// The trust key over a computer's saved, non-learned addresses; nil when one is unusable.
  public static func connectionKey(_ record: EnvironmentRecord) -> String? {
    let routes = record.routes.filter { !$0.learned }
    let keys = routes.map { routeKey($0, environmentId: record.environmentId) }
    guard !keys.isEmpty, keys.allSatisfy({ $0 != nil }) else { return nil }
    let present = keys.compactMap(\.self)
    if present.count == 1 { return present[0] }
    return json(present.sorted())
  }

  static func routeKey(_ route: EnvironmentRoute, environmentId: String) -> String? {
    let http = route.endpoint.httpBaseURL
    let ws = route.endpoint.wsBaseURL
    guard ["http", "https"].contains(http.scheme?.lowercased() ?? ""), ["ws", "wss"].contains(ws.scheme?.lowercased() ?? ""),
      http.user == nil, http.password == nil, ws.user == nil, ws.password == nil
    else { return nil }
    func trimmed(_ url: URL) -> String {
      var text = url.absoluteString
      while text.hasSuffix("/") { text.removeLast() }
      return text
    }
    return json(["direct", environmentId, trimmed(http), trimmed(ws)])
  }

  static func json(_ values: [String]) -> String {
    (try? String(decoding: JSONEncoder().encode(values), as: UTF8.self)) ?? values.joined(separator: "\n")
  }

  public static func permission(_ record: EnvironmentRecord, in stored: [StoredPullRequestRoutingPermission]) -> PullRequestRoutingPermission {
    guard let key = connectionKey(record) else { return .off }
    return stored.first { $0.connectionKey == key }?.permission ?? .off
  }

  /// Both computers enabled and trusted: reads need any trust on both, writes read-write on both.
  public static func allowed(
    origin: EnvironmentRecord, destination: EnvironmentRecord, write: Bool, stored: [StoredPullRequestRoutingPermission]
  ) -> Bool {
    guard origin.enabled != false, destination.enabled != false else { return false }
    let source = permission(origin, in: stored)
    let target = permission(destination, in: stored)
    return write ? source == .readWrite && target == .readWrite : source != .off && target != .off
  }

  public static func setting(
    _ permission: PullRequestRoutingPermission, for record: EnvironmentRecord, in stored: [StoredPullRequestRoutingPermission]
  ) -> [StoredPullRequestRoutingPermission]? {
    guard let key = connectionKey(record) else { return nil }
    var next = stored.filter { $0.environmentId != record.environmentId }
    if permission != .off { next.append(.init(environmentId: record.environmentId, connectionKey: key, permission: permission)) }
    return next
  }

  /// Loopback addresses name this device's own computer.
  public static func isLocal(_ record: EnvironmentRecord) -> Bool {
    guard let host = record.pairedRoute?.endpoint.httpBaseURL.host()?.lowercased() else { return false }
    return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
  }

  /// The order computers are tried in: writes try a local origin first, then local
  /// alternatives, then a remote origin, then remote alternatives; reads try alternatives and
  /// end with the origin.
  public static func candidates(origin: String, originLocal: Bool, alternatives: [(id: String, local: Bool)], write: Bool) -> [String] {
    let local = alternatives.filter(\.local).map(\.id)
    let remote = alternatives.filter { !$0.local }.map(\.id)
    return (originLocal && write ? [origin] : []) + local + (!originLocal && write ? [origin] : []) + remote + (write ? [] : [origin])
  }

  /// An alternative may answer only for the same host account the origin verified.
  public static func sameAccount(_ identity: PullRequestRoutingResult, _ alternate: PullRequestRoutingIdentityResult?) -> Bool {
    guard let alternate else { return false }
    return alternate.provider == identity.provider && alternate.host.lowercased() == identity.host.lowercased()
      && alternate.accountId == identity.accountId
  }

  /// After a failure on `candidate`, whether to try the next one: any read, but a write only when
  /// it was refused before the server ran it (a retried write would comment or merge twice).
  public static func shouldTryNext(after error: PullRequestError, write: Bool) -> Bool {
    !write || error.rejectedBeforeDispatch
  }
}

/// Saved trust choices on this device (`UserDefaults`), one JSON array.
@MainActor
@Observable
public final class PullRequestRoutingStore {
  public private(set) var stored: [StoredPullRequestRoutingPermission]
  @ObservationIgnored private let defaults: UserDefaults?
  static let key = "ankiel.pullRequestRouting.v1"

  public init(defaults: UserDefaults?) {
    self.defaults = defaults
    stored = defaults?.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([StoredPullRequestRoutingPermission].self, from: $0) } ?? []
  }

  public func permission(_ record: EnvironmentRecord) -> PullRequestRoutingPermission {
    PullRequestRoutingRules.permission(record, in: stored)
  }

  /// False when the computer has no saved address to trust.
  @discardableResult
  public func set(_ permission: PullRequestRoutingPermission, for record: EnvironmentRecord) -> Bool {
    guard let next = PullRequestRoutingRules.setting(permission, for: record, in: stored) else { return false }
    stored = next
    defaults?.set(try? JSONEncoder().encode(next), forKey: Self.key)
    return true
  }
}

/// Runs one pull request call on the right computer.
@MainActor
public final class PullRequestRouter {
  let registry: EnvironmentRegistry
  let trust: PullRequestRoutingStore
  /// The identity each origin verified for a repository, so concurrent reads share one probe.
  private var identities: [String: Task<PullRequestRoutingResult?, Never>] = [:]

  public init(registry: EnvironmentRegistry, trust: PullRequestRoutingStore) {
    self.registry = registry
    self.trust = trust
  }

  /// A call on one computer's session, its errors kept typed.
  func direct<Result: Sendable>(
    _ environmentId: String, _ body: (any LiveSession) async throws -> Result
  ) async throws(PullRequestError) -> Result {
    guard let session = registry.environment(environmentId)?.session else { throw .notConnected }
    do {
      return try await body(session)
    } catch {
      throw PullRequestError(error)
    }
  }

  /// `body` gets the session and the ref to send (with the verified host and account when another
  /// computer answers).
  public func run<Result: Sendable>(
    _ ref: PullRequestRef, on origin: String, write: Bool,
    _ body: @escaping (any LiveSession, PullRequestRef) async throws -> Result
  ) async throws(PullRequestError) -> Result {
    guard let originModel = registry.environment(origin) else { throw .notConnected }
    let alternatives = registry.environments.filter { model in
      model.id != origin && model.session != nil
        && PullRequestRoutingRules.allowed(origin: originModel.record, destination: model.record, write: write, stored: trust.stored)
    }
    if alternatives.isEmpty { return try await direct(origin) { try await body($0, ref) } }
    guard let identity = await identity(ref, on: origin) else { return try await direct(origin) { try await body($0, ref) } }
    var routed = ref
    routed.host = identity.host
    routed.expectedAccountId = identity.accountId
    let order = PullRequestRoutingRules.candidates(
      origin: origin, originLocal: PullRequestRoutingRules.isLocal(originModel.record),
      alternatives: alternatives.map { ($0.id, PullRequestRoutingRules.isLocal($0.record)) }, write: write)
    var lastError: PullRequestError = .notConnected
    for (index, id) in order.enumerated() {
      let isLast = index == order.count - 1
      if id != origin {
        guard let model = registry.environment(id),
          PullRequestRoutingRules.allowed(origin: originModel.record, destination: model.record, write: write, stored: trust.stored)
        else { continue }
        // An older server would ignore expectedAccountId: verify it implements the guard first.
        let alternate = try? await direct(id) { try await PullRequestCalls.routingIdentity(host: identity.host, via: SessionCaller(session: $0)) }
        guard PullRequestRoutingRules.sameAccount(identity, alternate) else { continue }
      }
      do {
        return try await direct(id) { try await body($0, routed) }
      } catch {
        lastError = error
        guard !isLast, PullRequestRoutingRules.shouldTryNext(after: error, write: write) else { throw error }
      }
    }
    throw lastError
  }

  private func identity(_ ref: PullRequestRef, on origin: String) async -> PullRequestRoutingResult? {
    let key = "\(origin)|\(ref.projectId)|\(ref.host?.lowercased() ?? "")|\(ref.repository.lowercased())"
    if let pending = identities[key] { return await pending.value }
    let task = Task { [weak self] () -> PullRequestRoutingResult? in
      guard let self else { return nil }
      return try? await self.direct(origin) {
        try await PullRequestCalls.read(.routing, ref, as: PullRequestRoutingResult.self, via: SessionCaller(session: $0))
      }
    }
    identities[key] = task
    let result = await task.value
    if result == nil { identities[key] = nil }
    return result
  }
}

/// The live source and sink: every call through the router.
@MainActor
public final class LivePullRequestService: PullRequestSource, PullRequestSink {
  let router: PullRequestRouter

  public init(router: PullRequestRouter) { self.router = router }

  private func read<Response: Decodable & Sendable>(
    _ read: PullRequestRead, _ ref: PullRequestRef, in environmentId: String, as type: Response.Type
  ) async throws(PullRequestError) -> Response {
    try await router.run(ref, on: environmentId, write: false) { session, routed in
      try await PullRequestCalls.read(read, routed, as: type, via: SessionCaller(session: session))
    }
  }

  public func list(_ request: PullRequestListRequest, in environmentId: String) async throws(PullRequestError) -> PullRequestListResult {
    try await router.direct(environmentId) { try await PullRequestCalls.list(request, via: SessionCaller(session: $0)) }
  }

  public func stats(_ refs: [PullRequestRef], in environmentId: String) async throws(PullRequestError) -> [PullRequestDiffStat] {
    try await router.direct(environmentId) { try await PullRequestCalls.stats(refs, via: SessionCaller(session: $0)) }
  }

  public func detail(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestDetail {
    var detail = try await read(.detail, ref, in: environmentId, as: PullRequestDetail.self)
    detail.projectId = ref.projectId
    return detail
  }

  public func activity(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestActivity {
    try await read(.activity, ref, in: environmentId, as: PullRequestActivity.self)
  }

  public func checks(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestChecks {
    try await read(.checks, ref, in: environmentId, as: PullRequestChecks.self)
  }

  public func filesViewed(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestFilesViewedResult {
    try await read(.filesViewed, ref, in: environmentId, as: PullRequestFilesViewedResult.self)
  }

  public func linkedThreads(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestLinkedThreadsResult {
    // Linked threads live on the pull request's own computer, never a routed one.
    try await router.direct(environmentId) {
      try await PullRequestCalls.read(.linkedThreads, ref, as: PullRequestLinkedThreadsResult.self, via: SessionCaller(session: $0))
    }
  }

  public func reviewerCandidates(_ ref: PullRequestRef, query: String?, in environmentId: String) async throws(PullRequestError) -> PullRequestReviewerCandidateList {
    try await router.run(ref, on: environmentId, write: false) { session, routed in
      try await PullRequestCalls.reviewerCandidates(routed, query: query, via: SessionCaller(session: session))
    }
  }

  public func diff(_ request: PullRequestDiffRequest, in environmentId: String) async throws(PullRequestError) -> PullRequestDiffResult {
    try await router.direct(environmentId) { try await $0.postJSON(PullRequestDiffRequest.path, body: request, as: PullRequestDiffResult.self) }
  }

  public func invalidate(_ ref: PullRequestRef?, in environmentId: String) async {
    _ = try? await router.direct(environmentId) { try await PullRequestCalls.invalidate(ref, via: SessionCaller(session: $0)) }
  }

  public func send(_ write: PullRequestWrite, in environmentId: String) async throws(PullRequestError) -> PullRequestSummary? {
    let summary = try await router.run(write.ref, on: environmentId, write: true) { session, routed in
      try await PullRequestCalls.write(write.routed(to: routed), via: SessionCaller(session: session))
    }
    await invalidate(write.ref, in: environmentId)
    return summary
  }
}

extension PullRequestWrite {
  /// The same write for the routed ref (host and account filled in).
  func routed(to ref: PullRequestRef) -> PullRequestWrite {
    switch self {
    case .comment(_, let body): .comment(ref, body: body)
    case .reply(_, let threadId, let body): .reply(ref, threadId: threadId, body: body)
    case .react(_, let subjectId, let content, let reacted): .react(ref, subjectId: subjectId, content: content, reacted: reacted)
    case .review(_, let submission): .review(ref, submission)
    case .action(_, let action): .action(ref, action)
    case .requestReviewers(_, let reviewers, let requested): .requestReviewers(ref, reviewers: reviewers, requested: requested)
    case .update(_, let title, let body): .update(ref, title: title, body: body)
    case .resolveThread(_, let threadId, let resolved): .resolveThread(ref, threadId: threadId, resolved: resolved)
    case .setFilesViewed(_, let files): .setFilesViewed(ref, files: files)
    }
  }
}
