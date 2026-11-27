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
    _ source: ThreadProjection, markdown: MarkdownParser, cache: TimelineCache = TimelineCache()
  ) -> ThreadTimeline {
    defer { cache.commit() }
    let projection = withResolvedAnswers(source)
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

  /// RN `createQuestionHistoryProjector`: a question whose item has no answer yet shows the
  /// answers its resolved runtime request carries, so a live answer still leaves a resolved row.
  /// The overlaid copy gets a distinct revision so cached rows of the unanswered item are not reused.
  static func withResolvedAnswers(_ projection: ThreadProjection) -> ThreadProjection {
    let answered = projection.runtimeRequests.filter { $0.status == .resolved && $0.answers != nil }
    guard !answered.isEmpty else { return projection }
    let byId = Dictionary(answered.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    var result = projection
    for index in result.visibleTurnItems.indices {
      guard case .userInputRequest(var request) = result.visibleTurnItems[index].item.body, request.questionAnswer == nil,
        let runtime = byId[request.requestId], let answers = runtime.answers
      else { continue }
      request.questionAnswer = .object(["requestId": .string(request.requestId), "answers": answers])
      result.visibleTurnItems[index].item.body = .userInputRequest(request)
      result.visibleTurnItems[index].item.revision = -1 - result.visibleTurnItems[index].item.revision
    }
    return result
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
}
