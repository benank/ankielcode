import Foundation

/// How a message joins the thread (RN `ComposerDispatchMode` as the mobile outbox sends it).
public enum MessageDelivery: String, Sendable, Hashable, Codable {
  /// The thread is idle: `start_immediately` and no `deliveryIntent` (RN's `"start"` path). A
  /// thread that turned busy meanwhile queues it server side.
  case start
  /// After the active turn: `queue_after_active`.
  case queue
  /// Into the active turn: `start_immediately` with `deliveryIntent: "steer"` (the server queues
  /// it when the provider cannot steer).
  case steer
  /// Restart the active turn with the message.
  case restart
}

extension ChatAttachment: Encodable {
  enum WireKeys: String, CodingKey { case type, id, name, mimeType, sizeBytes }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: WireKeys.self)
    try c.encode(type, forKey: .type)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(mimeType, forKey: .mimeType)
    try c.encode(sizeBytes, forKey: .sizeBytes)
  }
}

/// `message.dispatch` (spec §7.4), filled the way RN `startThreadTurn` fills it for the phone.
public struct MessageDispatch: Sendable, Hashable, Encodable {
  public var commandId: CommandID
  public var threadId: String
  public var messageId: String
  public var text: String
  public var attachments: [ChatAttachment]
  public var modelSelection: ModelSelection?
  public var titleSeed: String?
  public var delivery: MessageDelivery
  /// `/clear`: a new provider session without the thread's earlier context.
  public var freshContext = false

  public init(
    commandId: CommandID, threadId: String, messageId: String, text: String, attachments: [ChatAttachment] = [],
    modelSelection: ModelSelection? = nil, titleSeed: String? = nil, delivery: MessageDelivery = .start, freshContext: Bool = false
  ) {
    self.freshContext = freshContext
    self.commandId = commandId
    self.threadId = threadId
    self.messageId = messageId
    self.text = text
    self.attachments = attachments
    self.modelSelection = modelSelection
    self.titleSeed = titleSeed
    self.delivery = delivery
  }

  enum CodingKeys: String, CodingKey {
    case type, commandId, createdBy, creationSource, threadId, messageId, text, attachments, titleSeed
    case modelSelection, deliveryIntent, dispatchMode, freshContext
  }

  struct DispatchMode: Encodable { var type: String }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("message.dispatch", forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode("user", forKey: .createdBy)
    try c.encode("mobile", forKey: .creationSource)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(messageId, forKey: .messageId)
    try c.encode(text, forKey: .text)
    try c.encode(attachments, forKey: .attachments)
    // RN's "start" branch leaves the title seed out; the other branches send it.
    if delivery != .start { try c.encodeIfPresent(titleSeed, forKey: .titleSeed) }
    try c.encodeIfPresent(modelSelection, forKey: .modelSelection)
    if freshContext { try c.encode(true, forKey: .freshContext) }
    switch delivery {
    case .start:
      try c.encode(DispatchMode(type: "start_immediately"), forKey: .dispatchMode)
    case .queue:
      try c.encode(DispatchMode(type: "queue_after_active"), forKey: .dispatchMode)
    case .steer, .restart:
      try c.encode(delivery.rawValue, forKey: .deliveryIntent)
      try c.encode(DispatchMode(type: "start_immediately"), forKey: .dispatchMode)
    }
  }
}

/// `orchestration.launchThread` (spec §7.3): a new thread and its first message in one commit.
public struct ThreadLaunch: Sendable, Hashable, Encodable {
  public static let rpcTag = "orchestration.launchThread"

  public var commandId: CommandID
  public var threadId: String
  public var projectId: String
  public var title: String
  public var modelSelection: ModelSelection
  public var runtimeMode: RuntimeMode
  public var interactionMode: InteractionMode
  public var messageId: String
  public var text: String
  public var attachments: [ChatAttachment]

  public init(
    commandId: CommandID, threadId: String, projectId: String, title: String, modelSelection: ModelSelection,
    runtimeMode: RuntimeMode, interactionMode: InteractionMode = .default, messageId: String, text: String,
    attachments: [ChatAttachment] = []
  ) {
    self.commandId = commandId
    self.threadId = threadId
    self.projectId = projectId
    self.title = title
    self.modelSelection = modelSelection
    self.runtimeMode = runtimeMode
    self.interactionMode = interactionMode
    self.messageId = messageId
    self.text = text
    self.attachments = attachments
  }

  enum CodingKeys: String, CodingKey {
    case commandId, creationSource, threadId, projectId, title, generateTitle, modelSelection, runtimeMode
    case interactionMode, workspaceStrategy, initialMessage
  }

  struct Strategy: Encodable { var type = "root" }

  struct InitialMessage: Encodable {
    var messageId: String
    var text: String
    var attachments: [ChatAttachment]
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(commandId, forKey: .commandId)
    try c.encode("mobile", forKey: .creationSource)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(projectId, forKey: .projectId)
    try c.encode(title, forKey: .title)
    try c.encode(true, forKey: .generateTitle)
    try c.encode(modelSelection, forKey: .modelSelection)
    try c.encode(runtimeMode.rawValue, forKey: .runtimeMode)
    try c.encode(interactionMode.rawValue, forKey: .interactionMode)
    try c.encode(Strategy(), forKey: .workspaceStrategy)
    try c.encode(InitialMessage(messageId: messageId, text: text, attachments: attachments), forKey: .initialMessage)
  }
}

/// `OrchestrationV2ThreadLaunchResult`; the projection is kept so the new thread renders at once.
public struct ThreadLaunchResult: Sendable, Decodable {
  public var threadId: String
  public var sequence: Int?
  public var projection: ThreadProjection?

  enum CodingKeys: String, CodingKey { case threadId, sequence, projection }

  public init(threadId: String, sequence: Int?, projection: ThreadProjection? = nil) {
    self.threadId = threadId
    self.sequence = sequence
    self.projection = projection
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    sequence = c.loose(Int.self, .sequence)
    projection = c.loose(ThreadProjection.self, .projection)
  }
}

/// `projects.ensureScratch {}` → `{projectId}`: the folder for threads without a project.
public struct EnsureScratchRequest: Sendable, Encodable {
  public static let rpcTag = "projects.ensureScratch"
  public init() {}
}

public struct EnsureScratchResult: Sendable, Decodable {
  public var projectId: String
}

/// The title seed RN derives from a message (`deriveThreadTitleSeed`, 50 characters then "...").
/// Copy comes from the app, which localizes it.
public enum ThreadTitleSeed {
  public struct Labels: Sendable {
    public var attachedImage = "Attached image"
    public var attachedImages = "Attached images"
    public var file: @Sendable (String) -> String = { "File: \($0)" }
    public var newThread = "New thread"
    public init() {}
  }

  public static func make(text: String, attachments: [ChatAttachment], labels: Labels = Labels()) -> String {
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacing(/\s+/, with: " ").precomposedStringWithCanonicalMapping
    if !normalized.isEmpty { return truncate(normalized) }
    let images = attachments.filter { $0.type == "image" }.count
    if images > 0 { return images == 1 ? labels.attachedImage : labels.attachedImages }
    if let name = attachments.first?.name.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
      return truncate(labels.file(name))
    }
    return labels.newThread
  }

  static func truncate(_ text: String, max: Int = 50) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > max else { return trimmed }
    return String(trimmed.prefix(max)) + "..."
  }
}
