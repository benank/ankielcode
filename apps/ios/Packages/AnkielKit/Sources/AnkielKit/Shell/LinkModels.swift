extension ThreadShell {
  public struct LinkedPullRequest: Sendable, Hashable, Codable {
    public var projectId: String
    public var repository: String
    public var number: Int
    public var url: String
  }

  public struct PullRequestLink: Sendable, Hashable, Codable {
    public var host: String
    public var repository: String
    public var number: Int
    public var url: String
    public var repositoryWebUrl: String?
    public var source: WireEnum<Source>
    public var linkedAt: WireTimestamp
    @Tolerant public var snapshot: PullRequestSnapshot?
    @Tolerant public var stack: PullRequestStack?
    @Tolerant public var watch: PullRequestWatch?
    @Tolerant public var endedWatch: PullRequestWatch?

    public enum Source: String, Sendable {
      case manual, created, agent, stack
      case stackDismissed = "stack-dismissed"
    }
  }

  public struct PullRequestSnapshot: Sendable, Hashable, Codable {
    public var state: WireEnum<State>
    public var title: String
    public var headBranch: String
    public var baseBranch: String
    public var isDraft: Bool
    public var updatedAt: WireTimestamp?
    public var syncedAt: WireTimestamp
    public var closedAt: WireTimestamp?
    public var mergedAt: WireTimestamp?
    @Tolerant public var author: IssueActor?
    public var additions: Int?
    public var deletions: Int?
    public var changedFiles: Int?
    public var reviewDecision: WireEnum<ReviewDecision>?
    public var checksState: WireEnum<ChecksState>?
    public var mergeability: WireEnum<Mergeability>?
    public var rebaseRequired: Bool?

    public enum State: String, Sendable { case open, closed, merged }
    public enum ReviewDecision: String, Sendable {
      case approved
      case changesRequested = "changes-requested"
      case reviewRequired = "review-required"
    }
    public enum ChecksState: String, Sendable { case passing, failing, pending }
    public enum Mergeability: String, Sendable { case mergeable, conflicting, unknown }
  }

  public struct PullRequestStack: Sendable, Hashable, Codable {
    public var kind: String
    public var id: String
    public var number: Int
    public var url: String
    public var base: String
    public var layers: [Layer]

    public struct Layer: Sendable, Hashable, Codable {
      public var number: Int
      public var headBranch: String
      public var state: WireEnum<PullRequestSnapshot.State>
    }
  }

  public struct PullRequestWatch: Sendable, Hashable, Codable {
    public var startedAt: WireTimestamp
    public var headSha: String?
    public var failedChecks: [String]
    public var passed: Bool
    public var passedChecks: [String]?
    public var owedChecks: [String]?
    public var awaitingApproval: [String]?
    public var approvalAnnounced: Bool?
    public var remarksThrough: String
    public var remarkIds: [String]
    public var conflicting: Bool
    public var rebaseRequired: Bool?
    public var mergeQueueRemovalId: String?
    public var wakes: Int
    public var awaitingBaseline: String?
    public var checksAwaitedSince: WireTimestamp?
    public var checksPending: Bool?
    public var until: String?
  }

  public struct IssueActor: Sendable, Hashable, Codable {
    public var isBot: Bool?
    public var login: String
    public var name: String?
    public var avatarUrl: String?
  }

  public struct IssueLink: Sendable, Hashable, Codable {
    public var tracker: String
    public var host: String
    public var scope: String
    public var key: String
    public var projectId: String
    public var url: String
    public var source: WireEnum<Source>
    public var linkedAt: WireTimestamp
    public var displayKey: String
    public var title: String

    public enum Source: String, Sendable { case manual, agent }
  }
}
