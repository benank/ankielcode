import Foundation

/// What the thread's runs say about sending (derived with the timeline, off the main actor).
public struct ThreadRunActivity: Sendable, Hashable {
  /// The run that owns the provider turn (`preparing|starting|running|waiting`).
  public var activeRunId: String?
  public var activeRunStatus: RunStatus?
  /// The user's queued messages, in queue order.
  public var queued: [QueuedMessage]
  /// A stop or restart is holding the queue.
  public var queueHeld: Bool

  public init(activeRunId: String? = nil, activeRunStatus: RunStatus? = nil, queued: [QueuedMessage] = [], queueHeld: Bool = false) {
    self.activeRunId = activeRunId
    self.activeRunStatus = activeRunStatus
    self.queued = queued
    self.queueHeld = queueHeld
  }

  public static let idle = ThreadRunActivity()

  public var isRunning: Bool { activeRunId != nil }

  /// The provider has not started its turn yet, so a follow-up queues (RN `setupRunning`).
  public var isSettingUp: Bool { activeRunStatus == .preparing || activeRunStatus == .starting }

  public struct QueuedMessage: Sendable, Hashable, Identifiable {
    public var runId: String
    public var messageId: String?
    public var text: String
    public var attachmentCount: Int
    public var id: String { runId }
  }

  /// RN `deriveThreadQueueWorkflowState` and `getUserQueuedThreadRuns`, without provider-session
  /// capabilities (this client does not hold provider sessions).
  public static func derive(_ projection: ThreadProjection) -> ThreadRunActivity {
    let active = projection.runs.last { run in
      switch run.status.known {
      case .preparing?, .starting?, .running?, .waiting?: true
      default: false
      }
    }
    let messages = Dictionary(projection.messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let queued = projection.runs.enumerated()
      .filter { $0.element.status == .queued && messages[$0.element.userMessageId ?? ""]?.isAutomatic != true }
      .sorted { lhs, rhs in
        let l = lhs.element.queuePosition ?? lhs.element.ordinal ?? lhs.offset
        let r = rhs.element.queuePosition ?? rhs.element.ordinal ?? rhs.offset
        return l != r ? l < r : lhs.offset < rhs.offset
      }
      .map { entry in
        let message = entry.element.userMessageId.flatMap { messages[$0] }
        return QueuedMessage(
          runId: entry.element.id, messageId: entry.element.userMessageId, text: message?.text ?? "",
          attachmentCount: message?.attachmentCount ?? 0)
      }
    return ThreadRunActivity(
      activeRunId: active?.id, activeRunStatus: active?.status.known, queued: queued,
      queueHeld: projection.runs.contains { $0.status == .queued && $0.queueHeld == true })
  }
}

/// The composer's trailing button (RN `resolveComposerSendPresentation`).
public enum ComposerPrimaryAction: Sendable, Hashable {
  /// Send now; disabled without content.
  case send(enabled: Bool)
  /// Into the running turn; `alternate` is the long-press choice.
  case steer
  case queue
  /// The field is empty while the agent works.
  case stop
  /// Saving an edit to a queued message.
  case update

  /// `followUp` is the user's default while the agent works; a turn still setting up always queues.
  public static func resolve(
    hasContent: Bool, activity: ThreadRunActivity, blocked: Bool = false, editingQueued: Bool = false,
    followUp: FollowUpBehavior = .steer
  ) -> ComposerPrimaryAction {
    if editingQueued { return .update }
    guard activity.isRunning else { return .send(enabled: hasContent && !blocked) }
    guard hasContent else { return .stop }
    return activity.isSettingUp || followUp == .queue ? .queue : .steer
  }

  /// The other choice offered beside the primary button while the agent works.
  public static func alternate(
    _ primary: ComposerPrimaryAction, activity: ThreadRunActivity
  ) -> ComposerPrimaryAction? {
    switch primary {
    case .steer: .queue
    case .queue where !activity.isSettingUp: .steer
    default: nil
    }
  }

  /// The delivery this action sends with.
  public var delivery: MessageDelivery {
    switch self {
    case .steer: .steer
    case .queue: .queue
    default: .start
    }
  }
}

extension ConversationMessage {
  /// Wakes from delegated work or notifications are not the user's queued messages.
  var isAutomatic: Bool { automatic == true }
}
