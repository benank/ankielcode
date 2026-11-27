import Foundation

/// Why a pull request read or write did not answer, with the server's typed reasons kept.
public enum PullRequestError: Error, Sendable, Hashable {
  case notConnected
  /// `PullRequestUnavailableError`: no tool or credential, an unsupported host, or a repository
  /// no project has. The list's partial answer rides along when the server sent one.
  case unavailable(Unavailable)
  /// `PullRequestOperationError`: the host refused or failed (`notFound` for a missing PR).
  case operation(detail: String, notFound: Bool)
  /// Another typed refusal (scopes, a schema rejection).
  case rejected(message: String?, tag: String?)
  case failed(String)

  public struct Unavailable: Sendable, Hashable {
    public enum Reason: String, Sendable {
      case cliMissing = "cli-missing"
      case cliUnauthenticated = "cli-unauthenticated"
      case providerUnsupported = "provider-unsupported"
      case repositoryWithoutProject = "repository-without-project"
    }
    public var reason: WireEnum<Reason>
    public var requirement: String?
    public var repository: String?
    public var host: String?
  }

  public init(_ error: any Error) {
    switch error {
    case let error as PullRequestError: self = error
    case RpcError.failed(let failure): self = Self(failure: failure.error)
    case RpcError.connectionClosed: self = .notConnected
    case EnvironmentRequestError.notConnected: self = .notConnected
    case EnvironmentRequestError.rejected(let message, let tag): self = .rejected(message: message, tag: tag)
    case EnvironmentRequestError.failed(let message): self = .failed(message)
    default: self = .failed(String(describing: error))
    }
  }

  init(failure: JSONValue) {
    switch failure["_tag"]?.stringValue {
    case "PullRequestUnavailableError":
      self = .unavailable(
        Unavailable(
          reason: WireEnum(rawValue: failure["reason"]?.stringValue ?? ""),
          requirement: failure["requirement"]?.stringValue, repository: failure["repository"]?.stringValue,
          host: failure["host"]?.stringValue))
    case "PullRequestOperationError":
      self = .operation(
        detail: failure["detail"]?.stringValue ?? failure["operation"]?.stringValue ?? "",
        notFound: failure["reason"]?.stringValue == "not-found")
    case let tag:
      self = .rejected(message: failure["message"]?.stringValue ?? failure["detail"]?.stringValue, tag: tag)
    }
  }

  /// Refused before the server ran it, so trying another computer cannot double a write.
  public var rejectedBeforeDispatch: Bool {
    switch self {
    case .notConnected: true
    case .rejected(_, let tag): tag == "EnvironmentRpcUnavailableError"
    default: false
    }
  }
}

/// The pull request RPCs over any caller (a live session or the probe's client).
public enum PullRequestCalls {
  public static func list(_ request: PullRequestListRequest, via caller: some UnaryCaller) async throws -> PullRequestListResult {
    try await caller.call(PullRequestListRequest.rpcTag, payload: request, as: PullRequestListResult.self)
  }

  public static func stats(_ refs: [PullRequestRef], via caller: some UnaryCaller) async throws -> [PullRequestDiffStat] {
    try await caller.call(PullRequestListStatsRequest.rpcTag, payload: PullRequestListStatsRequest(refs: refs), as: PullRequestListStatsResult.self).stats
  }

  public static func read<Response: Decodable & Sendable>(
    _ read: PullRequestRead, _ ref: PullRequestRef, as type: Response.Type, via caller: some UnaryCaller
  ) async throws -> Response {
    try await caller.call(read.rawValue, payload: ref, as: type)
  }

  public static func invalidate(_ ref: PullRequestRef?, via caller: some UnaryCaller) async throws {
    _ = try await caller.call(PullRequestInvalidateRequest.rpcTag, payload: PullRequestInvalidateRequest(reference: ref), as: RpcVoid.self)
  }

  public static func routingIdentity(host: String, via caller: some UnaryCaller) async throws -> PullRequestRoutingIdentityResult {
    try await caller.call(PullRequestRoutingIdentityRequest.rpcTag, payload: PullRequestRoutingIdentityRequest(host: host), as: PullRequestRoutingIdentityResult.self)
  }

  public static func reviewerCandidates(
    _ ref: PullRequestRef, query: String?, via caller: some UnaryCaller
  ) async throws -> PullRequestReviewerCandidateList {
    try await caller.call(
      "pullRequests.reviewerCandidates", payload: PullRequestRefPayload(ref, ReviewerQuery(query: query)),
      as: PullRequestReviewerCandidateList.self)
  }

  /// Sends one write. Actions answer the pull request's summary (`replyWithSummary`); the others
  /// answer nothing.
  public static func write(_ write: PullRequestWrite, via caller: some UnaryCaller) async throws -> PullRequestSummary? {
    let payload = RawJSONPayload(data: try write.payload())
    if case .action = write {
      return try await caller.call(write.rpcTag, payload: payload, as: OptionalSummary.self).summary
    }
    _ = try await caller.call(write.rpcTag, payload: payload, as: RpcVoid.self)
    return nil
  }

  /// A void answer, or a summary from servers that reply with one.
  struct OptionalSummary: Decodable, Sendable {
    var summary: PullRequestSummary?
    init(from decoder: any Decoder) throws {
      summary = try? PullRequestSummary(from: decoder)
    }
  }
}

struct ReviewerQuery: Encodable, Sendable, Hashable { var query: String? }

/// Bytes already encoded, sent as they are.
struct RawJSONPayload: Encodable, Sendable {
  let data: Data
  func encode(to encoder: any Encoder) throws {
    try JSONValue(data: data).encode(to: encoder)
  }
}

extension JSONValue {
  init(data: Data) throws {
    self = try JSONDecoder().decode(JSONValue.self, from: data)
  }
}

// MARK: The seam the screens use

/// Every pull request read one computer can answer. Live calls go through routing; fixtures
/// answer from memory.
@MainActor
public protocol PullRequestSource: AnyObject {
  func list(_ request: PullRequestListRequest, in environmentId: String) async throws(PullRequestError) -> PullRequestListResult
  func stats(_ refs: [PullRequestRef], in environmentId: String) async throws(PullRequestError) -> [PullRequestDiffStat]
  func detail(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestDetail
  func activity(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestActivity
  func checks(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestChecks
  func diff(_ request: PullRequestDiffRequest, in environmentId: String) async throws(PullRequestError) -> PullRequestDiffResult
  func filesViewed(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestFilesViewedResult
  func linkedThreads(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestLinkedThreadsResult
  func reviewerCandidates(_ ref: PullRequestRef, query: String?, in environmentId: String) async throws(PullRequestError) -> PullRequestReviewerCandidateList
  /// The explicit refresh (pull to refresh): drops the server's shared cache for `ref` (or all).
  func invalidate(_ ref: PullRequestRef?, in environmentId: String) async
}

/// Where writes go. The live sink sends them to the host through the computer; the debug sink
/// records them (and the read-only sink refuses them).
@MainActor
public protocol PullRequestSink: AnyObject {
  func send(_ write: PullRequestWrite, in environmentId: String) async throws(PullRequestError) -> PullRequestSummary?
}

/// Records every write it is handed and answers as the host would, without sending anything.
@MainActor
public final class RecordingPullRequestSink: PullRequestSink {
  public enum Mode: Sendable { case accept, refuse, hang }
  public private(set) var sent: [(environmentId: String, write: PullRequestWrite)] = []
  public var mode: Mode
  public var delay: Duration

  public init(mode: Mode = .accept, delay: Duration = .milliseconds(350)) {
    self.mode = mode
    self.delay = delay
  }

  public func send(_ write: PullRequestWrite, in environmentId: String) async throws(PullRequestError) -> PullRequestSummary? {
    sent.append((environmentId, write))
    switch mode {
    case .accept:
      try? await Task.sleep(for: delay)
      return nil
    case .refuse:
      try? await Task.sleep(for: delay)
      throw .operation(detail: "The fixture host refused this write.", notFound: false)
    case .hang:
      try? await Task.sleep(for: .seconds(3600))
      throw .failed("Timed out.")
    }
  }
}

extension ServerSettingsPatch {
  /// `githubIntegrationEnabled`: whether the computer reads GitHub at all.
  public static func githubIntegration(_ on: Bool) -> Self { Self(["githubIntegrationEnabled": .bool(on)]) }
}
