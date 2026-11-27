import Foundation

/// Someone on a tracker (`IssueActor`).
public struct IssueActor: Sendable, Hashable, Decodable {
  public var login: String
  public var name: String?
  public var avatarUrl: String?
  public var isBot: Bool?

  public init(login: String, name: String? = nil) {
    self.login = login
    self.name = name
  }

  public var displayName: String { name?.isEmpty == false ? name! : login }
}

public struct IssueLabel: Sendable, Hashable, Decodable {
  public var name: String
  /// Six hex digits without `#`, when the tracker colours labels.
  public var color: String?

  public init(name: String, color: String? = nil) {
    self.name = name
    self.color = color
  }
}

/// The tracker's own state name and the open/closed category filters key off (`IssueState`).
public struct IssueState: Sendable, Hashable, Decodable {
  public enum Category: String, Sendable, Hashable { case open, closed }
  public var category: WireEnum<Category>
  public var name: String
  public var closeReason: String?

  public init(category: Category, name: String, closeReason: String? = nil) {
    self.category = .known(category)
    self.name = name
    self.closeReason = closeReason
  }

  public var isOpen: Bool { category != .closed }
}

/// One row of a listing (`IssueListEntry`): the summary plus the project that reads it.
public struct IssueEntry: Sendable, Hashable, Decodable, Identifiable {
  public var tracker: String
  public var host: String
  public var scope: String
  public var key: String
  public var displayKey: String
  public var title: String
  public var url: String
  public var author: IssueActor?
  public var state: IssueState
  public var createdAt: String
  public var updatedAt: String
  public var assignees: [IssueActor]
  public var labels: [IssueLabel]
  public var commentCount: Int
  public var projectId: String
  public var projectTitle: String

  public var id: String { "\(tracker) \(host) \(scope) \(key)" }

  /// The address detail and comment reads take.
  public var ref: IssueRef {
    IssueRef(projectId: projectId, tracker: tracker, host: host, scope: scope, key: key)
  }

  enum CodingKeys: String, CodingKey {
    case tracker, host, scope, key, displayKey, title, url, author, state, createdAt, updatedAt
    case assignees, labels, commentCount, projectId, projectTitle
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    tracker = try c.decode(String.self, forKey: .tracker)
    host = try c.decode(String.self, forKey: .host)
    scope = try c.decode(String.self, forKey: .scope)
    key = try c.decode(String.self, forKey: .key)
    displayKey = (try? c.decode(String.self, forKey: .displayKey)) ?? key
    title = try c.decode(String.self, forKey: .title)
    url = (try? c.decode(String.self, forKey: .url)) ?? ""
    author = try? c.decodeIfPresent(IssueActor.self, forKey: .author)
    state = try c.decode(IssueState.self, forKey: .state)
    createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
    updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
    assignees = (try? c.decode(LossyArray<IssueActor>.self, forKey: .assignees).elements) ?? []
    labels = (try? c.decode(LossyArray<IssueLabel>.self, forKey: .labels).elements) ?? []
    commentCount = (try? c.decode(Int.self, forKey: .commentCount)) ?? 0
    projectId = try c.decode(String.self, forKey: .projectId)
    projectTitle = (try? c.decode(String.self, forKey: .projectTitle)) ?? ""
  }

  public init(
    tracker: String = "github", host: String = "github.com", scope: String, key: String, title: String,
    state: IssueState, projectId: String, projectTitle: String, updatedAt: String = "", labels: [IssueLabel] = [],
    author: IssueActor? = nil, commentCount: Int = 0
  ) {
    self.tracker = tracker
    self.host = host
    self.scope = scope
    self.key = key
    displayKey = "#\(key)"
    self.title = title
    url = "https://\(host)/\(scope)/issues/\(key)"
    self.author = author
    self.state = state
    createdAt = updatedAt
    self.updatedAt = updatedAt
    assignees = []
    self.labels = labels
    self.commentCount = commentCount
    self.projectId = projectId
    self.projectTitle = projectTitle
  }
}

/// Addresses one issue (`IssueRef`); `projectId` names whose credentials serve the read.
public struct IssueRef: Sendable, Hashable, Codable {
  public var projectId: String
  public var tracker: String
  public var host: String?
  public var scope: String
  public var key: String

  public init(projectId: String, tracker: String, host: String?, scope: String, key: String) {
    self.projectId = projectId
    self.tracker = tracker
    self.host = host
    self.scope = scope
    self.key = key
  }
}

public struct IssueComment: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var author: IssueActor?
  public var body: String
  public var createdAt: String
  public var url: String?

  public init(id: String, author: IssueActor?, body: String, createdAt: String) {
    self.id = id
    self.author = author
    self.body = body
    self.createdAt = createdAt
  }
}

/// `issues.detail`: the issue, its body and the newest comments.
public struct IssueDetail: Sendable, Hashable, Decodable {
  public var entry: IssueEntry
  public var body: String
  public var comments: [IssueComment]
  /// Where older comments carry on; nil once the conversation is whole.
  public var commentsCursor: String?
  public var canComment: Bool

  enum CodingKeys: String, CodingKey { case body, comments, commentsCursor, capabilities }
  enum CapabilityKeys: String, CodingKey { case comment }

  public init(from decoder: any Decoder) throws {
    entry = try IssueEntry(from: decoder)
    let c = try decoder.container(keyedBy: CodingKeys.self)
    body = (try? c.decode(String.self, forKey: .body)) ?? ""
    comments = (try? c.decode(LossyArray<IssueComment>.self, forKey: .comments).elements) ?? []
    commentsCursor = try? c.decodeIfPresent(String.self, forKey: .commentsCursor)
    canComment =
      (try? c.nestedContainer(keyedBy: CapabilityKeys.self, forKey: .capabilities).decode(Bool.self, forKey: .comment))
      ?? false
  }

  public init(entry: IssueEntry, body: String, comments: [IssueComment], commentsCursor: String? = nil) {
    self.entry = entry
    self.body = body
    self.comments = comments
    self.commentsCursor = commentsCursor
    canComment = false
  }
}

/// One tracker account and whether it can be read (`IssueTrackerSummary`).
public struct IssueTracker: Sendable, Hashable, Decodable {
  public var tracker: String
  public var host: String
  public var configured: Bool
  public var detail: String?
}

/// A project whose issues could not be read (`IssueListProjectError`).
public struct IssueListError: Sendable, Hashable, Decodable {
  public var projectId: String
  public var projectTitle: String
  public var message: String
}

/// `issues.list`: rows newest first across every scope, and where each scope carries on.
public struct IssueListResult: Sendable, Hashable, Decodable {
  public var trackers: [IssueTracker]
  public var entries: [IssueEntry]
  public var errors: [IssueListError]
  public var nextCursors: [String: String]

  enum CodingKeys: String, CodingKey { case trackers, entries, errors, nextCursors }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    trackers = (try? c.decode(LossyArray<IssueTracker>.self, forKey: .trackers).elements) ?? []
    entries = try c.decode(LossyArray<IssueEntry>.self, forKey: .entries).elements
    errors = (try? c.decode(LossyArray<IssueListError>.self, forKey: .errors).elements) ?? []
    nextCursors = (try? c.decode([String: String].self, forKey: .nextCursors)) ?? [:]
  }

  public init(entries: [IssueEntry], trackers: [IssueTracker] = [], errors: [IssueListError] = [], nextCursors: [String: String] = [:]) {
    self.entries = entries
    self.trackers = trackers
    self.errors = errors
    self.nextCursors = nextCursors
  }
}

/// Which issues a list asks for (`IssueListState`).
public enum IssueStateFilter: String, Sendable, Hashable, CaseIterable, Encodable {
  case open, closed, all
}

/// `issues.list`; `query` is matched by the trackers themselves.
public struct IssueListRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "issues.list"
  public var state: IssueStateFilter
  public var projectId: String?
  public var limit: Int?
  public var cursors: [String: String]?
  public var refresh: Bool?
  public var query: String?

  public init(
    state: IssueStateFilter, projectId: String? = nil, limit: Int? = 50, cursors: [String: String]? = nil,
    refresh: Bool? = nil, query: String? = nil
  ) {
    self.state = state
    self.projectId = projectId
    self.limit = limit
    self.cursors = cursors
    self.refresh = refresh
    let trimmed = query?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.query = trimmed?.isEmpty == false ? String(trimmed!.prefix(200)) : nil
  }
}

/// `issues.detail` takes the ref itself.
enum IssueDetailRequest {
  static let rpcTag = "issues.detail"
}

/// `issues.comments`: older comments past a cursor.
struct IssueCommentsRequest: Encodable, Sendable {
  static let rpcTag = "issues.comments"
  var projectId: String
  var tracker: String
  var host: String?
  var scope: String
  var key: String
  var cursor: String

  init(_ ref: IssueRef, cursor: String) {
    projectId = ref.projectId
    tracker = ref.tracker
    host = ref.host
    scope = ref.scope
    key = ref.key
    self.cursor = cursor
  }
}

public struct IssueCommentsPage: Sendable, Hashable, Decodable {
  public var comments: [IssueComment]
  public var nextCursor: String?

  enum CodingKeys: String, CodingKey { case comments, nextCursor }

  public init(comments: [IssueComment], nextCursor: String?) {
    self.comments = comments
    self.nextCursor = nextCursor
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    comments = (try? c.decode(LossyArray<IssueComment>.self, forKey: .comments).elements) ?? []
    nextCursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
  }
}

/// Reads through any caller; writes are not built (the tracker is real and shared).
public enum IssueCalls {
  public static func list(_ request: IssueListRequest, via caller: some UnaryCaller) async throws -> IssueListResult {
    try await caller.call(IssueListRequest.rpcTag, payload: request, as: IssueListResult.self)
  }

  public static func detail(_ ref: IssueRef, via caller: some UnaryCaller) async throws -> IssueDetail {
    try await caller.call(IssueDetailRequest.rpcTag, payload: ref, as: IssueDetail.self)
  }

  public static func olderComments(_ ref: IssueRef, cursor: String, via caller: some UnaryCaller) async throws -> IssueCommentsPage {
    try await caller.call(IssueCommentsRequest.rpcTag, payload: IssueCommentsRequest(ref, cursor: cursor), as: IssueCommentsPage.self)
  }

  /// RN's starting draft for a thread about an issue: its link and title.
  public static func threadPrompt(_ entry: IssueEntry) -> String {
    "\(entry.title)\n\n\(entry.url)"
  }
}

extension EnvironmentRegistry {
  public func issues(_ request: IssueListRequest, in environmentId: String) async throws(EnvironmentRequestError) -> IssueListResult {
    try await self.request(environmentId) { try await IssueCalls.list(request, via: SessionCaller(session: $0)) }
  }

  public func issueDetail(_ ref: IssueRef, in environmentId: String) async throws(EnvironmentRequestError) -> IssueDetail {
    try await request(environmentId) { try await IssueCalls.detail(ref, via: SessionCaller(session: $0)) }
  }

  public func olderIssueComments(_ ref: IssueRef, cursor: String, in environmentId: String) async throws(EnvironmentRequestError) -> IssueCommentsPage {
    try await request(environmentId) { try await IssueCalls.olderComments(ref, cursor: cursor, via: SessionCaller(session: $0)) }
  }
}
