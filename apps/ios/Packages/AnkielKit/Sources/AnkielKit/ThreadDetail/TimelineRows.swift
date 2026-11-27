import Foundation

/// The thread's state for its header.
public enum ThreadDetailStatus: Sendable, Hashable {
  case idle
  case working
  /// A pending approval or question.
  case waiting
  case failed
  case stopped
}

public struct TimelineRow: Sendable, Hashable, Identifiable {
  public var id: String
  public var content: Content
  /// Hidden until this run fold opens.
  public var foldId: String?
  /// Hidden until this work group opens.
  public var groupId: String?

  public enum Content: Sendable, Hashable {
    case user(UserMessageRow)
    case assistant(AssistantMessageRow)
    case fold(RunFoldRow)
    case workGroup(WorkGroupRow)
    case work(WorkRow)
    case subagent(SubagentRow)
    case plan(PlanRow)
    case notice(NoticeRow)
    case answered(AnsweredRow)
    case working(WorkingRow)
  }
}

public struct UserMessageRow: Sendable, Hashable {
  public var messageId: String
  public var itemId: String
  public var text: String
  public var attachments: [ChatAttachment]
  public var isSteer: Bool
  /// Sent by another thread or the server, not typed here.
  public var fromAgent: Bool
  public var freshContext: Bool
  public var createdAt: WireTimestamp
  public var revision: Int
}

public struct AssistantMessageRow: Sendable, Hashable {
  public var messageId: String
  public var itemId: String
  public var text: String
  public var document: MarkdownDocument
  public var streaming: Bool
  public var attachments: [ChatAttachment]
  /// The settled turn's last reply shows copy and its time.
  public var footer: WireTimestamp?
  public var revision: Int
}

public struct RunFoldRow: Sendable, Hashable {
  public var foldId: String
  public var label: Label
  public var hiddenCount: Int

  public enum Label: Sendable, Hashable {
    /// "Worked for 2m 4s" (nil seconds: "Worked").
    case worked(seconds: Int?)
    /// The user stopped the turn.
    case stopped(seconds: Int?)
    case earlierWork
  }
}

public struct WorkGroupRow: Sendable, Hashable {
  public var groupId: String
  public var count: Int
  public var label: Display
  public var kind: WorkKind
  public var live: Bool
  public var hasFailure: Bool
}

/// A work row's one-line label: one call's own label or a group summary.
public enum Display: Sendable, Hashable {
  case activity(ActivityLabel)
  case summary(WorkSummary)
}

public struct WorkRow: Sendable, Hashable {
  public var activity: WorkActivity
  public var label: Display
  /// The call is running right now.
  public var live: Bool
  /// Shown inside an open group (indented, no own disclosure group).
  public var inGroup: Bool
}

public struct SubagentRow: Sendable, Hashable {
  public var itemId: String
  public var title: String?
  public var status: WireEnum<TurnItemStatus>
  public var childThreadId: String?
  public var preview: String?
  public var model: String?
}

public struct PlanRow: Sendable, Hashable {
  public var itemId: String
  public var document: MarkdownDocument
  public var streaming: Bool
}

public struct NoticeRow: Sendable, Hashable {
  public var itemId: String
  public var kind: WorkKind
  public var label: ActivityLabel
  public var detail: String?
  public var tone: Tone
  /// For a usage limit: when it resets.
  public var resetAt: WireTimestamp?

  public enum Tone: Sendable, Hashable {
    case quiet, warning, error
  }
}

public struct AnsweredRow: Sendable, Hashable {
  public var itemId: String
  public var pairs: [Pair]

  public struct Pair: Sendable, Hashable {
    public var question: String
    public var answer: String?
  }
}

public struct WorkingRow: Sendable, Hashable {
  public var runId: String?
  public var startedAt: WireTimestamp
  /// What the run is doing now; nil reads as "Thinking".
  public var activity: ActivityLabel?
  public var waitingOnSubagents: Int
}
