/// `OrchestrationV2ThreadShell`: one thread row in the shell. Optional fields are nil when the
/// server omitted them or sent `null`; `@Tolerant` fields are also nil when unreadable.
public struct ThreadShell: Sendable, Hashable, Codable, Identifiable {
  public var createdBy: WireEnum<Actor>
  public var creationSource: WireEnum<CreationSource>
  public var id: String
  public var projectId: String
  public var title: String
  public var providerInstanceId: String
  public var modelSelection: ModelSelection
  public var runtimeMode: WireEnum<RuntimeMode>
  public var interactionMode: WireEnum<InteractionMode>
  public var branch: String?
  public var worktreePath: String?
  @Tolerant public var linkedPullRequest: LinkedPullRequest?
  @Tolerant public var pullRequests: [PullRequestLink]?
  @Tolerant public var branchPullRequest: LinkedPullRequest?
  @Tolerant public var issues: [IssueLink]?
  public var lineage: Lineage
  @Tolerant public var forkedFrom: ForkedFrom?
  public var activeProviderThreadId: String?
  public var historyOrigin: WireEnum<HistoryOrigin>?
  @Tolerant public var workflowRun: WorkflowOrigin?
  public var latestRunId: String?
  public var latestRunRequestedAt: WireTimestamp?
  public var latestRunStartedAt: WireTimestamp?
  public var latestRunCompletedAt: WireTimestamp?
  public var latestRunStopRequested: Bool?
  public var latestRunBackgroundWake: Bool?
  public var activeRunId: String?
  public var activityRunStartedAt: WireTimestamp?
  public var activityRunStatus: WireEnum<ActivityRunStatus>?
  public var blockedOnThreadWait: Bool?
  public var subagentTurnActive: Bool?
  public var status: WireEnum<Status>
  public var lastError: String?
  public var lastErrorClass: WireEnum<ProviderFailureClass>?
  public var lastErrorCode: String?
  public var usageLimitResetAt: WireTimestamp?
  @Tolerant public var pendingRuntimeRequest: PendingRuntimeRequest?
  @Tolerant public var latestVisibleMessage: LatestVisibleMessage?
  public var latestUserMessageAt: WireTimestamp?
  public var latestUserAuthoredMessageAt: WireTimestamp?
  public var hasActionableProposedPlan: Bool
  /// nil means `[]` (the server's decoding default).
  @Tolerant public var pendingBackgroundTasks: [PendingBackgroundTask]?
  /// nil means `[]`.
  public var providerInstanceHistory: [String]?
  @Tolerant public var goal: ProviderGoal?
  public var itemCount: Int
  public var visibleItemCount: Int
  public var createdAt: WireTimestamp
  public var updatedAt: WireTimestamp
  public var archivedAt: WireTimestamp?
  public var settledOverride: WireEnum<SettledOverride>?
  public var settledAt: WireTimestamp?
  public var unsettledAt: WireTimestamp?
  public var snoozedUntil: WireTimestamp?
  public var snoozedAt: WireTimestamp?
  @Tolerant public var limitRecovery: LimitRecovery?
  public var pinnedAt: WireTimestamp?
  public var autoSettleDisabledAt: WireTimestamp?
  public var pinOrderKey: String?
  public var activeOrderKey: String?
  @Tolerant public var tags: [String]?
  public var lastVisitedAt: WireTimestamp?
  @Tolerant public var opens: ThreadOpens?
  @Tolerant public var titleRegeneration: TitleRegeneration?
  @Tolerant public var lastTitleRegeneration: LastTitleRegeneration?
  public var deletedAt: WireTimestamp?

  public enum Actor: String, Sendable { case user, agent, system }
  public enum CreationSource: String, Sendable { case web, mobile, mcp, provider, server }
  public enum HistoryOrigin: String, Sendable {
    case native
    case v1Import = "v1_import"
  }
  public enum ActivityRunStatus: String, Sendable { case preparing, starting, running, waiting }
  public enum Status: String, Sendable {
    case idle, preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled
    case rolledBack = "rolled_back"
  }
  public enum ProviderFailureClass: String, Sendable {
    case usageLimit = "usage_limit"
    case providerError = "provider_error"
    case transportError = "transport_error"
    case permissionError = "permission_error"
    case validationError = "validation_error"
    case unknown
  }
  public enum SettledOverride: String, Sendable { case settled, active }
}

extension ThreadShell {
  public struct Lineage: Sendable, Hashable, Codable {
    public var parentThreadId: String?
    public var relationshipToParent: WireEnum<Relationship>?
    public var rootThreadId: String
    public var sideChat: Bool?
    public var workflowStep: Bool?

    public enum Relationship: String, Sendable { case fork, subagent }

    /// `isListedThreadLineage`: subagents, side chats and workflow steps nest under a parent.
    public var isListed: Bool {
      relationshipToParent != .known(.subagent) && sideChat != true && workflowStep != true
    }
  }

  public enum ForkedFrom: Sendable, Hashable, Codable {
    case run(threadId: String, runId: String)
    case node(nodeId: String)
    case providerThread(providerThreadId: String, providerTurnId: String?)
    case unknown(type: String)

    enum CodingKeys: String, CodingKey { case type, threadId, runId, nodeId, providerThreadId, providerTurnId }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      switch try c.decode(String.self, forKey: .type) {
      case "run":
        self = .run(threadId: try c.decode(String.self, forKey: .threadId), runId: try c.decode(String.self, forKey: .runId))
      case "node":
        self = .node(nodeId: try c.decode(String.self, forKey: .nodeId))
      case "provider_thread":
        self = .providerThread(
          providerThreadId: try c.decode(String.self, forKey: .providerThreadId),
          providerTurnId: try c.decodeIfPresent(String.self, forKey: .providerTurnId))
      case let type:
        self = .unknown(type: type)
      }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      switch self {
      case .run(let threadId, let runId):
        try c.encode("run", forKey: .type)
        try c.encode(threadId, forKey: .threadId)
        try c.encode(runId, forKey: .runId)
      case .node(let nodeId):
        try c.encode("node", forKey: .type)
        try c.encode(nodeId, forKey: .nodeId)
      case .providerThread(let providerThreadId, let providerTurnId):
        try c.encode("provider_thread", forKey: .type)
        try c.encode(providerThreadId, forKey: .providerThreadId)
        try c.encodeIfPresent(providerTurnId, forKey: .providerTurnId)
      case .unknown(let type):
        try c.encode(type, forKey: .type)
      }
    }
  }

  public struct WorkflowOrigin: Sendable, Hashable, Codable {
    public var environmentId: String
    public var runId: String
    public var workflow: String
    public var step: String
  }

  public struct PendingRuntimeRequest: Sendable, Hashable, Codable {
    public var id: String
    public var kind: WireEnum<Kind>
    public var createdAt: WireTimestamp
    /// False for async questions the run keeps working past.
    public var blocking: Bool?
    /// Secret and link cards only the user can answer.
    public var userOnly: Bool?

    public enum Kind: String, Sendable {
      case command
      case fileRead = "file-read"
      case fileChange = "file-change"
      case mcpElicitation = "mcp-elicitation"
      case permission
      case dynamicToolCall = "dynamic_tool_call"
      case userInput = "user_input"
      case authRefresh = "auth_refresh"
    }
  }

  public struct LatestVisibleMessage: Sendable, Hashable, Codable {
    public var id: String
    public var role: WireEnum<Role>
    public var text: String
    public var updatedAt: WireTimestamp

    public enum Role: String, Sendable { case user, assistant, system }
  }

  public struct PendingBackgroundTask: Sendable, Hashable, Codable {
    public var taskId: String
    public var kind: WireEnum<Kind>?
    public var command: String?
    public var itemId: String?
    public var sourceThreadId: String?
    public var description: String?
    public var parentTaskId: String?
    public var nativeItemId: String?
    public var runId: String?
    public var awaited: Bool?
    public var providerInstanceId: String?
    public var childThreadId: String?

    public enum Kind: String, Sendable {
      case subagent, command, monitor
      case backgroundTask = "background_task"
    }
  }

  public struct ProviderGoal: Sendable, Hashable, Codable {
    public var objective: String
    public var status: WireEnum<Status>
    public var tokensUsed: Int?
    public var tokenBudget: Int?
    public var timeUsedSeconds: Int?
    public var checks: Int?
    public var lastCheck: String?

    public enum Status: String, Sendable {
      case active, paused, blocked, complete
      case usageLimited = "usage_limited"
      case budgetLimited = "budget_limited"
    }
  }

  public struct LimitRecovery: Sendable, Hashable, Codable {
    public var requestId: String?
    public var runId: String
    public var resetAt: WireTimestamp
    public var autoResume: Bool
    public var snooze: Bool?
    public var creditApplied: Bool?
  }

  public struct ThreadOpens: Sendable, Hashable, Codable {
    public var openedAt: WireNumber
    public var score: WireNumber
    public var picks: [Pick]

    public struct Pick: Sendable, Hashable, Codable {
      public var query: String
      public var at: WireNumber
    }
  }

  public struct TitleRegeneration: Sendable, Hashable, Codable {
    public var requestId: String
    public var startedAt: WireTimestamp
  }

  public struct LastTitleRegeneration: Sendable, Hashable, Codable {
    public var status: WireEnum<Status>
    public var message: String?
    public var requestId: String
    public var completedAt: WireTimestamp

    public enum Status: String, Sendable { case renamed, unchanged, failed }
  }
}
