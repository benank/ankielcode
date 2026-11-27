import Foundation

// Pull request wire types (`packages/contracts/src/pullRequest.ts`). Hand-written like the rest
// of the wire layer: arrays skip unreadable elements, enums keep unknown values, and optional
// fields read absent, null and unreadable alike as nil, so a newer server never blanks a screen.

/// An array field that skips elements it cannot read and reads absent or null as empty.
@propertyWrapper
public struct WireList<Element: Codable & Sendable & Hashable>: Codable, Sendable, Hashable {
  public var wrappedValue: [Element]

  public init(wrappedValue: [Element]) { self.wrappedValue = wrappedValue }

  public init(from decoder: any Decoder) throws {
    wrappedValue = (try? LossyArray<Element>(from: decoder).elements) ?? []
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(wrappedValue)
  }
}

extension KeyedDecodingContainer {
  public func decode<Element>(_ type: WireList<Element>.Type, forKey key: Key) throws -> WireList<Element> {
    ((try? decodeIfPresent(type, forKey: key)) ?? nil) ?? WireList(wrappedValue: [])
  }
}

public enum PullRequestState: String, Sendable, Codable { case open, closed, merged }
public enum PullRequestListState: String, Sendable, Codable, CaseIterable { case open, closed, merged, all }
public enum PullRequestInvolvement: String, Sendable, Codable, CaseIterable { case all, reviewing, authored }
public enum PullRequestReviewDecision: String, Sendable, Codable {
  case approved
  case changesRequested = "changes-requested"
  case reviewRequired = "review-required"
}
public enum PullRequestChecksState: String, Sendable, Codable { case passing, failing, pending }
public enum PullRequestMergeability: String, Sendable, Codable { case mergeable, conflicting, unknown }
public enum PullRequestMergeMethod: String, Sendable, Codable, CaseIterable {
  case merge, squash, rebase
  case fastForward = "fast-forward"
}
public enum PullRequestAction: String, Sendable, Codable, CaseIterable {
  case merge, ready, draft, close, reopen
  case deleteBranch = "delete-branch"
  case updateBranch = "update-branch"
  case enableAutoMerge = "enable-auto-merge"
  case disableAutoMerge = "disable-auto-merge"
  case revert
  case approveWorkflows = "approve-workflows"
}
public enum PullRequestUpdateMethod: String, Sendable, Codable { case merge, rebase }
public enum PullRequestCheckStatus: String, Sendable, Codable {
  case pending
  case actionRequired = "action-required"
  case success, failure, skipped, neutral, cancelled
}
public enum PullRequestReactionContent: String, Sendable, Codable, CaseIterable {
  case thumbsUp = "thumbs-up"
  case thumbsDown = "thumbs-down"
  case laugh, hooray, confused, heart, rocket, eyes
}
public enum PullRequestCommentKind: String, Sendable, Codable {
  case issueComment = "issue-comment"
  case reviewComment = "review-comment"
  case review
}
public enum PullRequestDiffSide: String, Sendable, Codable { case left, right }
public enum PullRequestReviewVerdict: String, Sendable, Codable, CaseIterable {
  case comment, approve
  case requestChanges = "request-changes"
}
public enum PullRequestReviewerKind: String, Sendable, Codable { case user, team }
public enum PullRequestFileViewedState: String, Sendable, Codable { case unviewed, viewed, dismissed }

public struct PullRequestActor: Sendable, Hashable, Codable {
  public var isBot: Bool?
  public var login: String
  public var name: String?
  public var avatarUrl: String?

  public init(login: String, name: String? = nil, avatarUrl: String? = nil, isBot: Bool? = nil) {
    self.login = login
    self.name = name
    self.avatarUrl = avatarUrl
    self.isBot = isBot
  }
}

public struct PullRequestLabel: Sendable, Hashable, Codable {
  public var name: String
  public var color: String?
  public var description: String?

  public init(name: String, color: String? = nil, description: String? = nil) {
    self.name = name
    self.color = color
    self.description = description
  }
}

public struct PullRequestCheck: Sendable, Hashable, Codable {
  public var name: String
  public var status: WireEnum<PullRequestCheckStatus>
  public var description: String?
  public var url: String?
  public var required: Bool?
  /// Stands for checks the host could not list; nothing waits on it or counts it as passing.
  public var placeholder: Bool?

  public init(
    name: String, status: PullRequestCheckStatus, description: String? = nil, url: String? = nil, required: Bool? = nil
  ) {
    self.name = name
    self.status = .known(status)
    self.description = description
    self.url = url
    self.required = required
  }
}

public struct PullRequestReaction: Sendable, Hashable, Codable {
  public var content: WireEnum<PullRequestReactionContent>
  public var count: Int
  /// Leaves out the viewer when `viewerHasReacted`; `count` still includes them.
  @WireList public var actors: [String] = []
  public var viewerHasReacted: Bool

  public init(content: PullRequestReactionContent, count: Int, actors: [String] = [], viewerHasReacted: Bool = false) {
    self.content = .known(content)
    self.count = count
    self.actors = actors
    self.viewerHasReacted = viewerHasReacted
  }
}

public struct PullRequestComment: Sendable, Hashable, Codable, Identifiable {
  public var id: String
  public var kind: WireEnum<PullRequestCommentKind>
  @Tolerant public var author: PullRequestActor? = nil
  public var body: String
  public var createdAt: WireTimestamp
  public var editedAt: WireTimestamp?
  public var url: String?
  public var path: String?
  public var reviewState: String?
  @WireList public var reactions: [PullRequestReaction] = []
  public var canEdit: Bool?

  public init(
    id: String, kind: PullRequestCommentKind, author: PullRequestActor?, body: String, createdAt: WireTimestamp,
    reviewState: String? = nil, reactions: [PullRequestReaction] = [], path: String? = nil
  ) {
    self.id = id
    self.kind = .known(kind)
    self.author = author
    self.body = body
    self.createdAt = createdAt
    self.reviewState = reviewState
    self.reactions = reactions
    self.path = path
  }
}

public struct PullRequestThreadComment: Sendable, Hashable, Codable, Identifiable {
  public var id: String
  @Tolerant public var author: PullRequestActor? = nil
  public var body: String
  public var createdAt: WireTimestamp
  public var editedAt: WireTimestamp?
  public var url: String?
  public var reviewUrl: String?
  @WireList public var reactions: [PullRequestReaction] = []
  public var canEdit: Bool?

  public init(id: String, author: PullRequestActor?, body: String, createdAt: WireTimestamp) {
    self.id = id
    self.author = author
    self.body = body
    self.createdAt = createdAt
  }
}

/// A review thread on a line, or (`path` and `line` nil) an overview thread on the whole change.
public struct PullRequestReviewThread: Sendable, Hashable, Codable, Identifiable {
  public var id: String
  public var path: String?
  public var line: Int?
  public var side: WireEnum<PullRequestDiffSide>
  public var isResolved: Bool
  public var isOutdated: Bool
  @WireList public var comments: [PullRequestThreadComment] = []
  public var commentCount: Int?
  public var nextCommentsCursor: String?
  public var canResolve: Bool?

  public init(
    id: String, path: String?, line: Int?, side: PullRequestDiffSide = .right, isResolved: Bool = false,
    isOutdated: Bool = false, comments: [PullRequestThreadComment]
  ) {
    self.id = id
    self.path = path
    self.line = line
    self.side = .known(side)
    self.isResolved = isResolved
    self.isOutdated = isOutdated
    self.comments = comments
  }
}

public struct PullRequestCommit: Sendable, Hashable, Codable, Identifiable {
  public var id: String { oid }
  public var oid: String
  public var messageHeadline: String
  public var committedDate: WireTimestamp
  public var additions: Int?
  public var deletions: Int?
  @WireList public var authors: [PullRequestActor] = []

  public init(oid: String, messageHeadline: String, committedDate: WireTimestamp, authors: [PullRequestActor] = []) {
    self.oid = oid
    self.messageHeadline = messageHeadline
    self.committedDate = committedDate
    self.authors = authors
  }
}

public struct PullRequestStackMembership: Sendable, Hashable, Codable {
  public var number: Int
  public var position: Int
  public var size: Int
  public var base: String
}

public struct PullRequestCapabilities: Sendable, Hashable, Codable {
  public struct Review: Sendable, Hashable, Codable {
    public var inlineComment: Bool
    public var rangeComment: Bool?
    public var reply: Bool
    public var resolve: Bool
    @WireList public var verdicts: [WireEnum<PullRequestReviewVerdict>] = []
  }
  public struct Reviewers: Sendable, Hashable, Codable {
    public var request: Bool
    public var listCandidates: Bool
    public var searchCandidates: Bool?
  }
  public struct Edit: Sendable, Hashable, Codable {
    public var changeRequest: Bool
    public var comment: Bool
    public var maintainerEdits: Bool?
  }

  public var diff: Bool
  public var comment: Bool
  @WireList public var actions: [WireEnum<PullRequestAction>] = []
  @WireList public var mergeMethods: [WireEnum<PullRequestMergeMethod>] = []
  public var deleteBranch: Bool?
  @Tolerant public var updateMethods: [WireEnum<PullRequestUpdateMethod>]? = nil
  public var search: Bool
  public var reactions: Bool?
  public var viewedFiles: String?
  public var review: Review
  public var reviewers: Reviewers
  @Tolerant public var edit: Edit? = nil
  public var labels: Bool?
  public var mentions: Bool?
  public var withheldFileDiff: Bool?
}

/// Unreported host permissions are granted (absent fields allow).
public struct PullRequestViewerPermissions: Sendable, Hashable, Codable {
  @WireList public var actions: [WireEnum<PullRequestAction>] = []
  public var comment: Bool
  public var resolve: Bool
  @WireList public var verdicts: [WireEnum<PullRequestReviewVerdict>] = []
  public var requestReviewers: Bool
  @Tolerant public var updateMethods: [WireEnum<PullRequestUpdateMethod>]? = nil
  public var labels: Bool?
  public var editChangeRequest: Bool?
  public var maintainerEdits: Bool?
}

public struct PullRequestMergeCapabilities: Sendable, Hashable, Codable {
  public var merge: Bool
  public var squash: Bool
  public var rebase: Bool
  public var fastForward: Bool?

  enum CodingKeys: String, CodingKey {
    case merge, squash, rebase
    case fastForward = "fast-forward"
  }

  public func allows(_ method: PullRequestMergeMethod) -> Bool {
    switch method {
    case .merge: merge
    case .squash: squash
    case .rebase: rebase
    case .fastForward: fastForward == true
    }
  }
}

public struct PullRequestListEntry: Sendable, Hashable, Codable {
  @Tolerant public var stack: PullRequestStackMembership? = nil
  public var provider: String
  public var host: String
  public var projectId: String
  public var projectTitle: String
  public var repository: String
  public var number: Int
  public var title: String
  public var url: String
  @Tolerant public var author: PullRequestActor? = nil
  public var headBranch: String
  public var baseBranch: String
  public var state: WireEnum<PullRequestState>
  public var isDraft: Bool
  public var mergeability: WireEnum<PullRequestMergeability>
  public var rebaseRequired: Bool?
  /// Zero until `pullRequests.listStats` answers; GitHub listings omit counts.
  public var additions: Int
  public var deletions: Int
  public var createdAt: WireTimestamp
  public var updatedAt: WireTimestamp
  public var observedAt: Double?
  public var viewerReviewRequested: Bool
  @WireList public var labels: [PullRequestLabel] = []
  public var reviewDecision: WireEnum<PullRequestReviewDecision>?
  public var checksState: WireEnum<PullRequestChecksState>?
  public var visibility: String?
}

public struct PullRequestProviderSummary: Sendable, Hashable, Codable {
  public var host: String
  public var kind: String
  public var searchesOnHost: Bool
  public var projectCount: Int
  @Tolerant public var projectIds: [String]? = nil
  public var configured: Bool
  public var detail: String?
}

public struct PullRequestListProjectError: Sendable, Hashable, Codable {
  public var projectId: String
  public var projectTitle: String
  public var message: String
}

public struct PullRequestListResult: Sendable, Hashable, Codable {
  public var viewers: [String: String]
  @WireList public var providers: [PullRequestProviderSummary] = []
  @WireList public var entries: [PullRequestListEntry] = []
  @WireList public var errors: [PullRequestListProjectError] = []
  public var truncated: Bool
  public var nextCursors: [String: String]

  public init(
    viewers: [String: String] = [:], providers: [PullRequestProviderSummary] = [], entries: [PullRequestListEntry],
    errors: [PullRequestListProjectError] = [], truncated: Bool = false, nextCursors: [String: String] = [:]
  ) {
    self.viewers = viewers
    self.providers = providers
    self.entries = entries
    self.errors = errors
    self.truncated = truncated
    self.nextCursors = nextCursors
  }

  enum CodingKeys: String, CodingKey { case viewers, providers, entries, errors, truncated, nextCursors }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    viewers = c.loose([String: String].self, .viewers) ?? [:]
    _providers = try c.decode(WireList<PullRequestProviderSummary>.self, forKey: .providers)
    _entries = try c.decode(WireList<PullRequestListEntry>.self, forKey: .entries)
    _errors = try c.decode(WireList<PullRequestListProjectError>.self, forKey: .errors)
    truncated = c.loose(Bool.self, .truncated) ?? false
    nextCursors = c.loose([String: String].self, .nextCursors) ?? [:]
  }
}

public struct PullRequestDiffStat: Sendable, Hashable, Codable {
  public var projectId: String
  public var repository: String
  public var number: Int
  public var additions: Int
  public var deletions: Int
}

public struct PullRequestListStatsResult: Sendable, Hashable, Codable {
  @WireList public var stats: [PullRequestDiffStat] = []
}

public struct PullRequestMergeQueueRemoval: Sendable, Hashable, Codable {
  public var id: String
  public var removedAt: WireTimestamp
  public var reason: String?
}

/// `pullRequests.detail`.
public struct PullRequestDetail: Sendable, Hashable, Codable {
  public var provider: String
  public var capabilities: PullRequestCapabilities
  public var viewerPermissions: PullRequestViewerPermissions
  public var projectId: String
  public var projectTitle: String
  public var workspaceRoot: String
  public var repository: String
  public var number: Int
  public var title: String
  public var body: String
  public var url: String
  @Tolerant public var author: PullRequestActor? = nil
  public var state: WireEnum<PullRequestState>
  public var isDraft: Bool
  public var mergeability: WireEnum<PullRequestMergeability>
  public var rebaseRequired: Bool?
  public var additions: Int
  public var deletions: Int
  public var changedFiles: Int
  public var headBranch: String
  public var headRepositoryNameWithOwner: String?
  public var headSha: String?
  public var baseBranch: String
  public var createdAt: WireTimestamp
  public var updatedAt: WireTimestamp
  public var observedAt: Double?
  public var mergedAt: WireTimestamp?
  public var mergeCommitSha: String?
  @Tolerant public var mergedBy: PullRequestActor? = nil
  public var closedAt: WireTimestamp?
  @WireList public var reviewers: [PullRequestActor] = []
  @WireList public var labels: [PullRequestLabel] = []
  @WireList public var checks: [PullRequestCheck] = []
  public var mergeCapabilities: PullRequestMergeCapabilities
  public var viewer: String?
  public var baseComparison: String?
  public var behindBy: Int?
  public var autoMergeEnabled: Bool?
  public var autoMergeMethod: WireEnum<PullRequestMergeMethod>?
  public var workflowApprovalsRequired: Int?
  @Tolerant public var mergeQueueRemoval: PullRequestMergeQueueRemoval? = nil
  public var maintainerCanModify: Bool?
  public var visibility: String?
}

/// `pullRequests.checks`.
public struct PullRequestChecks: Sendable, Hashable, Codable {
  public var observedAt: Double?
  public var state: WireEnum<PullRequestState>
  @WireList public var checks: [PullRequestCheck] = []
}

/// `pullRequests.activity`: the conversation.
public struct PullRequestActivity: Sendable, Hashable, Codable {
  @Tolerant public var author: PullRequestActor? = nil
  @Tolerant public var reviewers: [PullRequestActor]? = nil
  @WireList public var comments: [PullRequestComment] = []
  public var commentCount: Int
  public var commentsTruncated: Bool
  public var reviewThreadsTruncated: Bool?
  @WireList public var reviewThreads: [PullRequestReviewThread] = []
  @WireList public var overviewThreads: [PullRequestReviewThread] = []
  @WireList public var commits: [PullRequestCommit] = []
  @WireList public var reactions: [PullRequestReaction] = []

  public init(
    comments: [PullRequestComment], reviewThreads: [PullRequestReviewThread] = [], commits: [PullRequestCommit] = [],
    reactions: [PullRequestReaction] = []
  ) {
    self.comments = comments
    commentCount = comments.count
    commentsTruncated = false
    self.reviewThreads = reviewThreads
    self.commits = commits
    self.reactions = reactions
  }

  /// Line threads, then whole-change threads (`pullRequestConversationThreads`).
  public var conversationThreads: [PullRequestReviewThread] { reviewThreads + overviewThreads }
}

/// The HTTP diff (`POST /api/pull-requests/diff`), one slice of the patch.
public struct PullRequestDiffResult: Sendable, Hashable, Codable {
  public struct OmittedFileStat: Sendable, Hashable, Codable {
    public var path: String
    public var additions: Double
    public var deletions: Double
  }
  public var patch: String
  /// Content was left out of this slice; `nextCursor` says more slices exist.
  public var truncated: Bool
  public var nextCursor: String?
  @WireList public var omittedFileStats: [OmittedFileStat] = []
  public var withheldFilesReadable: Bool?

  public init(patch: String, truncated: Bool = false, nextCursor: String? = nil) {
    self.patch = patch
    self.truncated = truncated
    self.nextCursor = nextCursor
  }
}

public struct PullRequestFilesViewedResult: Sendable, Hashable, Codable {
  public struct File: Sendable, Hashable, Codable {
    public var path: String
    public var state: WireEnum<PullRequestFileViewedState>
  }
  /// Only the files the host reported; a missing file is unviewed.
  @WireList public var files: [File] = []
  public var truncated: Bool
}

public struct PullRequestLinkedThreadsResult: Sendable, Hashable, Codable {
  public struct Thread: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var projectId: String
    public var title: String
    public var archivedAt: WireTimestamp?
    public var settled: Bool?
  }
  @WireList public var threads: [Thread] = []
}

public struct PullRequestRoutingResult: Sendable, Hashable, Codable {
  public var accountId: String
  public var host: String
  public var provider: String
  public var viewer: String
  public var projectTitle: String
  public var workspaceRoot: String
}

public struct PullRequestRoutingIdentityResult: Sendable, Hashable, Codable {
  public var accountId: String
  public var host: String
  public var provider: String
  public var viewer: String
}

public struct PullRequestReviewerCandidate: Sendable, Hashable, Codable, Identifiable {
  public var isBot: Bool?
  public var login: String
  public var name: String?
  public var avatarUrl: String?
  public var id: String
  public var kind: WireEnum<PullRequestReviewerKind>
  public var isRequested: Bool
}

public struct PullRequestReviewerCandidateList: Sendable, Hashable, Codable {
  @WireList public var candidates: [PullRequestReviewerCandidate] = []
  public var truncated: Bool
}

/// `pullRequests.runAction` with `replyWithSummary`: the pull request after the action.
public struct PullRequestSummary: Sendable, Hashable, Codable {
  public var provider: String
  public var projectId: String
  public var repository: String
  public var number: Int
  public var title: String
  public var url: String
  public var state: WireEnum<PullRequestState>
  public var isDraft: Bool?
  public var headBranch: String
  public var baseBranch: String
  public var updatedAt: WireTimestamp
  public var checksState: WireEnum<PullRequestChecksState>?
  public var reviewDecision: WireEnum<PullRequestReviewDecision>?
  public var mergeability: WireEnum<PullRequestMergeability>?
  public var headSha: String?
  public var autoMergeEnabled: Bool?
}
