import Foundation

/// `OrchestrationV2ThreadProjection` (spec §6.3), keeping the records the thread screen reads.
/// Provider sessions and threads, plans and context records are not rendered and not held; their
/// events are accepted and ignored. Checkpoints are held for review (turn diffs).
public struct ThreadProjection: Sendable, Hashable {
  public var thread: AppThread
  public var runs: [Run]
  public var attempts: [RunAttempt]
  public var nodes: [ExecutionNode]
  public var subagents: [Subagent]
  public var providerTurns: [ProviderTurn]
  /// The provider conversations behind the thread, for context usage.
  public var providerThreads: [ProviderThread] = []
  public var runtimeRequests: [RuntimeRequest]
  public var messages: [ConversationMessage]
  public var turnItems: [TurnItem]
  public var visibleTurnItems: [ProjectedTurnItem]
  public var checkpoints: [Checkpoint] = []
  public var checkpointScopes: [CheckpointScope] = []
  public var updatedAt: WireTimestamp
  /// The last revision stamped on an item (local bookkeeping, not on the wire).
  public internal(set) var revisionClock = 0

  public init(
    thread: AppThread, runs: [Run] = [], attempts: [RunAttempt] = [], nodes: [ExecutionNode] = [],
    subagents: [Subagent] = [], providerTurns: [ProviderTurn] = [], runtimeRequests: [RuntimeRequest] = [],
    messages: [ConversationMessage] = [], turnItems: [TurnItem] = [], visibleTurnItems: [ProjectedTurnItem] = [],
    updatedAt: WireTimestamp
  ) {
    self.thread = thread
    self.runs = runs
    self.attempts = attempts
    self.nodes = nodes
    self.subagents = subagents
    self.providerTurns = providerTurns
    self.runtimeRequests = runtimeRequests
    self.messages = messages
    self.turnItems = turnItems
    self.visibleTurnItems = visibleTurnItems
    self.updatedAt = updatedAt
  }
}

extension ThreadProjection: Decodable {
  enum CodingKeys: String, CodingKey {
    case thread, runs, attempts, nodes, subagents, providerTurns, runtimeRequests, messages
    case turnItems, visibleTurnItems, updatedAt, checkpoints, checkpointScopes, providerThreads
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    func list<Element: Decodable & Sendable>(_ key: CodingKeys) -> [Element] {
      container.loose(LossyArray<Element>.self, key)?.elements ?? []
    }
    thread = try container.decode(AppThread.self, forKey: .thread)
    runs = list(.runs)
    attempts = list(.attempts)
    nodes = list(.nodes)
    subagents = list(.subagents)
    providerTurns = list(.providerTurns)
    providerThreads = list(.providerThreads)
    runtimeRequests = list(.runtimeRequests)
    messages = list(.messages)
    turnItems = list(.turnItems)
    visibleTurnItems = list(.visibleTurnItems)
    checkpoints = list(.checkpoints)
    checkpointScopes = list(.checkpointScopes)
    updatedAt = try container.decode(WireTimestamp.self, forKey: .updatedAt)
  }
}

/// `OrchestrationV2ProjectedTurnItem`: one row of the server-computed visible timeline.
public struct ProjectedTurnItem: Sendable, Hashable, Decodable {
  public var position: Int
  public var visibility: WireEnum<Visibility>
  public var sourceThreadId: String
  public var sourceItemId: String
  public var item: TurnItem

  public enum Visibility: String, Sendable {
    case local, inherited, synthetic
  }

  public var isLocal: Bool { visibility == .local }

  /// The feed's stable id for this row (RN `${visibility}:${sourceThreadId}:${sourceItemId}`).
  public var feedId: String { "\(visibility.rawValue):\(sourceThreadId):\(sourceItemId)" }

  public init(position: Int, item: TurnItem, visibility: Visibility = .local) {
    self.position = position
    self.visibility = .init(visibility)
    sourceThreadId = item.threadId
    sourceItemId = item.id
    self.item = item
  }
}

/// `OrchestrationV2AppThread`, the fields the thread screen reads.
public struct AppThread: Sendable, Hashable, Decodable {
  public var id: String
  public var projectId: String
  public var title: String
  public var modelSelection: ModelSelection?
  public var branch: String?
  public var worktreePath: String?
  public var lineage: Lineage?
  public var archivedAt: WireTimestamp?
  public var deletedAt: WireTimestamp?
  public var updatedAt: WireTimestamp?
  /// The provider conversation the thread continues in.
  public var activeProviderThreadId: String?

  public struct Lineage: Sendable, Hashable, Decodable {
    public var rootThreadId: String?
    public var parentThreadId: String?
    public var relationshipToParent: String?
  }

  public init(id: String, projectId: String, title: String) {
    self.id = id
    self.projectId = projectId
    self.title = title
  }

  enum CodingKeys: String, CodingKey {
    case id, projectId, title, modelSelection, branch, worktreePath, lineage, archivedAt, deletedAt, updatedAt
    case activeProviderThreadId
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    projectId = container.loose(String.self, .projectId) ?? ""
    title = container.loose(String.self, .title) ?? ""
    modelSelection = container.loose(ModelSelection.self, .modelSelection)
    branch = container.loose(String.self, .branch)
    worktreePath = container.loose(String.self, .worktreePath)
    lineage = container.loose(Lineage.self, .lineage)
    archivedAt = container.loose(WireTimestamp.self, .archivedAt)
    deletedAt = container.loose(WireTimestamp.self, .deletedAt)
    updatedAt = container.loose(WireTimestamp.self, .updatedAt)
    activeProviderThreadId = container.loose(String.self, .activeProviderThreadId)
  }
}

/// `OrchestrationV2RunStatus`.
public enum RunStatus: String, Sendable {
  case preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled
  case rolledBack = "rolled_back"

  /// A turn in progress (spec §6.7).
  public var isActive: Bool {
    switch self {
    case .preparing, .queued, .starting, .running, .waiting: true
    default: false
    }
  }
}

/// `OrchestrationV2Run`: one user turn or queued message.
public struct Run: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var ordinal: Int?
  public var status: WireEnum<RunStatus>
  public var userMessageId: String?
  public var modelSelection: ModelSelection?
  public var requestedAt: WireTimestamp?
  public var startedAt: WireTimestamp?
  public var completedAt: WireTimestamp?
  public var workStartedAt: WireTimestamp?
  /// Order among queued runs (falls back to `ordinal`).
  public var queuePosition: Int?
  /// A stop or restart holds this queued run.
  public var queueHeld: Bool?
  /// Held so a lifecycle update without it cannot take it away (`run.output-submitted`).
  @Tolerant public var output: JSONValue?

  public init(id: String, status: RunStatus, startedAt: WireTimestamp? = nil, completedAt: WireTimestamp? = nil) {
    self.id = id
    self.status = WireEnum(status)
    self.startedAt = startedAt
    self.completedAt = completedAt
  }
}

/// `OrchestrationV2RunAttempt`.
public struct RunAttempt: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var runId: String
  public var rootNodeId: String
  public var status: String
}

/// `OrchestrationV2ExecutionNode`.
public struct ExecutionNode: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var runId: String?
  public var parentNodeId: String?
  public var rootNodeId: String
}

/// `OrchestrationV2Subagent`.
public struct Subagent: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var childThreadId: String?
  public var title: String?
  public var model: String?
  public var status: WireEnum<TurnItemStatus>
  public var prompt: String?
  public var progress: String?
  public var result: String?
}

/// `OrchestrationV2ProviderTurn`, for context usage.
public struct ProviderTurn: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var providerThreadId: String?
  public var status: String?
  public var model: String?
  @Tolerant public var tokenUsage: TokenUsage?

  /// `OrchestrationV2ProviderTurnTokenUsage`: the context window after this turn.
  public struct TokenUsage: Sendable, Hashable, Codable {
    public var usedTokens: Int
    public var maxTokens: Int?
    public var inputTokens: Int?
    public var cachedInputTokens: Int?
    public var outputTokens: Int?
    public var reasoningOutputTokens: Int?
    public var promptCacheTtlMs: Int?
    public var autoCompactThreshold: Int?
    public var updatedAt: WireTimestamp?

    public init(usedTokens: Int, maxTokens: Int? = nil, updatedAt: WireTimestamp? = nil) {
      self.usedTokens = usedTokens
      self.maxTokens = maxTokens
      self.updatedAt = updatedAt
    }
  }

  public init(
    id: String, providerThreadId: String? = nil, status: String? = nil, model: String? = nil, tokenUsage: TokenUsage? = nil
  ) {
    self.id = id
    self.providerThreadId = providerThreadId
    self.status = status
    self.model = model
    self.tokenUsage = tokenUsage
  }
}

/// `OrchestrationV2ProviderThread`, for context usage.
public struct ProviderThread: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var appThreadId: String?
  public var status: String?
  public var firstRunOrdinal: Int?
  public var providerSessionId: String?
  public var hasNativeThreadRef = false
  @Tolerant public var contextUsage: ContextUsage?
  public var updatedAt: WireTimestamp?

  /// `ThreadTokenUsageSnapshot`.
  public struct ContextUsage: Sendable, Hashable, Codable {
    public var usedTokens: Int
    public var totalProcessedTokens: Int?
    public var maxTokens: Int?
    public var inputTokens: Int?
    public var cachedInputTokens: Int?
    public var outputTokens: Int?
    public var reasoningOutputTokens: Int?
    public var toolUses: Int?
    public var durationMs: Int?
    public var compactsAutomatically: Bool?
    public var autoCompactThreshold: Int?

    public init(usedTokens: Int, maxTokens: Int? = nil) {
      self.usedTokens = usedTokens
      self.maxTokens = maxTokens
    }
  }

  public init(id: String, appThreadId: String? = nil, contextUsage: ContextUsage? = nil, updatedAt: WireTimestamp? = nil) {
    self.id = id
    self.appThreadId = appThreadId
    self.contextUsage = contextUsage
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey {
    case id, appThreadId, status, firstRunOrdinal, providerSessionId, nativeThreadRef, contextUsage, updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    appThreadId = c.loose(String.self, .appThreadId)
    status = c.loose(String.self, .status)
    firstRunOrdinal = c.loose(Int.self, .firstRunOrdinal)
    providerSessionId = c.loose(String.self, .providerSessionId)
    hasNativeThreadRef = c.loose(JSONValue.self, .nativeThreadRef).map { $0 != .null } ?? false
    contextUsage = c.loose(ContextUsage.self, .contextUsage)
    updatedAt = c.loose(WireTimestamp.self, .updatedAt)
  }

  /// A provider thread queued for a run that has not started (`isQueuedProviderThreadPlaceholder`).
  public var isQueuedPlaceholder: Bool {
    status == "not_loaded" && firstRunOrdinal == nil && !hasNativeThreadRef && providerSessionId == nil
  }
}

/// `OrchestrationV2RuntimeRequest`: an approval or question and whether it can be answered.
public struct RuntimeRequest: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var kind: String
  public var status: WireEnum<Status>
  public var responseCapability: ResponseCapability?
  public var createdAt: WireTimestamp?
  public var resolvedAt: WireTimestamp?
  public var decision: String?
  @Tolerant public var answers: JSONValue?

  public enum Status: String, Sendable {
    case pending, resolved, expired, cancelled
  }

  public struct ResponseCapability: Sendable, Hashable, Decodable {
    /// `live`, `message` or `not_resumable`.
    public var type: String
    public var reason: String?
    public var supportsFeedback: Bool?

    public init(type: String, reason: String? = nil, supportsFeedback: Bool? = nil) {
      self.type = type
      self.reason = reason
      self.supportsFeedback = supportsFeedback
    }
  }
}

/// `OrchestrationV2ConversationMessage`.
public struct ConversationMessage: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var role: String
  public var text: String
  public var streaming: Bool?
  public var updatedAt: WireTimestamp?
  public var attachmentCount: Int
  /// A wake from delegated work or a notification, not something the user typed.
  public var automatic: Bool

  enum CodingKeys: String, CodingKey { case id, role, text, streaming, updatedAt, attachments, delegatedCompletion, notification }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    role = c.loose(String.self, .role) ?? ""
    text = c.loose(String.self, .text) ?? ""
    streaming = c.loose(Bool.self, .streaming)
    updatedAt = c.loose(WireTimestamp.self, .updatedAt)
    attachmentCount = c.loose([JSONValue].self, .attachments)?.count ?? 0
    automatic = [CodingKeys.delegatedCompletion, .notification].contains { key in
      c.loose(JSONValue.self, key).map { !$0.isNull } ?? false
    }
  }
}

/// `OrchestrationV2Checkpoint`: the files one turn (or subagent, or tool) changed, for review.
public struct Checkpoint: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var scopeId: String
  public var runId: String?
  /// The app turn it closes (1-based), nil for checkpoints inside a turn.
  public var appRunOrdinal: Int?
  public var ordinalWithinScope: Int
  /// `ready`, `missing`, `error` or `stale`.
  public var status: String
  public var files: [File]
  public var filesTotal: Totals?
  public var capturedAt: WireTimestamp?

  public struct File: Sendable, Hashable, Decodable {
    public var path: String
    public var kind: String
    public var additions: Int
    public var deletions: Int

    public init(path: String, kind: String = "modified", additions: Int, deletions: Int) {
      self.path = path
      self.kind = kind
      self.additions = additions
      self.deletions = deletions
    }
  }

  public struct Totals: Sendable, Hashable, Decodable {
    public var count: Int
    public var additions: Int
    public var deletions: Int

    public init(count: Int, additions: Int, deletions: Int) {
      self.count = count
      self.additions = additions
      self.deletions = deletions
    }
  }

  public init(id: String, scopeId: String = "scope", runId: String?, appRunOrdinal: Int?, status: String = "ready", files: [File]) {
    self.id = id
    self.scopeId = scopeId
    self.runId = runId
    self.appRunOrdinal = appRunOrdinal
    ordinalWithinScope = appRunOrdinal ?? 0
    self.status = status
    self.files = files
  }

  enum CodingKeys: String, CodingKey { case id, scopeId, runId, appRunOrdinal, ordinalWithinScope, status, files, filesTotal, capturedAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    scopeId = c.loose(String.self, .scopeId) ?? ""
    runId = c.loose(String.self, .runId)
    appRunOrdinal = c.loose(Int.self, .appRunOrdinal)
    ordinalWithinScope = c.loose(Int.self, .ordinalWithinScope) ?? 0
    status = c.loose(String.self, .status) ?? "ready"
    files = c.loose(LossyArray<File>.self, .files)?.elements ?? []
    filesTotal = c.loose(Totals.self, .filesTotal)
    capturedAt = c.loose(WireTimestamp.self, .capturedAt)
  }
}

/// `OrchestrationV2CheckpointScope`: a scope with `repositoryPath` belongs to a tracked repository.
public struct CheckpointScope: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var parentScopeId: String?
  public var kind: String?
  public var cwd: String?
  public var label: String?
  public var repositoryPath: String?
}
