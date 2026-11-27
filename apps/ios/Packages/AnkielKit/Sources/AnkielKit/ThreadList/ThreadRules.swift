import Foundation

/// A thread's state as the list names it (`ThreadListV2Status`).
public enum ThreadListStatus: Sendable, Hashable {
  case approval, input, working, waiting, failed, limited, ready
}

/// The small light a row shows (`PixelStatusKind`); nil while nothing needs a look.
public enum ThreadLight: Sendable, Hashable, Comparable {
  case waiting, working, done, failed, attention

  /// `PIXEL_URGENCY`, for the light a closed folder shows.
  var urgency: Int {
    switch self {
    case .attention: 5
    case .failed: 4
    case .done: 3
    case .working: 2
    case .waiting: 1
    }
  }

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.urgency < rhs.urgency }
}

/// What the row's read toggle does (`resolveThreadListV2ReadToggle`).
public enum ReadToggle: Sendable, Hashable {
  /// `thread.visit` with the thread's own time, not this device's clock.
  case markRead(visitedAt: WireTimestamp)
  case markUnread
}

/// Ported from `state/threadSettled.ts` and `features/threads/threadListV2.ts`.
public enum ThreadRules {
  /// `QUEUED_TURN_START_GRACE_MS`.
  public static let queuedTurnGrace: TimeInterval = 120

  // MARK: Snooze

  /// `hasQueuedTurnStart`: a sent message the server has not started a run for yet.
  public static func hasQueuedTurnStart(_ facts: ThreadFacts, now: Date) -> Bool {
    switch facts.runtime?.status {
    case .preparing?, .queued?, .starting?: return true
    default: break
    }
    guard let messageAt = facts.latestUserMessageAt else { return false }
    if abs(now.timeIntervalSince(messageAt)) > queuedTurnGrace { return false }
    guard let run = facts.latestRun else { return true }
    return [run.requestedAt, run.startedAt, run.completedAt].allSatisfy { candidate in
      guard let date = candidate?.date else { return true }
      return date < messageAt
    }
  }

  private static func pendingQuestionAt(_ facts: ThreadFacts) -> Date? {
    facts.pendingUserInputAt?.date
  }

  /// The failure time when the runtime failed: the failed run's completion, else the runtime's
  /// update. `.some(nil)` means failed without a date.
  private static func failureEdgeAt(_ facts: ThreadFacts) -> Date?? {
    guard facts.runtime?.status == .failed else { return nil }
    if facts.latestRun?.status == .failed { return .some(facts.latestRun?.completedAt?.date) }
    return .some(facts.runtime?.updatedAt.date)
  }

  /// `threadRaisedHandWhileSnoozed`: only a request for the user or a fresh failure ends a snooze early.
  public static func raisedHandWhileSnoozed(_ facts: ThreadFacts) -> Bool {
    let request = facts.thread.pendingRuntimeRequest
    if facts.hasPendingApprovals || (request != nil && request?.kind != .known(.userInput)) { return true }
    if facts.hasPendingUserInput {
      guard let snoozedAt = facts.snoozedAt, let questionAt = pendingQuestionAt(facts) else { return true }
      if !(questionAt <= snoozedAt) { return true }
    }
    if facts.pendingSubagentRequest != nil { return true }
    guard let failedAt = failureEdgeAt(facts) else { return false }
    guard let snoozedAt = facts.snoozedAt else { return true }
    guard let failedAt else { return false }
    return failedAt > snoozedAt
  }

  public static func canSnooze(_ facts: ThreadFacts, now: Date) -> Bool {
    if facts.hasPendingApprovals { return false }
    if let request = facts.thread.pendingRuntimeRequest, request.kind != .known(.userInput) { return false }
    if facts.pendingSubagentRequest != nil { return false }
    return !hasQueuedTurnStart(facts, now: now)
  }

  public static func effectivelySnoozed(_ facts: ThreadFacts, now: Date) -> Bool {
    guard let wake = facts.snoozedUntil, wake > now else { return false }
    return !raisedHandWhileSnoozed(facts)
  }

  /// `threadWokeAt`: when a snoozed thread came back (early by a hand-raise, or on its timer).
  public static func wokeAt(_ facts: ThreadFacts, now: Date) -> WireTimestamp? {
    guard let raw = facts.thread.snoozedUntil, let wake = raw.date else { return nil }
    if raisedHandWhileSnoozed(facts) {
      let failed = failureEdgeAt(facts) ?? nil
      let question = pendingQuestionAt(facts)
      let freshFailure = failed.map { date in facts.snoozedAt.map { date > $0 } ?? true } ?? false
      let freshQuestion = question.flatMap { date in facts.snoozedAt.map { date > $0 } } ?? false
      if freshFailure, let failed, !freshQuestion || failed >= (question ?? .distantPast) {
        return WireTimestamp(failed)
      }
      if freshQuestion { return facts.pendingUserInputAt }
      return facts.runtime?.updatedAt ?? facts.thread.snoozedAt
    }
    return wake <= now ? raw : nil
  }

  /// A woken thread shows "Woke" until visited after the wake (`resolveThreadListV2WokeAt`).
  public static func listWokeAt(_ facts: ThreadFacts, now: Date) -> WireTimestamp? {
    if facts.isSettled { return nil }
    guard let woke = wokeAt(facts, now: now), let wokeDate = woke.date else { return nil }
    if let visited = facts.lastVisitedAt, visited >= wokeDate { return nil }
    return woke
  }

  // MARK: Status

  public static func status(_ facts: ThreadFacts) -> ThreadListStatus {
    if facts.hasPendingApprovals || facts.pendingSubagentRequest == .approval { return .approval }
    if facts.hasPendingUserInput || facts.pendingSubagentRequest == .userInput { return .input }
    let runtime = facts.runtime?.status
    if runtime == .running, facts.thread.blockedOnThreadWait == true { return .waiting }
    if facts.thread.subagentTurnActive == true || runtime?.isActive == true { return .working }
    if runtime == .idle { return .waiting }
    if runtime == .failed { return facts.runtime?.lastErrorClass == .usageLimit ? .limited : .failed }
    return .ready
  }

  /// A failure the user has already opened settles to ready (`resolveThreadListV2RowStatus`).
  public static func rowStatus(_ facts: ThreadFacts) -> ThreadListStatus {
    let status = status(facts)
    guard status == .failed, facts.latestRun?.status == .failed else { return status }
    return hasUnseenRunFailure(facts) ? status : .ready
  }

  /// `hasUnseenRunFailure`.
  public static func hasUnseenRunFailure(_ facts: ThreadFacts) -> Bool {
    guard let run = facts.latestRun, run.status == .failed else { return false }
    guard let visited = facts.lastVisitedAt else { return true }
    guard let failedAt = (run.completedAt ?? run.startedAt ?? run.requestedAt)?.date else { return true }
    return failedAt > visited
  }

  /// `threadHasUnseenCompletion`: a run finished after the last visit.
  public static func hasUnseenCompletion(_ facts: ThreadFacts) -> Bool {
    guard let run = facts.latestRun, let completed = run.completedAt?.date else { return false }
    if run.status == .interrupted || run.status == .cancelled { return false }
    guard let visited = facts.lastVisitedAt else { return false }
    return completed > visited
  }

  public static func light(_ facts: ThreadFacts, wokeAt: WireTimestamp?) -> ThreadLight? {
    switch rowStatus(facts) {
    case .working: .working
    case .waiting: .waiting
    case .approval, .input, .limited: .attention
    case .failed: .failed
    case .ready: wokeAt != nil ? .attention : (hasUnseenCompletion(facts) ? .done : nil)
    }
  }

  public static func readToggle(_ facts: ThreadFacts, wokeAt: WireTimestamp?) -> ReadToggle? {
    let light = light(facts, wokeAt: wokeAt)
    let run = facts.latestRun
    let candidates = [wokeAt, run?.completedAt ?? run?.startedAt ?? run?.requestedAt].compactMap(\.self)
      .filter { $0.date != nil }
    if let visitedAt = candidates.max(by: { $0.date! < $1.date! }), let visitedDate = visitedAt.date {
      var seen = facts
      if let last = facts.lastVisitedAt, last >= visitedDate {
        seen.lastVisitedAt = last
      } else {
        seen.lastVisitedAt = visitedDate
      }
      if Self.light(seen, wokeAt: nil) != light { return .markRead(visitedAt: visitedAt) }
    }
    guard let completed = run?.completedAt?.date, facts.canArchive else { return nil }
    var unseen = facts
    unseen.lastVisitedAt = completed.addingTimeInterval(-0.001)
    return Self.light(unseen, wokeAt: nil) != light ? .markUnread : nil
  }
}

/// The row's swipe actions (`resolveThreadListV2SwipeActions`).
public struct SwipeActions: Sendable, Hashable {
  public enum Primary: Sendable, Hashable { case archive, settle, unsettle, unsnooze }
  public var primary: Primary
  public var snooze: Bool

  public static func resolve(
    slim: Bool, settlementSupported: Bool, snoozeSupported: Bool, snoozable: Bool, snoozed: Bool
  ) -> SwipeActions {
    if snoozed { return SwipeActions(primary: .unsnooze, snooze: false) }
    let primary: Primary = settlementSupported ? (slim ? .unsettle : .settle) : .archive
    return SwipeActions(primary: primary, snooze: snoozeSupported && snoozable)
  }
}
