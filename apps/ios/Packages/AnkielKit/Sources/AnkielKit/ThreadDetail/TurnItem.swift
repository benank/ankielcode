import Foundation

/// `OrchestrationV2TurnItemStatus`.
public enum TurnItemStatus: String, Sendable {
  case idle, pending, running, waiting, completed, failed, cancelled, interrupted
}

/// One timeline item (`OrchestrationV2TurnItem`, spec A.4): the common fields every type carries
/// and a typed body. A known type whose body does not decode, and any type this client does not
/// know, decode as `.unknown` so the row still shows (quietly) instead of dropping the stream.
public struct TurnItem: Sendable, Hashable, Identifiable {
  public var id: String
  public var threadId: String
  public var runId: String?
  public var nodeId: String?
  public var providerTurnId: String?
  public var parentItemId: String?
  public var ordinal: Int
  public var status: WireEnum<TurnItemStatus>
  public var title: String?
  public var startedAt: WireTimestamp?
  public var completedAt: WireTimestamp?
  public var updatedAt: WireTimestamp
  /// The wire `type`.
  public var type: String
  public var body: TurnItemBody
  public var deferredWork: DeferredWork?
  public var toolSurface: String?
  /// Bumped by the reducer each time the item is replaced, so derived rows and parsed markdown
  /// can be keyed on `(id, revision)` instead of comparing bodies.
  public var revision: Int = 0

  public struct DeferredWork: Sendable, Hashable, Codable {
    public var cursor: String
    public var itemCount: Int
    public var lastOrdinal: Int
  }

  public init(
    id: String, threadId: String, runId: String?, nodeId: String? = nil, ordinal: Int,
    status: TurnItemStatus, title: String? = nil, startedAt: WireTimestamp? = nil,
    completedAt: WireTimestamp? = nil, updatedAt: WireTimestamp, body: TurnItemBody
  ) {
    self.id = id
    self.threadId = threadId
    self.runId = runId
    self.nodeId = nodeId
    self.ordinal = ordinal
    self.status = WireEnum(status)
    self.title = title
    self.startedAt = startedAt
    self.completedAt = completedAt
    self.updatedAt = updatedAt
    self.body = body
    type = body.wireType
  }

  /// The run state an item's status maps to in the work log.
  public var lifecycle: Lifecycle {
    switch status.known {
    case .pending, .running, .waiting: .inProgress
    case .idle: .idle
    case .completed: .completed
    case .failed: .failed
    case .cancelled, .interrupted: .stopped
    case nil: .idle
    }
  }

  public enum Lifecycle: Sendable, Hashable {
    case inProgress, idle, completed, failed, stopped
  }

  /// Text the stream left out because the client holds it elsewhere (deduped bodies are never
  /// requested by this client, so this only reflects `textOmitted` from older caches).
  public var displayStart: WireTimestamp { startedAt ?? updatedAt }
}

/// The type-specific part of a turn item.
public enum TurnItemBody: Sendable, Hashable {
  case userMessage(UserMessage)
  case assistantMessage(AssistantMessage)
  case reasoning(Reasoning)
  case proposedPlan(ProposedPlan)
  case todoList(TodoList)
  case userInputRequest(UserInputRequest)
  case approvalRequest(ApprovalRequest)
  case commandExecution(CommandExecution)
  case fileChange(FileChange)
  case fileSearch(FileSearch)
  case webSearch(WebSearch)
  case dynamicTool(DynamicTool)
  case subagent(SubagentCall)
  case checkpoint(Checkpoint)
  case runInterruptRequest(message: String)
  case runInterruptResult(message: String)
  case systemNotice(SystemNotice)
  case error(ErrorNotice)
  case compaction(Compaction)
  case handoff(Handoff)
  case fork(targetThreadId: String)
  case threadCreated(targetThreadId: String, targetModel: String?)
  case secretRequest(SecretRequest)
  case linkRequest(LinkRequest)
  case notification(Notification)
  case unknown(type: String)

  public var wireType: String {
    switch self {
    case .userMessage: "user_message"
    case .assistantMessage: "assistant_message"
    case .reasoning: "reasoning"
    case .proposedPlan: "proposed_plan"
    case .todoList: "todo_list"
    case .userInputRequest: "user_input_request"
    case .approvalRequest: "approval_request"
    case .commandExecution: "command_execution"
    case .fileChange: "file_change"
    case .fileSearch: "file_search"
    case .webSearch: "web_search"
    case .dynamicTool: "dynamic_tool"
    case .subagent: "subagent"
    case .checkpoint: "checkpoint"
    case .runInterruptRequest: "run_interrupt_request"
    case .runInterruptResult: "run_interrupt_result"
    case .systemNotice: "system_notice"
    case .error: "error"
    case .compaction: "compaction"
    case .handoff: "handoff"
    case .fork: "fork"
    case .threadCreated: "thread_created"
    case .secretRequest: "secret_request"
    case .linkRequest: "link_request"
    case .notification: "notification"
    case .unknown(let type): type
    }
  }

  public struct UserMessage: Sendable, Hashable, Decodable {
    public var messageId: String
    public var text: String
    public var textOmitted: Bool?
    public var inputIntent: WireEnum<InputIntent>
    public var createdBy: String?
    public var attachments: LossyArray<ChatAttachment>
    public var freshContext: Bool?
    public var senderThreadId: String?
    public var scheduledTaskId: String?

    public enum InputIntent: String, Sendable {
      case turnStart = "turn_start"
      case queuedTurn = "queued_turn"
      case steer
      case promotedQueuedToSteer = "promoted_queued_to_steer"
    }

    public var isSteer: Bool {
      inputIntent == .steer || inputIntent == .promotedQueuedToSteer
    }

    public init(messageId: String, text: String, inputIntent: InputIntent = .turnStart, attachments: [ChatAttachment] = []) {
      self.messageId = messageId
      self.text = text
      self.inputIntent = WireEnum(inputIntent)
      self.attachments = LossyArray(attachments)
    }
  }

  public struct AssistantMessage: Sendable, Hashable, Decodable {
    public var messageId: String
    public var text: String
    public var textOmitted: Bool?
    public var streaming: Bool
    public var phase: String?
    public var attachments: LossyArray<ChatAttachment>?

    public var isFinalAnswer: Bool { phase == "final_answer" }

    public init(messageId: String, text: String, streaming: Bool, phase: String? = nil) {
      self.messageId = messageId
      self.text = text
      self.streaming = streaming
      self.phase = phase
    }
  }

  public struct Reasoning: Sendable, Hashable, Decodable {
    public var text: String
    public var streaming: Bool?
  }

  public struct ProposedPlan: Sendable, Hashable, Decodable {
    public var planId: String
    public var markdown: String
    public var streaming: Bool?
  }

  public struct TodoList: Sendable, Hashable, Decodable {
    public var planId: String
    public var steps: LossyArray<Step>
    public var explanation: String?

    public struct Step: Sendable, Hashable, Decodable {
      public var id: String
      public var text: String
      public var status: String
    }
  }

  public struct UserInputRequest: Sendable, Hashable, Decodable {
    public var requestId: String
    public var questions: LossyArray<UserInputQuestion>
    @Tolerant public var questionAnswer: JSONValue?
    public var responseMode: String?
  }

  public struct ApprovalRequest: Sendable, Hashable, Decodable {
    public var requestId: String
    public var requestKind: String
    public var prompt: String?
    public var reason: String?
    public var appName: String?
    public var options: LossyArray<ApprovalOption>?
  }

  public struct CommandExecution: Sendable, Hashable, Decodable {
    public var input: String
    /// Present only in a full item (`orchestration.getTurnItem`); the stream strips it.
    public var output: String?
    public var outputOmitted: Bool?
    public var outputIndicatesFailure: Bool?
    public var exitCode: Int?
    public var monitor: Bool?
  }

  public struct FileChange: Sendable, Hashable, Decodable {
    public var fileName: String
    public var additions: Int?
    public var deletions: Int?
    public var diffStr: String?
    public var changes: LossyArray<Change>?

    public struct Change: Sendable, Hashable, Decodable {
      public var operation: String
      public var path: String
      public var oldPath: String?
    }

    /// Every file this change touched, or `fileName` when the provider listed none.
    public var paths: [String] {
      let listed = changes?.elements.map(\.path) ?? []
      return listed.isEmpty ? [fileName] : listed
    }
  }

  public struct FileSearch: Sendable, Hashable, Decodable {
    public var pattern: String?
    public var results: LossyArray<Result>?

    public struct Result: Sendable, Hashable, Decodable {
      public var fileName: String
      public var line: Int?
      public var preview: String?
    }
  }

  public struct WebSearch: Sendable, Hashable, Decodable {
    public var patterns: [String]?
    public var results: LossyArray<Result>?

    public struct Result: Sendable, Hashable, Decodable {
      public var title: String?
      public var url: String?
      public var snippet: String?
    }
  }

  public struct DynamicTool: Sendable, Hashable, Decodable {
    public var toolName: String?
    public var viewedImagePath: String?
    public var input: JSONValue?
    public var output: JSONValue?
    public var outputOmitted: Bool?
  }

  public struct SubagentCall: Sendable, Hashable, Decodable {
    public var subagentId: String
    public var origin: String
    public var driver: String
    public var providerInstanceId: String?
    public var childThreadId: String?
    public var prompt: String
    public var progress: String?
    public var result: String?
  }

  public struct Checkpoint: Sendable, Hashable, Decodable {
    public var checkpointId: String
    public var files: LossyArray<File>

    public struct File: Sendable, Hashable, Decodable {
      public var path: String
      public var kind: String
      public var additions: Int
      public var deletions: Int
    }
  }

  public struct SystemNotice: Sendable, Hashable, Decodable {
    public var message: String
    public var level: String?
  }

  public struct ErrorNotice: Sendable, Hashable, Decodable {
    public var failure: ProviderFailure
    public var retry: Retry?

    public struct Retry: Sendable, Hashable, Decodable {
      public var attempt: Int
      public var maxAttempts: Int?
    }
  }

  public struct Compaction: Sendable, Hashable, Decodable {
    public var driver: String?
    public var beforeTokenCount: Int?
    public var afterTokenCount: Int?
  }

  public struct Handoff: Sendable, Hashable, Decodable {
    public var toProviderInstanceId: String
    public var toModel: String?
    public var strategy: String
  }

  public struct SecretRequest: Sendable, Hashable, Decodable {
    public var label: String
    public var reason: String
    public var secretStatus: String
  }

  public struct LinkRequest: Sendable, Hashable, Decodable {
    public var reason: String
    public var linkStatus: String
  }

  public struct Notification: Sendable, Hashable, Decodable {
    public var summary: String
    public var detail: String?
    public var outcome: String
    public var source: Source?

    public struct Source: Sendable, Hashable, Decodable {
      public var kind: String
      public var childThreadId: String?
    }
  }
}

/// `OrchestrationV2ProviderFailure`.
public struct ProviderFailure: Sendable, Hashable, Decodable {
  public var `class`: String
  public var message: String
  public var code: String?
  public var retryable: Bool?
  public var resetAt: WireTimestamp?

  public var isUsageLimit: Bool { `class` == "usage_limit" }
}

/// `OrchestrationV2UserInputQuestion`.
public struct UserInputQuestion: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var header: String
  public var question: String
  public var options: LossyArray<Option>
  public var multiSelect: Bool?
  public var allowCustomAnswer: Bool?

  public struct Option: Sendable, Hashable, Decodable {
    public var label: String
    public var description: String
  }
}

/// `ProviderApprovalOption`.
public struct ApprovalOption: Sendable, Hashable, Decodable {
  public var decision: String
  public var label: String
  public var warning: String?

  public init(decision: String, label: String, warning: String? = nil) {
    self.decision = decision
    self.label = label
    self.warning = warning
  }
}

/// `ChatAttachment`: image, file, or a type from a newer server (kept with its raw type).
public struct ChatAttachment: Sendable, Hashable, Decodable, Identifiable {
  public var type: String
  public var id: String
  public var name: String
  public var mimeType: String
  public var sizeBytes: Int

  public var isImage: Bool { type == "image" || mimeType.hasPrefix("image/") }

  public init(type: String, id: String, name: String, mimeType: String, sizeBytes: Int) {
    self.type = type
    self.id = id
    self.name = name
    self.mimeType = mimeType
    self.sizeBytes = sizeBytes
  }
}

extension LossyArray: Equatable where Element: Equatable {
  public static func == (lhs: Self, rhs: Self) -> Bool { lhs.elements == rhs.elements }
}

extension LossyArray: Hashable where Element: Hashable {
  public func hash(into hasher: inout Hasher) { hasher.combine(elements) }
}

// MARK: - Decoding

extension TurnItem: Decodable {
  enum CodingKeys: String, CodingKey {
    case id, threadId, runId, nodeId, providerTurnId, parentItemId, ordinal, status, title
    case startedAt, completedAt, updatedAt, type, deferredWork, toolSurface
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    threadId = try container.decode(String.self, forKey: .threadId)
    ordinal = try container.decode(Int.self, forKey: .ordinal)
    type = try container.decode(String.self, forKey: .type)
    updatedAt = try container.decode(WireTimestamp.self, forKey: .updatedAt)
    status = (try? container.decode(WireEnum<TurnItemStatus>.self, forKey: .status)) ?? .unknown("")
    runId = container.loose(String.self, .runId)
    nodeId = container.loose(String.self, .nodeId)
    providerTurnId = container.loose(String.self, .providerTurnId)
    parentItemId = container.loose(String.self, .parentItemId)
    title = container.loose(String.self, .title)
    startedAt = container.loose(WireTimestamp.self, .startedAt)
    completedAt = container.loose(WireTimestamp.self, .completedAt)
    deferredWork = container.loose(DeferredWork.self, .deferredWork)
    toolSurface = container.loose(String.self, .toolSurface)
    body = TurnItemBody.decode(type: type, from: decoder)
  }
}

extension TurnItemBody {
  private struct Message: Decodable { var message: String }
  private struct Fork: Decodable { var targetThreadId: String }
  private struct ThreadCreated: Decodable {
    var targetThreadId: String
    var targetModel: String?
  }

  /// Never throws: a body that does not match its type's schema is `.unknown`.
  static func decode(type: String, from decoder: any Decoder) -> TurnItemBody {
    func body<Body: Decodable>(_: Body.Type, _ wrap: (Body) -> TurnItemBody) -> TurnItemBody {
      (try? Body(from: decoder)).map(wrap) ?? .unknown(type: type)
    }
    switch type {
    case "user_message": return body(UserMessage.self, TurnItemBody.userMessage)
    case "assistant_message": return body(AssistantMessage.self, TurnItemBody.assistantMessage)
    case "reasoning": return body(Reasoning.self, TurnItemBody.reasoning)
    case "proposed_plan": return body(ProposedPlan.self, TurnItemBody.proposedPlan)
    case "todo_list": return body(TodoList.self, TurnItemBody.todoList)
    case "user_input_request": return body(UserInputRequest.self, TurnItemBody.userInputRequest)
    case "approval_request": return body(ApprovalRequest.self, TurnItemBody.approvalRequest)
    case "command_execution": return body(CommandExecution.self, TurnItemBody.commandExecution)
    case "file_change": return body(FileChange.self, TurnItemBody.fileChange)
    case "file_search": return body(FileSearch.self, TurnItemBody.fileSearch)
    case "web_search": return body(WebSearch.self, TurnItemBody.webSearch)
    case "dynamic_tool": return body(DynamicTool.self, TurnItemBody.dynamicTool)
    case "subagent": return body(SubagentCall.self, TurnItemBody.subagent)
    case "checkpoint": return body(Checkpoint.self, TurnItemBody.checkpoint)
    case "run_interrupt_request": return body(Message.self) { .runInterruptRequest(message: $0.message) }
    case "run_interrupt_result": return body(Message.self) { .runInterruptResult(message: $0.message) }
    case "system_notice": return body(SystemNotice.self, TurnItemBody.systemNotice)
    case "error": return body(ErrorNotice.self, TurnItemBody.error)
    case "compaction": return body(Compaction.self, TurnItemBody.compaction)
    case "handoff": return body(Handoff.self, TurnItemBody.handoff)
    case "fork": return body(Fork.self) { .fork(targetThreadId: $0.targetThreadId) }
    case "thread_created":
      return body(ThreadCreated.self) { .threadCreated(targetThreadId: $0.targetThreadId, targetModel: $0.targetModel) }
    case "secret_request": return body(SecretRequest.self, TurnItemBody.secretRequest)
    case "link_request": return body(LinkRequest.self, TurnItemBody.linkRequest)
    case "notification": return body(Notification.self, TurnItemBody.notification)
    default: return .unknown(type: type)
    }
  }
}

extension KeyedDecodingContainer {
  /// Absent, `null` and unreadable all mean nil (`Schema.optional` fields and forward
  /// compatibility in one).
  func loose<Value: Decodable>(_: Value.Type, _ key: Key) -> Value? {
    (try? decodeIfPresent(Value.self, forKey: key)) ?? nil
  }
}
