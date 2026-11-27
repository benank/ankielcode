import Foundation

/// `OrchestrationV2ThreadProjection` (spec §6.3), keeping the records the thread screen reads.
/// Provider sessions and threads, plans, checkpoints and context records are not rendered and
/// not held; their events are accepted and ignored.
public struct ThreadProjection: Sendable, Hashable {
  public var thread: AppThread
  public var runs: [Run]
  public var attempts: [RunAttempt]
  public var nodes: [ExecutionNode]
  public var subagents: [Subagent]
  public var providerTurns: [ProviderTurn]
  public var runtimeRequests: [RuntimeRequest]
  public var messages: [ConversationMessage]
  public var turnItems: [TurnItem]
  public var visibleTurnItems: [ProjectedTurnItem]
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
    case turnItems, visibleTurnItems, updatedAt
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
    runtimeRequests = list(.runtimeRequests)
    messages = list(.messages)
    turnItems = list(.turnItems)
    visibleTurnItems = list(.visibleTurnItems)
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
  public var status: String?
  public var model: String?
  @Tolerant public var tokenUsage: TokenUsage?

  public struct TokenUsage: Sendable, Hashable, Codable {
    public var usedTokens: Int
    public var maxTokens: Int?
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
