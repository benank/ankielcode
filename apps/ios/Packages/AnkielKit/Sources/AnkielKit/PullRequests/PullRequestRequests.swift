import Foundation

// Requests the pull request feature sends. The server decodes them strictly (unknown keys fail),
// so `Fixtures/commands/pull-requests/*.json` hold one encoding of each and `check-schemas.mjs`
// decodes them with the contracts' own schemas.

/// Which pull request: a project on the answering computer, the repository and the number.
public struct PullRequestRef: Sendable, Hashable, Codable {
  public var projectId: String
  public var host: String?
  /// Set by routing: the account the answering computer must read with.
  public var expectedAccountId: String?
  public var allowStale: Bool?
  public var repository: String
  public var number: Int

  public init(projectId: String, host: String? = nil, repository: String, number: Int) {
    self.projectId = projectId
    self.host = host
    self.repository = repository
    self.number = number
  }

  /// Host, repository and number, case-folded (`pullRequestListKey`).
  public var key: String { "\(host?.lowercased() ?? ""):\(repository.lowercased()):\(number)" }
}

/// A request whose fields are a `PullRequestRef`'s plus its own, in one object.
public struct PullRequestRefPayload<Extra: Encodable & Sendable & Hashable>: Encodable, Sendable, Hashable {
  public var ref: PullRequestRef
  public var extra: Extra

  public init(_ ref: PullRequestRef, _ extra: Extra) {
    self.ref = ref
    self.extra = extra
  }

  public func encode(to encoder: any Encoder) throws {
    try ref.encode(to: encoder)
    try extra.encode(to: encoder)
  }
}

public struct PullRequestListFilters: Sendable, Hashable, Codable {
  public enum Draft: String, Sendable, Codable, CaseIterable { case only, hide }
  public enum Review: String, Sendable, Codable, CaseIterable {
    case approved
    case changesRequested = "changes-requested"
    case reviewRequired = "review-required"
    case none
  }
  public enum Checks: String, Sendable, Codable, CaseIterable { case passing, failing }

  public var draft: Draft?
  public var review: Review?
  public var checks: Checks?
  /// Every group must match; any name within a group suffices.
  public var labels: [[String]]?
  public var excludedLabels: [String]?
  public var author: String?

  public init(
    draft: Draft? = nil, review: Review? = nil, checks: Checks? = nil, labels: [[String]]? = nil,
    excludedLabels: [String]? = nil, author: String? = nil
  ) {
    self.draft = draft
    self.review = review
    self.checks = checks
    self.labels = labels
    self.excludedLabels = excludedLabels
    self.author = author
  }

  /// The menu's values under the typed query's (`{ ...controls.filters, ...parsed.filters }`).
  public func overlaid(by typed: Self) -> Self {
    Self(
      draft: typed.draft ?? draft, review: typed.review ?? review, checks: typed.checks ?? checks,
      labels: typed.labels ?? labels, excludedLabels: typed.excludedLabels ?? excludedLabels,
      author: typed.author ?? author)
  }

  public var isEmpty: Bool { self == Self() }
}

/// `pullRequests.list`.
public struct PullRequestListRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "pullRequests.list"
  public var state: PullRequestListState
  public var involvement: PullRequestInvolvement?
  public var filters: PullRequestListFilters?
  public var projectId: String?
  public var host: String?
  public var limit: Int?
  public var cursors: [String: String]?
  public var query: String?

  public init(
    state: PullRequestListState, involvement: PullRequestInvolvement? = nil, filters: PullRequestListFilters? = nil,
    projectId: String? = nil, limit: Int? = nil, cursors: [String: String]? = nil, query: String? = nil
  ) {
    self.state = state
    self.involvement = involvement
    self.filters = filters
    self.projectId = projectId
    self.limit = limit
    self.cursors = cursors
    self.query = query
  }
}

/// `pullRequests.listStats`.
public struct PullRequestListStatsRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "pullRequests.listStats"
  public var refs: [PullRequestRef]
  public init(refs: [PullRequestRef]) { self.refs = refs }
}

/// `pullRequests.invalidate`: the explicit refresh a person asks for; ordinary reads share a cache.
public struct PullRequestInvalidateRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "pullRequests.invalidate"
  public var reference: PullRequestRef?
  public var filesViewedOnly: Bool?
  public init(reference: PullRequestRef? = nil, filesViewedOnly: Bool? = nil) {
    self.reference = reference
    self.filesViewedOnly = filesViewedOnly
  }
}

/// `POST /api/pull-requests/diff`: one slice of the patch.
public struct PullRequestDiffRequest: Encodable, Sendable, Hashable {
  public static let path = "/api/pull-requests/diff"
  public var ref: PullRequestRef
  public var cursor: String?
  public var path: String?

  public init(ref: PullRequestRef, cursor: String? = nil, path: String? = nil) {
    self.ref = ref
    self.cursor = cursor
    self.path = path
  }

  enum CodingKeys: String, CodingKey { case cursor, path }

  public func encode(to encoder: any Encoder) throws {
    try ref.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(cursor, forKey: .cursor)
    try container.encodeIfPresent(path, forKey: .path)
  }
}

public struct PullRequestRoutingIdentityRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "pullRequests.routingIdentity"
  public var host: String
}

/// The unary pull request reads keyed by a `PullRequestRef`.
public enum PullRequestRead: String, Sendable {
  case detail = "pullRequests.detail"
  case activity = "pullRequests.activity"
  case checks = "pullRequests.checks"
  case filesViewed = "pullRequests.filesViewed"
  case linkedThreads = "pullRequests.linkedThreads"
  case routing = "pullRequests.routing"
  case summary = "pullRequests.summary"
}

// MARK: Writes

/// Every write the feature can send to the host, as one typed value (the fake sink records these).
public enum PullRequestWrite: Sendable, Hashable {
  case comment(PullRequestRef, body: String)
  case reply(PullRequestRef, threadId: String, body: String)
  case react(PullRequestRef, subjectId: String?, content: PullRequestReactionContent, reacted: Bool)
  case review(PullRequestRef, PullRequestReviewSubmission)
  case action(PullRequestRef, PullRequestActionRequest)
  case requestReviewers(PullRequestRef, reviewers: [PullRequestReviewerChoice], requested: Bool)
  case update(PullRequestRef, title: String?, body: String?)
  case resolveThread(PullRequestRef, threadId: String, resolved: Bool)
  case setFilesViewed(PullRequestRef, files: [PullRequestViewedMark])

  public var ref: PullRequestRef {
    switch self {
    case .comment(let ref, _), .reply(let ref, _, _), .react(let ref, _, _, _), .review(let ref, _), .action(let ref, _),
      .requestReviewers(let ref, _, _), .update(let ref, _, _), .resolveThread(let ref, _, _), .setFilesViewed(let ref, _):
      ref
    }
  }

  public var rpcTag: String {
    switch self {
    case .comment: "pullRequests.comment"
    case .reply: "pullRequests.replyToThread"
    case .react: "pullRequests.setReaction"
    case .review: "pullRequests.submitReview"
    case .action: "pullRequests.runAction"
    case .requestReviewers: "pullRequests.requestReviewers"
    case .update: "pullRequests.update"
    case .resolveThread: "pullRequests.setThreadResolution"
    case .setFilesViewed: "pullRequests.setFilesViewed"
    }
  }

  /// The JSON payload, exactly as sent.
  public func payload() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(Payload(write: self))
  }

  struct Payload: Encodable {
    let write: PullRequestWrite

    enum Keys: String, CodingKey {
      case body, threadId, subjectId, content, reacted, reviewers, requested, title, resolved, files
    }

    func encode(to encoder: any Encoder) throws {
      try write.ref.encode(to: encoder)
      var c = encoder.container(keyedBy: Keys.self)
      switch write {
      case .comment(_, let body):
        try c.encode(body, forKey: .body)
      case .reply(_, let threadId, let body):
        try c.encode(threadId, forKey: .threadId)
        try c.encode(body, forKey: .body)
      case .react(_, let subjectId, let content, let reacted):
        try c.encodeIfPresent(subjectId, forKey: .subjectId)
        try c.encode(content, forKey: .content)
        try c.encode(reacted, forKey: .reacted)
      case .review(_, let submission):
        try submission.encode(to: encoder)
      case .action(_, let action):
        try action.encode(to: encoder)
      case .requestReviewers(_, let reviewers, let requested):
        try c.encode(reviewers, forKey: .reviewers)
        try c.encode(requested, forKey: .requested)
      case .update(_, let title, let body):
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(body, forKey: .body)
      case .resolveThread(_, let threadId, let resolved):
        try c.encode(threadId, forKey: .threadId)
        try c.encode(resolved, forKey: .resolved)
      case .setFilesViewed(_, let files):
        try c.encode(files, forKey: .files)
      }
    }
  }
}

public struct PullRequestReviewerChoice: Sendable, Hashable, Codable {
  public var id: String
  public var kind: PullRequestReviewerKind
  public init(id: String, kind: PullRequestReviewerKind) {
    self.id = id
    self.kind = kind
  }
}

public struct PullRequestViewedMark: Sendable, Hashable, Codable {
  public var path: String
  public var viewed: Bool
  public var revision: String?
  public init(path: String, viewed: Bool, revision: String? = nil) {
    self.path = path
    self.viewed = viewed
    self.revision = revision
  }
}

/// Where an inline review comment sits (`PullRequestReviewPosition`).
public enum PullRequestReviewPosition: Sendable, Hashable, Codable {
  case added(newLine: Int)
  case deleted(oldLine: Int)
  case context(oldLine: Int, newLine: Int, side: PullRequestDiffSide)

  enum Keys: String, CodingKey { case kind, newLine, oldLine, side }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .kind) {
    case "added": self = .added(newLine: try c.decode(Int.self, forKey: .newLine))
    case "deleted": self = .deleted(oldLine: try c.decode(Int.self, forKey: .oldLine))
    default:
      self = .context(
        oldLine: try c.decode(Int.self, forKey: .oldLine), newLine: try c.decode(Int.self, forKey: .newLine),
        side: try c.decode(PullRequestDiffSide.self, forKey: .side))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .added(let newLine):
      try c.encode("added", forKey: .kind)
      try c.encode(newLine, forKey: .newLine)
    case .deleted(let oldLine):
      try c.encode("deleted", forKey: .kind)
      try c.encode(oldLine, forKey: .oldLine)
    case .context(let oldLine, let newLine, let side):
      try c.encode("context", forKey: .kind)
      try c.encode(oldLine, forKey: .oldLine)
      try c.encode(newLine, forKey: .newLine)
      try c.encode(side, forKey: .side)
    }
  }

  /// The position of a diff line, or nil for a line the host cannot place a comment on.
  public init?(_ line: DiffLine) {
    switch line.kind {
    case .added:
      guard let new = line.newNumber else { return nil }
      self = .added(newLine: new)
    case .removed:
      guard let old = line.oldNumber else { return nil }
      self = .deleted(oldLine: old)
    case .context:
      guard let old = line.oldNumber, let new = line.newNumber else { return nil }
      self = .context(oldLine: old, newLine: new, side: .right)
    }
  }

  /// The side and line number a review thread on this position reports.
  public var anchor: (side: PullRequestDiffSide, line: Int) {
    switch self {
    case .added(let newLine): (.right, newLine)
    case .deleted(let oldLine): (.left, oldLine)
    case .context(let oldLine, let newLine, let side): side == .left ? (.left, oldLine) : (.right, newLine)
    }
  }
}

/// A pending inline comment of a review (`PullRequestReviewCommentDraft`).
public struct PullRequestReviewCommentDraft: Sendable, Hashable, Codable, Identifiable {
  public var id: String { "\(path)|\(position)|\(startPosition.map { "\($0)" } ?? "")" }
  public var path: String
  public var oldPath: String?
  public var position: PullRequestReviewPosition
  /// The first line of a range; sent only to hosts with `review.rangeComment`.
  public var startPosition: PullRequestReviewPosition?
  public var body: String

  public init(path: String, oldPath: String? = nil, position: PullRequestReviewPosition, startPosition: PullRequestReviewPosition? = nil, body: String) {
    self.path = path
    self.oldPath = oldPath
    self.position = position
    self.startPosition = startPosition
    self.body = body
  }
}

public struct PullRequestReviewSubmission: Sendable, Hashable, Encodable {
  public var expectedHeadSha: String?
  public var verdict: PullRequestReviewVerdict
  public var body: String
  public var comments: [PullRequestReviewCommentDraft]

  public init(expectedHeadSha: String?, verdict: PullRequestReviewVerdict, body: String, comments: [PullRequestReviewCommentDraft]) {
    self.expectedHeadSha = expectedHeadSha
    self.verdict = verdict
    self.body = body
    self.comments = comments
  }
}

public struct PullRequestActionRequest: Sendable, Hashable, Encodable {
  public var expectedHeadSha: String?
  public var action: PullRequestAction
  public var mergeMethod: PullRequestMergeMethod?
  public var updateMethod: PullRequestUpdateMethod?
  /// Opt-in: older clients decode the action's success as void.
  public var replyWithSummary: Bool?

  public init(
    action: PullRequestAction, mergeMethod: PullRequestMergeMethod? = nil, expectedHeadSha: String? = nil,
    updateMethod: PullRequestUpdateMethod? = nil
  ) {
    self.action = action
    self.mergeMethod = mergeMethod
    self.expectedHeadSha = expectedHeadSha
    self.updateMethod = updateMethod
    replyWithSummary = true
  }
}
