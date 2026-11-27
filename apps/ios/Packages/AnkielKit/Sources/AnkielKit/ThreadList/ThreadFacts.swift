import Foundation

/// A thread in one environment. Thread ids are unique only within an environment.
public struct ThreadRef: Sendable, Hashable, Codable {
  public var environmentId: String
  public var threadId: String

  public init(environmentId: String, threadId: String) {
    self.environmentId = environmentId
    self.threadId = threadId
  }

  /// `environmentId:threadId`, the key every list structure uses.
  public var key: String { "\(environmentId):\(threadId)" }
}

/// What a subagent or side chat below a thread is asking for, rolled up to that thread.
public enum SubagentRequest: Sendable, Hashable {
  case approval
  case userInput
}

/// The list-facing reading of one shell row, ported from `presentThreadShell` (`state/models.ts`).
/// Timestamps are parsed once here. Absent and `null` fields both read as nil: current servers send
/// every key (checked live), so nil means "present and null".
public struct ThreadFacts: Sendable, Hashable {
  public struct Run: Sendable, Hashable {
    public var status: ThreadShell.Status?
    public var requestedAt: WireTimestamp?
    public var startedAt: WireTimestamp?
    public var completedAt: WireTimestamp?
  }

  public struct Runtime: Sendable, Hashable {
    /// `activityRunStatus ?? status`, or `idle` while background work holds completion.
    public var status: ThreadShell.Status?
    public var activeRunId: String?
    public var lastErrorClass: ThreadShell.ProviderFailureClass?
    public var updatedAt: WireTimestamp
  }

  public var ref: ThreadRef
  public var thread: ThreadShell
  /// The title as lists show it (subagent titles lose their `Subagent:` prefix and path).
  public var title: String
  public var latestRun: Run?
  public var runtime: Runtime?
  public var hasPendingApprovals: Bool
  public var hasPendingUserInput: Bool
  public var pendingUserInputAt: WireTimestamp?
  public var pendingSubagentRequest: SubagentRequest?

  public var createdAt: Date
  public var lastVisitedAt: Date?
  public var settledAt: Date?
  public var snoozedUntil: Date?
  public var snoozedAt: Date?
  public var latestUserMessageAt: Date?

  public init(environmentId: String, thread: ThreadShell, pendingSubagentRequest: SubagentRequest? = nil) {
    ref = ThreadRef(environmentId: environmentId, threadId: thread.id)
    self.thread = thread
    title = thread.lineage.relationshipToParent == .known(.subagent) ? Self.subagentTitle(thread.title) : thread.title
    if thread.latestRunId != nil {
      let status = thread.status.known
      latestRun = Run(
        status: status == .idle ? .completed : status,
        requestedAt: thread.latestRunRequestedAt, startedAt: thread.latestRunStartedAt,
        completedAt: thread.latestRunCompletedAt)
    }
    let parkAtIdle =
      (thread.pendingBackgroundTasks ?? []).contains { $0.holdsCompletion } && thread.status != .known(.failed)
    if thread.latestRunId != nil || parkAtIdle {
      let activity = thread.activityRunStatus?.known.map(ThreadShell.Status.init(activity:))
      runtime = Runtime(
        status: parkAtIdle ? .idle : (activity ?? thread.status.known),
        activeRunId: thread.activeRunId, lastErrorClass: thread.lastErrorClass?.known, updatedAt: thread.updatedAt)
    }
    let request = thread.pendingRuntimeRequest
    hasPendingApprovals = request.map { $0.kind != .known(.userInput) && $0.kind != .known(.authRefresh) } ?? false
    hasPendingUserInput = request?.kind == .known(.userInput)
    pendingUserInputAt = hasPendingUserInput ? request?.createdAt : nil
    self.pendingSubagentRequest = pendingSubagentRequest
    createdAt = thread.createdAt.date ?? .distantPast
    lastVisitedAt = thread.lastVisitedAt?.date
    settledAt = thread.settledAt?.date
    snoozedUntil = thread.snoozedUntil?.date
    snoozedAt = thread.snoozedAt?.date
    latestUserMessageAt = thread.latestUserMessageAt?.date
  }

  public var key: String { ref.key }
  public var isSettled: Bool { thread.settledOverride == .known(.settled) }
  public var isPinned: Bool { thread.pinnedAt != nil }

  /// `formatSubagentDisplayTitle`: drops a `Subagent:` prefix and turns `/root/a/b_name` into "B Name".
  public static func subagentTitle(_ title: String) -> String {
    let display = title.replacing(/^Subagent:\s*/.ignoresCase(), with: "")
    guard let match = display.wholeMatch(of: /\/root\/(?:[^\/]+\/)*([^\/]+)\/?/) else { return display }
    let name = String(match.1).replacing(/[_\s]+/, with: " ").trimmingCharacters(in: .whitespaces)
    let titled = name.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    return titled.isEmpty ? display : titled
  }
}

extension ThreadShell.Status {
  init(activity: ThreadShell.ActivityRunStatus) {
    switch activity {
    case .preparing: self = .preparing
    case .starting: self = .starting
    case .running: self = .running
    case .waiting: self = .waiting
    }
  }

  /// preparing, queued, starting, running or waiting.
  public var isActive: Bool {
    switch self {
    case .preparing, .queued, .starting, .running, .waiting: true
    default: false
    }
  }
}

extension ThreadShell.PendingBackgroundTask {
  /// `backgroundWorkHoldsCompletion`: subagents and background tasks hold a run open; commands and
  /// monitors only when the agent marked them awaited.
  var holdsCompletion: Bool {
    if awaited == true { return true }
    switch kind?.known {
    case .subagent?, .backgroundTask?: return true
    default: return false
    }
  }
}

extension ThreadFacts {
  /// `threadRuntimeCanArchive`: a running thread must be interrupted first.
  public var canArchive: Bool {
    switch runtime?.status {
    case .queued?: runtime?.activeRunId == nil
    case .preparing?, .starting?, .running?: false
    default: true
    }
  }

  /// The latest of the user's message and the latest run's request, start and completion, else
  /// `updatedAt` (`resolveThreadActivityTimestamp`).
  public var activityAt: Date? {
    let candidates = [
      latestUserMessageAt, latestRun?.requestedAt?.date, latestRun?.startedAt?.date, latestRun?.completedAt?.date,
    ]
    return candidates.compactMap(\.self).max() ?? thread.updatedAt.date
  }

  /// `resolveSettledThreadTimestamp`.
  public var settledSortAt: Date? { settledAt ?? activityAt }

  /// `max(createdAt, activity)`, the folder ordering key.
  var activityOrCreation: Date { max(createdAt, activityAt ?? .distantPast) }
}

/// The rolled-up requests of subagents and side chats, per parent thread id
/// (`pendingSubagentRequestsByThread`, without linked-environment delegation).
enum SubagentRequestRollup {
  static func requests(in threads: [ThreadShell]) -> [String: SubagentRequest] {
    enum Rolled { case approval, userInput, userOnlyInput }
    var requests: [String: Rolled] = [:]
    let byId = Dictionary(threads.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

    func childRunLive(_ thread: ThreadShell) -> Bool { thread.activityRunStatus != nil }

    func subagentRequest(_ thread: ThreadShell) -> SubagentRequest? {
      guard let kind = thread.pendingRuntimeRequest?.kind, kind != .known(.authRefresh),
        thread.lineage.relationshipToParent == .known(.subagent),
        thread.creationSource != .known(.provider), childRunLive(thread)
      else { return nil }
      return kind == .known(.userInput) ? .userInput : .approval
    }

    func sideChatRequest(_ thread: ThreadShell) -> SubagentRequest? {
      guard let kind = thread.pendingRuntimeRequest?.kind, kind != .known(.authRefresh), thread.lineage.sideChat == true
      else { return nil }
      return kind == .known(.userInput) ? .userInput : .approval
    }

    func flag(_ firstParent: String?, _ request: Rolled, seen: inout Set<String>) {
      // The coordinator answers child questions; approvals and user-only cards need the user.
      if case .userInput = request { return }
      var parentId = firstParent
      while let id = parentId, !seen.contains(id) {
        seen.insert(id)
        if requests[id] != .approval { requests[id] = request }
        let parent = byId[id]
        parentId =
          parent?.lineage.relationshipToParent == .known(.subagent) || parent?.lineage.sideChat == true
          ? parent?.lineage.parentThreadId : nil
      }
    }

    for child in threads {
      let parentId = child.lineage.parentThreadId
      if child.lineage.sideChat == true {
        if let parentId, let request = sideChatRequest(child), requests[parentId] != .approval {
          requests[parentId] = request == .approval ? .approval : .userInput
        }
        continue
      }
      guard child.lineage.relationshipToParent == .known(.subagent), let request = subagentRequest(child) else { continue }
      let rolled: Rolled =
        request == .userInput ? (child.pendingRuntimeRequest?.userOnly == true ? .userOnlyInput : .userInput) : .approval
      var seen: Set<String> = [child.id]
      flag(parentId, rolled, seen: &seen)
    }
    return requests.mapValues { $0 == .approval ? .approval : .userInput }
  }
}

/// The descendants (subagents and side chats, through their own subagents) of a thread that ask
/// the user for an approval: RN `childThreadInputsAtom` filtered to approvals. Their approvals
/// are shown on the parent and answered on the child.
public enum ChildApprovalScan {
  public static func children(of parentId: String, in threads: [ThreadShell]) -> [ThreadShell] {
    var byParent: [String: [ThreadShell]] = [:]
    for thread in threads {
      guard let parent = thread.lineage.parentThreadId,
        thread.lineage.relationshipToParent == .known(.subagent) || thread.lineage.sideChat == true
      else { continue }
      byParent[parent, default: []].append(thread)
    }
    var seen: Set<String> = [parentId]
    var queue = [parentId]
    var result: [ThreadShell] = []
    while !queue.isEmpty {
      let parent = queue.removeFirst()
      for child in byParent[parent] ?? [] where seen.insert(child.id).inserted {
        queue.append(child.id)
        if asksApproval(child) { result.append(child) }
      }
    }
    return result
  }

  /// `asksParent` for an approval: a live subagent's or any side chat's pending approval.
  static func asksApproval(_ thread: ThreadShell) -> Bool {
    guard let kind = thread.pendingRuntimeRequest?.kind, kind != .known(.authRefresh), kind != .known(.userInput) else {
      return false
    }
    if thread.lineage.sideChat == true { return true }
    return thread.lineage.relationshipToParent == .known(.subagent) && thread.creationSource != .known(.provider)
      && thread.activityRunStatus != nil
  }
}
