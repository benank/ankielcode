import Foundation

/// The conversation as rows, derived from a projection off the main actor. A port of the RN feed
/// (`apps/mobile/src/lib/threadActivity.ts`: `buildThreadFeed`, `groupAdjacentActivities`,
/// `deriveThreadFeedRunFolds`, `appendActivityGroupRows`, `appendToolGroupRows`).
///
/// Rows are flat. A settled turn's work belongs to a run fold ("Worked for 2m"), and a work group's
/// calls belong to their group; both start collapsed, and `visibleRows(expanded:)` filters by
/// membership, so expanding is a cheap filter on the main actor instead of a re-derivation.
public struct ThreadTimeline: Sendable, Equatable {
  public var rows: [TimelineRow]
  public var status: ThreadDetailStatus
  /// The active run's start, for the working row's elapsed time.
  public var workingSince: Date?

  public init(rows: [TimelineRow] = [], status: ThreadDetailStatus = .idle, workingSince: Date? = nil) {
    self.rows = rows
    self.status = status
    self.workingSince = workingSince
  }

  public static let empty = ThreadTimeline()

  /// The rows to show given which folds and groups are open.
  public func visibleRows(expanded: Set<String>) -> [TimelineRow] {
    rows.filter { row in
      (row.foldId.map(expanded.contains) ?? true) && (row.groupId.map(expanded.contains) ?? true)
    }
  }
}

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
    case approval(ApprovalCard)
    case question(QuestionCard)
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

/// A pending approval, read-only until approvals are answered from the app (phase 7).
public struct ApprovalCard: Sendable, Hashable {
  public var requestId: String
  public var itemId: String
  public var requestKind: String
  public var prompt: String?
  public var reason: String?
  public var options: [ApprovalOption]
  public var capability: RuntimeRequest.ResponseCapability?
}

/// A pending question, read-only until answering ships (phase 7).
public struct QuestionCard: Sendable, Hashable {
  public var requestId: String
  public var itemId: String
  public var questions: [UserInputQuestion]
  public var capability: RuntimeRequest.ResponseCapability?
}

// MARK: - Building

/// Per-item results from the last build, keyed by `id@revision`, so a streamed update only derives
/// the item that changed. Entries not used by a build are dropped. Owned by one sync actor.
public final class TimelineCache {
  var activities: [String: WorkActivity] = [:]
  var documents: [String: MarkdownDocument] = [:]
  fileprivate var nextActivities: [String: WorkActivity] = [:]
  fileprivate var nextDocuments: [String: MarkdownDocument] = [:]

  public init() {}

  func activity(_ row: ProjectedTurnItem, attemptId: String?) -> WorkActivity {
    let key = "\(row.feedId)@\(row.item.revision)@\(attemptId ?? "")"
    let activity = activities[key] ?? WorkActivity(row: row, attemptId: attemptId)
    nextActivities[key] = activity
    return activity
  }

  func document(_ key: String, _ text: String, parser: MarkdownParser) -> MarkdownDocument {
    let document = documents[key] ?? parser.parse(text)
    nextDocuments[key] = document
    return document
  }

  fileprivate func commit() {
    activities = nextActivities
    documents = nextDocuments
    nextActivities = [:]
    nextDocuments = [:]
  }
}

public enum ThreadTimelineBuilder {
  /// RN's `ThreadFeedLatestRun`: the newest run that is not waiting in the queue.
  static func latestRun(_ projection: ThreadProjection) -> Run? {
    projection.runs.last { $0.status != .queued }
  }

  /// `threadFeedRunIsUnsettled`.
  static func isUnsettled(_ run: Run?) -> Bool {
    guard let run, run.status != .queued else { return false }
    return run.completedAt == nil || (run.status.known?.isActive ?? false)
  }

  public static func build(
    _ projection: ThreadProjection, markdown: MarkdownParser, cache: TimelineCache = TimelineCache()
  ) -> ThreadTimeline {
    defer { cache.commit() }
    let latest = latestRun(projection)
    let activeRun = isUnsettled(latest) ? latest : nil
    let isWorking = activeRun != nil && activeRun?.status != .preparing
    let activeRunId = activeRun?.id
    let workingSince = activeRun.flatMap { $0.workStartedAt ?? $0.startedAt ?? $0.requestedAt }

    let entries = groupAdjacent(rawEntries(projection, cache: cache))
    let failedRuns = failedRunIds(entries, latest: latest)
    let folds = runFolds(entries, latest: latest, activeRunId: activeRunId, failedRuns: failedRuns)
    let subagents = Dictionary(projection.subagents.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let terminal = terminalAssistantIds(entries)

    var rows: [TimelineRow] = []
    rows.reserveCapacity(entries.count + 8)
    for (index, entry) in entries.enumerated() {
      if let fold = folds.anchors[entry.id] {
        rows.append(TimelineRow(id: "run-fold:\(fold.foldId)", content: .fold(fold), foldId: nil))
      }
      let foldId = folds.membership[entry.id]
      switch entry {
      case .message(let message):
        rows.append(contentsOf: messageRows(
          message, foldId: foldId, markdown: { cache.document("\($0)@\(message.row.item.revision)", $1, parser: markdown) },
          footer: terminal.contains(message.id) && message.runId != activeRunId && !message.streaming
            && !(message.runId.map(failedRuns.contains) ?? false)))
      case .group(let group):
        let isActiveTail = isWorking && index == entries.count - 1 && group.runId == activeRunId
        rows.append(contentsOf: groupRows(
          group, foldId: foldId, failed: group.runId.map(failedRuns.contains) ?? false, isWorking: isWorking,
          activeRunId: activeRunId, activeTail: isActiveTail, subagents: subagents,
          markdown: { key, text in cache.document(key, text, parser: markdown) }))
      }
    }

    let replyStreaming: Bool =
      if case .assistant(let reply)? = rows.last?.content { reply.streaming } else { false }
    if isWorking, let start = workingSince, !replyStreaming {
      let current = entries.reversed().lazy.compactMap { entry -> WorkActivity? in
        guard case .group(let group) = entry, group.runId == activeRunId else { return nil }
        return group.activities.last { $0.lifecycle == .inProgress }
      }.first
      rows.append(TimelineRow(
        id: "working", content: .working(WorkingRow(
          runId: activeRunId, startedAt: start, activity: current.map(WorkActivity.liveLabel),
          waitingOnSubagents: runningSubagentsAtTail(entries, runId: activeRunId)))))
    }
    rows.append(contentsOf: pendingCards(projection))

    let status: ThreadDetailStatus =
      if projection.runtimeRequests.contains(where: { $0.status == .pending }) || activeRun?.status == .waiting {
        .waiting
      } else if isWorking {
        .working
      } else if latest?.status == .failed {
        .failed
      } else if latest?.status == .interrupted || latest?.status == .cancelled {
        .stopped
      } else {
        .idle
      }
    return ThreadTimeline(rows: rows, status: status, workingSince: workingSince?.date)
  }

  // MARK: Raw entries (`buildThreadFeed`)

  struct MessageEntry {
    var id: String
    var row: ProjectedTurnItem
    var role: Role
    var runId: String?
    var text: String
    var attachments: [ChatAttachment]
    var streaming: Bool
    var isFinalAnswer: Bool
    var isSteer: Bool
    var createdAt: WireTimestamp
    var updatedAt: WireTimestamp

    enum Role { case user, assistant }

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty }
  }

  struct ActivityEntry {
    var activity: WorkActivity
    var item: TurnItem
  }

  enum RawEntry {
    case message(MessageEntry)
    case activity(ActivityEntry)
  }

  struct GroupEntry {
    var id: String
    var runId: String?
    var createdAt: WireTimestamp
    var members: [ActivityEntry]
    var activities: [WorkActivity] { members.map(\.activity) }
  }

  enum Entry {
    case message(MessageEntry)
    case group(GroupEntry)

    var id: String {
      switch self {
      case .message(let message): message.id
      case .group(let group): group.id
      }
    }

    var runId: String? {
      switch self {
      case .message(let message): message.runId
      case .group(let group): group.runId
      }
    }

    var createdAt: WireTimestamp {
      switch self {
      case .message(let message): message.createdAt
      case .group(let group): group.createdAt
      }
    }

    var endedAt: WireTimestamp {
      switch self {
      case .message(let message): message.updatedAt
      case .group(let group): group.createdAt
      }
    }

    var isUserMessage: Bool {
      if case .message(let message) = self { message.role == .user } else { false }
    }
  }

  static func isWorkspacePreparation(_ item: TurnItem) -> Bool {
    switch item.body {
    case .commandExecution(let command): command.input == "Preparing workspace"
    case .error(let error): item.status == .cancelled && error.failure.code == "workspace_preparation_failed"
    default: false
    }
  }

  static func rawEntries(_ projection: ThreadProjection, cache: TimelineCache) -> [RawEntry] {
    var foldedAnswers: [String: String?] = [:]
    for row in projection.visibleTurnItems {
      if case .userInputRequest(let request) = row.item.body, let requestId = request.questionAnswer?["requestId"]?.stringValue {
        foldedAnswers["async-answer:\(requestId)"] = row.item.runId
      }
    }
    let resolveAttempt = attemptResolver(projection)
    var entries: [RawEntry] = []
    entries.reserveCapacity(projection.visibleTurnItems.count)
    for row in projection.visibleTurnItems {
      let item = row.item
      if isWorkspacePreparation(item), item.deferredWork == nil { continue }
      switch item.body {
      case .todoList, .checkpoint, .linkRequest, .runInterruptRequest:
        continue
      case .userMessage(let message):
        if message.inputIntent == .queuedTurn, item.status == .pending { continue }
        if let runId = foldedAnswers[message.messageId], runId == item.runId { continue }
        entries.append(.message(MessageEntry(
          id: message.messageId, row: row, role: .user, runId: item.runId, text: message.text,
          attachments: message.attachments.elements, streaming: false, isFinalAnswer: false, isSteer: message.isSteer,
          createdAt: item.displayStart, updatedAt: item.updatedAt)))
      case .assistantMessage(let message):
        entries.append(.message(MessageEntry(
          id: message.messageId, row: row, role: .assistant, runId: item.runId, text: message.text,
          attachments: message.attachments?.elements ?? [], streaming: message.streaming,
          isFinalAnswer: message.isFinalAnswer, isSteer: false, createdAt: item.displayStart,
          updatedAt: item.updatedAt)))
      default:
        entries.append(.activity(ActivityEntry(activity: cache.activity(row, attemptId: resolveAttempt(item)), item: item)))
      }
    }
    return entries
  }

  /// The attempt an item belongs to: walk its node's parents to an attempt's root node in the
  /// same run (`resolveAttemptId`).
  static func attemptResolver(_ projection: ThreadProjection) -> (TurnItem) -> String? {
    let attemptsByRoot = Dictionary(projection.attempts.map { ($0.rootNodeId, $0) }, uniquingKeysWith: { _, last in last })
    let nodes = Dictionary(projection.nodes.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    return { item in
      guard var nodeId = item.nodeId, let runId = item.runId else { return nil }
      var visited = Set<String>()
      while visited.insert(nodeId).inserted {
        if let attempt = attemptsByRoot[nodeId], attempt.runId == runId { return attempt.id }
        guard let node = nodes[nodeId] else { return nil }
        if let attempt = attemptsByRoot[node.rootNodeId], attempt.runId == runId { return attempt.id }
        guard let parent = node.parentNodeId else { return nil }
        nodeId = parent
      }
      return nil
    }
  }

  // MARK: Grouping (`groupAdjacentActivities`)

  static func isStandalone(_ entry: ActivityEntry) -> Bool {
    switch entry.item.body {
    case .compaction, .handoff, .notification: true
    case .userInputRequest(let request): request.questionAnswer != nil
    default: false
    }
  }

  static func groupAdjacent(_ raw: [RawEntry]) -> [Entry] {
    var grouped: [Entry] = []
    var open: GroupEntry?
    func flush() {
      if let group = open { grouped.append(.group(group)) }
      open = nil
    }
    for entry in raw {
      switch entry {
      case .message(let message):
        if message.isEmpty { continue }
        flush()
        grouped.append(.message(message))
      case .activity(let activity):
        let standalone = isStandalone(activity) || activity.activity.prominent
        if let current = open, let first = current.members.first {
          let isSubagent = activity.item.type == "subagent"
          let breaks =
            standalone || isSubagent != (first.item.type == "subagent") || first.item.runId != activity.item.runId
            || (isSubagent && first.item.providerTurnId != activity.item.providerTurnId)
            || (!isSubagent && first.activity.attemptId != activity.activity.attemptId)
          if breaks { flush() }
        }
        if open == nil {
          open = GroupEntry(id: activity.activity.id, runId: activity.item.runId, createdAt: activity.activity.startedAt, members: [])
        }
        open?.members.append(activity)
        if standalone { flush() }
      }
    }
    flush()
    return grouped
  }

  // MARK: Run folds (`deriveThreadFeedRunFolds`)

  struct Folds {
    var anchors: [String: RunFoldRow] = [:]
    var membership: [String: String] = [:]
  }

  static func failedRunIds(_ entries: [Entry], latest: Run?) -> Set<String> {
    var failed = Set<String>()
    if let latest, latest.status == .failed { failed.insert(latest.id) }
    for case .group(let group) in entries {
      for member in group.members {
        if case .error = member.item.body, member.item.status == .failed, member.item.parentItemId == nil,
          let runId = member.item.runId
        {
          failed.insert(runId)
        }
      }
    }
    return failed
  }

  static func isLiveSubagent(_ item: TurnItem) -> Bool {
    guard item.type == "subagent" else { return false }
    return item.lifecycle == .inProgress
  }

  /// `staysOutOfFold`: notices, plans, answers and live subagents stay visible in a settled turn.
  static func staysOutOfFold(_ entry: Entry) -> Bool {
    guard case .group(let group) = entry else { return false }
    return group.members.contains { member in
      if member.activity.prominent || isLiveSubagent(member.item) { return true }
      switch member.item.body {
      case .notification, .handoff: return true
      case .userInputRequest(let request): return request.questionAnswer != nil
      default: return false
      }
    }
  }

  static func isCompaction(_ entry: Entry) -> Bool {
    guard case .group(let group) = entry else { return false }
    return group.members.first?.item.type == "compaction"
  }

  static func runFolds(_ entries: [Entry], latest: Run?, activeRunId: String?, failedRuns: Set<String>) -> Folds {
    var promptIndex: [String: Int] = [:]
    for (index, entry) in entries.enumerated() {
      guard case .message(let message) = entry, message.role == .user, !message.isSteer, let runId = message.runId else {
        continue
      }
      if promptIndex[runId] == nil { promptIndex[runId] = index }
    }
    struct RunGroup {
      var entries: [Entry] = []
      var startBoundary: WireTimestamp?
    }
    var groups: [String: RunGroup] = [:]
    var order: [String] = []
    var terminalAssistant: [String: String] = [:]
    var interrupted = Set<String>()
    var failed = failedRuns
    var runlessKey: String?
    var responseKey: String?
    var pendingBoundary: WireTimestamp?
    for (index, entry) in entries.enumerated() {
      if case .message(let message) = entry, message.role == .user {
        pendingBoundary = message.createdAt
        runlessKey = message.runId == nil ? "runless:\(message.id)" : nil
        responseKey = message.runId ?? runlessKey
        continue
      }
      guard let own = entry.runId ?? runlessKey else { continue }
      let runId = (responseKey != nil && (promptIndex[own] ?? -1) > index) ? responseKey! : own
      if groups[runId] == nil {
        groups[runId] = RunGroup(startBoundary: pendingBoundary)
        pendingBoundary = nil
        order.append(runId)
      }
      groups[runId]?.entries.append(entry)
      switch entry {
      case .message(let message):
        terminalAssistant[runId] = message.id
      case .group(let group):
        for member in group.members {
          if member.item.type == "run_interrupt_result" { interrupted.insert(runId) }
          if runId == runlessKey, case .error = member.item.body, member.item.status == .failed, member.item.parentItemId == nil {
            failed.insert(runId)
          }
        }
      }
    }
    let finalAnswers = Set(entries.compactMap { entry -> String? in
      if case .message(let message) = entry, message.role == .assistant, message.isFinalAnswer { message.id } else { nil }
    })
    var folds = Folds()
    for runId in order {
      guard let group = groups[runId], runId != activeRunId, !interrupted.contains(runId), !failed.contains(runId) else {
        continue
      }
      if group.entries.contains(where: { if case .message(let message) = $0 { message.streaming } else { false } }) {
        continue
      }
      let terminalId = terminalAssistant[runId]
      let visibleCompaction = group.entries.last(where: isCompaction)?.id
      let hidden = group.entries.filter { entry in
        entry.id != terminalId && !finalAnswers.contains(entry.id) && entry.id != visibleCompaction && !staysOutOfFold(entry)
      }
      guard hidden.contains(where: { !isCompaction($0) }), let first = group.entries.first,
        let last = group.entries.last, let anchor = hidden.first
      else { continue }
      let seconds: Int?
      if latest?.id == runId, let start = latest?.startedAt?.date, let end = latest?.completedAt?.date {
        seconds = max(0, Int(end.timeIntervalSince(start).rounded()))
      } else if let start = (group.startBoundary ?? first.createdAt).date {
        let terminalEnd = group.entries.first { $0.id == terminalId }?.endedAt
        let ends = [terminalEnd, last.endedAt].compactMap { $0?.date }
        seconds = ends.max().map { max(0, Int($0.timeIntervalSince(start).rounded())) }
      } else {
        seconds = nil
      }
      let stopped = latest?.id == runId && (latest?.status == .interrupted || latest?.status == .cancelled)
      let foldId = runId
      folds.anchors[anchor.id] = RunFoldRow(
        foldId: foldId, label: stopped ? .stopped(seconds: seconds) : .worked(seconds: seconds), hiddenCount: hidden.count)
      for entry in hidden { folds.membership[entry.id] = foldId }
    }
    return folds
  }

  static func terminalAssistantIds(_ entries: [Entry]) -> Set<String> {
    var lastByRun: [String: String] = [:]
    for case .message(let message) in entries where message.role == .assistant {
      lastByRun[message.runId ?? "runless"] = message.id
    }
    return Set(lastByRun.values)
  }

  static func runningSubagentsAtTail(_ entries: [Entry], runId: String?) -> Int {
    guard let runId else { return 0 }
    var running = 0
    for entry in entries.reversed() {
      if case .message(let message) = entry, message.role == .assistant, !message.streaming, message.runId == runId {
        continue
      }
      guard case .group(let group) = entry, group.runId == runId else { break }
      if group.members.contains(where: { $0.item.type != "subagent" }) { break }
      running += group.members.filter { isLiveSubagent($0.item) }.count
    }
    return running
  }

  // MARK: Rows

  static func messageRows(_ message: MessageEntry, foldId: String?, markdown: (String, String) -> MarkdownDocument, footer: Bool) -> [TimelineRow] {
    switch message.role {
    case .user:
      var fromAgent = false
      var freshContext = false
      if case .userMessage(let body) = message.row.item.body {
        fromAgent = body.createdBy == "agent" || body.senderThreadId != nil
        freshContext = body.freshContext == true
      }
      return [TimelineRow(
        id: message.id, content: .user(UserMessageRow(
          messageId: message.id, itemId: message.row.item.id, text: message.text, attachments: message.attachments,
          isSteer: message.isSteer, fromAgent: fromAgent, freshContext: freshContext, createdAt: message.createdAt,
          revision: message.row.item.revision)), foldId: foldId)]
    case .assistant:
      return [TimelineRow(
        id: message.id, content: .assistant(AssistantMessageRow(
          messageId: message.id, itemId: message.row.item.id, text: message.text, document: markdown(message.id, message.text),
          streaming: message.streaming, attachments: message.attachments, footer: footer ? message.updatedAt : nil,
          revision: message.row.item.revision)), foldId: foldId)]
    }
  }

  static func groupRows(
    _ group: GroupEntry, foldId: String?, failed: Bool, isWorking: Bool, activeRunId: String?, activeTail: Bool,
    subagents: [String: Subagent], markdown: (String, String) -> MarkdownDocument
  ) -> [TimelineRow] {
    guard let first = group.members.first else { return [] }
    switch first.item.body {
    case .compaction, .handoff, .notification:
      return [noticeRow(first, foldId: foldId)]
    case .userInputRequest(let request) where request.questionAnswer != nil:
      return [answeredRow(first, request: request, foldId: foldId)]
    case .subagent:
      return group.members.map { subagentRow($0, subagents: subagents, foldId: foldId) }
    default:
      break
    }
    if failed {
      // A failed turn keeps every call on its own row, so the failure reads in place.
      return group.members.flatMap { member in
        member.activity.prominent || isSevereError(member.item)
          ? [prominentRow(member, foldId: foldId, markdown: markdown)]
          : [TimelineRow(
            id: member.activity.id, content: .work(WorkRow(
              activity: member.activity, label: .activity(member.activity.label), live: false,
              inGroup: false)), foldId: foldId)]
      }
    }
    return activityGroupRows(
      group, foldId: foldId, isWorking: isWorking, activeRunId: activeRunId, activeTail: activeTail, markdown: markdown)
  }

  static func isSevereError(_ item: TurnItem) -> Bool {
    if case .error = item.body { item.status == .failed } else { false }
  }

  /// `appendActivityGroupRows`: prominent items get their own rows; runs of ordinary calls become
  /// a work group (or one lone row).
  static func activityGroupRows(
    _ group: GroupEntry, foldId: String?, isWorking: Bool, activeRunId: String?, activeTail: Bool,
    markdown: (String, String) -> MarkdownDocument
  ) -> [TimelineRow] {
    var anchors: [String: String] = [:]
    var anchor: String?
    for member in group.members {
      if member.activity.prominent || isSevereError(member.item) {
        anchor = nil
        continue
      }
      if anchor == nil { anchor = member.activity.id }
      anchors[member.activity.id] = anchor
    }
    let visible = group.members.filter { member in
      member.activity.isSettledVisible
        || (isWorking && member.activity.lifecycle == .inProgress && member.activity.runId == activeRunId)
    }
    var rows: [TimelineRow] = []
    var buffer: [ActivityEntry] = []
    func flush(trailing: Bool) {
      guard let head = buffer.first else { return }
      let groupId = "work-group:\(anchors[head.activity.id] ?? head.activity.id)"
      rows.append(contentsOf: toolGroupRows(
        buffer.map(\.activity), groupId: groupId, foldId: foldId, isWorking: isWorking, activeRunId: activeRunId,
        activeTail: activeTail && trailing))
      buffer = []
    }
    for member in visible {
      if !member.activity.prominent, !isSevereError(member.item), member.item.type != "notification" {
        buffer.append(member)
        continue
      }
      flush(trailing: false)
      rows.append(prominentRow(member, foldId: foldId, markdown: markdown))
    }
    flush(trailing: true)
    return rows
  }

  /// `appendToolGroupRows`.
  static func toolGroupRows(
    _ activities: [WorkActivity], groupId: String, foldId: String?, isWorking: Bool, activeRunId: String?, activeTail: Bool
  ) -> [TimelineRow] {
    guard let last = activities.last else { return [] }
    let latestActive = activities.last { isWorking && $0.lifecycle == .inProgress && $0.runId == activeRunId }
    let live = activeTail || latestActive != nil
    let latest = latestActive ?? last
    if activities.count == 1, !latest.isReasoning {
      let label: Display =
        if live {
          .activity(WorkActivity.liveLabel(latest))
        } else if latest.toolLike, latest.action == .edit {
          .summary(WorkSummary([latest]))
        } else {
          .activity(latest.label)
        }
      return [TimelineRow(
        id: latest.id, content: .work(WorkRow(activity: latest, label: label, live: latestActive != nil, inGroup: false)),
        foldId: foldId)]
    }
    let summary = WorkSummary(activities)
    let label: Display =
      if live {
        .activity(WorkActivity.liveLabel(latest))
      } else if activities.count == 1 {
        .activity(.thought(nil, live: false))
      } else {
        .summary(summary)
      }
    let lastToolLike = activities.last { $0.toolLike }
    var rows = [TimelineRow(
      id: "work-toggle:\(groupId)", content: .workGroup(WorkGroupRow(
        groupId: groupId, count: activities.count, label: label, kind: groupKind(activities, live: live, latest: latest),
        live: live, hasFailure: lastToolLike?.outcome == .failure)), foldId: foldId)]
    for activity in activities {
      rows.append(TimelineRow(
        id: "work-detail:\(activity.id)", content: .work(WorkRow(
          activity: activity, label: .activity(activity.label),
          live: isWorking && activity.id == latest.id && activity.lifecycle == .inProgress && activity.runId == activeRunId,
          inGroup: true)), foldId: foldId, groupId: groupId))
    }
    return rows
  }

  /// The group's icon: its one action's kind, else a generic tool mark (`toolGroupSummaryKind`).
  static func groupKind(_ activities: [WorkActivity], live: Bool, latest: WorkActivity) -> WorkKind {
    if live { return latest.kind }
    let tools = activities.filter { !$0.isReasoning }
    if tools.isEmpty { return .thinking }
    let kinds = Set(tools.map(\.kind))
    return kinds.count == 1 ? kinds.first! : .tool
  }

  static func prominentRow(
    _ member: ActivityEntry, foldId: String?, markdown: (String, String) -> MarkdownDocument
  ) -> TimelineRow {
    if case .proposedPlan(let plan) = member.item.body {
      return TimelineRow(
        id: member.activity.id, content: .plan(PlanRow(
          itemId: member.item.id, document: markdown("\(member.item.id)@\(member.item.revision)", plan.markdown),
          streaming: plan.streaming == true)),
        foldId: foldId)
    }
    return noticeRow(member, foldId: foldId)
  }

  static func noticeRow(_ member: ActivityEntry, foldId: String?) -> TimelineRow {
    let item = member.item
    var tone = NoticeRow.Tone.quiet
    var detail: String?
    var resetAt: WireTimestamp?
    switch item.body {
    case .error(let error):
      tone = error.failure.isUsageLimit ? .warning : .error
      detail = error.failure.message.nilIfEmpty
      resetAt = error.failure.resetAt
    case .systemNotice(let notice):
      tone = notice.level == "error" ? .error : notice.level == "warning" ? .warning : .quiet
    case .notification(let notification):
      detail = notification.detail?.nilIfEmpty
      tone = notification.outcome == "failed" ? .warning : .quiet
    case .secretRequest(let request):
      detail = request.reason.nilIfEmpty
    default:
      break
    }
    return TimelineRow(
      id: member.activity.id, content: .notice(NoticeRow(
        itemId: item.id, kind: member.activity.kind, label: member.activity.label, detail: detail, tone: tone,
        resetAt: resetAt)), foldId: foldId)
  }

  static func answeredRow(_ member: ActivityEntry, request: TurnItemBody.UserInputRequest, foldId: String?) -> TimelineRow {
    let answers = request.questionAnswer?["answers"]
    let pairs = request.questions.elements.map { question in
      let value = answers?[question.id]
      let answer: String? =
        switch value {
        case .string(let text)?: text
        case .array(let values)?: values.compactMap(\.stringValue).joined(separator: ", ").nilIfEmpty
        case .object(let object)?: object["answers"].flatMap { value in
          if case .array(let values) = value { values.compactMap(\.stringValue).joined(separator: ", ") } else { nil }
        }
        default: nil
        }
      return AnsweredRow.Pair(question: question.question, answer: answer)
    }
    return TimelineRow(id: member.activity.id, content: .answered(AnsweredRow(itemId: member.item.id, pairs: pairs)), foldId: foldId)
  }

  static func subagentRow(_ member: ActivityEntry, subagents: [String: Subagent], foldId: String?) -> TimelineRow {
    guard case .subagent(let call) = member.item.body else { return noticeRow(member, foldId: foldId) }
    let record = subagents[call.subagentId]
    let preview = (record?.result ?? call.result ?? record?.progress ?? call.progress ?? call.prompt)
      .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    return TimelineRow(
      id: member.activity.id, content: .subagent(SubagentRow(
        itemId: member.item.id, title: record?.title ?? member.item.title, status: member.item.status,
        childThreadId: call.childThreadId ?? record?.childThreadId, preview: preview.map { String($0.prefix(400)) },
        model: record?.model)), foldId: foldId)
  }

  /// Pending approvals and questions, in timeline order, as cards at the tail.
  static func pendingCards(_ projection: ThreadProjection) -> [TimelineRow] {
    let pending = Dictionary(
      projection.runtimeRequests.filter { $0.status == .pending }.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    guard !pending.isEmpty else { return [] }
    var cards: [TimelineRow] = []
    var seen = Set<String>()
    for row in projection.visibleTurnItems {
      switch row.item.body {
      case .approvalRequest(let request):
        guard let runtime = pending[request.requestId], seen.insert(request.requestId).inserted else { continue }
        cards.append(TimelineRow(
          id: "pending:\(request.requestId)", content: .approval(ApprovalCard(
            requestId: request.requestId, itemId: row.item.id, requestKind: request.requestKind, prompt: request.prompt,
            reason: request.reason, options: request.options?.elements ?? [], capability: runtime.responseCapability))))
      case .userInputRequest(let request) where request.questionAnswer == nil:
        guard let runtime = pending[request.requestId], seen.insert(request.requestId).inserted else { continue }
        cards.append(TimelineRow(
          id: "pending:\(request.requestId)", content: .question(QuestionCard(
            requestId: request.requestId, itemId: row.item.id, questions: request.questions.elements,
            capability: runtime.responseCapability))))
      default:
        continue
      }
    }
    return cards
  }
}
