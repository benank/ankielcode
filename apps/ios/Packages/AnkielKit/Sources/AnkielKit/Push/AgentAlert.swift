import Foundation

/// The ids the server's `AgentAlertPush` and the app agree on.
public enum AgentAlertIDs {
  /// `aps.category` on alerts that two buttons or one reply can answer (`alertCategory`).
  public static let approvalCategory = "ANKIEL_APPROVAL"
  public static let replyCategory = "ANKIEL_INPUT_REPLY"
  public static let approve = "ANKIEL_APPROVE"
  public static let deny = "ANKIEL_DENY"
  public static let reply = "ANKIEL_REPLY"
  /// The local notification saying a button's answer did not leave the phone.
  public static let unsentCategory = "ANKIEL_UNSENT"

  /// The APNs `loc-key` the server puts on each kind; the app's string catalog defines them.
  public static func locKey(_ kind: PushAlertKind) -> String { "ANKIEL_PUSH_\(kind.rawValue.uppercased())" }
}

/// An agent alert's ids, read from a remote notification's `userInfo`. The server puts them under
/// a top-level `body` key, beside `aps`.
public struct AgentAlert: Sendable, Hashable {
  /// The listed thread a tap opens.
  public var thread: ThreadRef
  public var kind: WireEnum<PushAlertKind>?
  /// The waiting request, on alerts that carry buttons.
  public var requestId: String?
  /// The thread holding the request: a child's request is answered on the child.
  public var requestThread: ThreadRef?

  public init(thread: ThreadRef, kind: WireEnum<PushAlertKind>? = nil, requestId: String? = nil, requestThread: ThreadRef? = nil) {
    self.thread = thread
    self.kind = kind
    self.requestId = requestId
    self.requestThread = requestThread
  }

  /// nil for anything that is not an agent alert.
  public init?(userInfo: [AnyHashable: Any]) {
    guard let body = userInfo["body"] as? [String: Any],
      let environmentId = Self.nonEmpty(body["environmentId"]), let threadId = Self.nonEmpty(body["threadId"])
    else { return nil }
    thread = ThreadRef(environmentId: environmentId, threadId: threadId)
    kind = Self.nonEmpty(body["kind"]).map(WireEnum.init(rawValue:))
    requestId = Self.nonEmpty(body["requestId"])
    requestThread = requestId.map { _ in
      ThreadRef(environmentId: environmentId, threadId: Self.nonEmpty(body["requestThreadId"]) ?? threadId)
    }
  }

  /// The server's `aps.thread-id`, which groups a thread's alerts.
  public var groupIdentifier: String { Self.groupIdentifier(thread) }

  public static func groupIdentifier(_ thread: ThreadRef) -> String { "\(thread.environmentId)/\(thread.threadId)" }

  /// The approval or question it is about is still the user's to answer.
  public var asksForAnswer: Bool { kind == .approval || kind == .input }

  /// The answer a button carries; nil for a plain tap, an alert without a request, or an empty
  /// reply (that response only opens the thread).
  public func action(identifier: String, text: String?) -> AgentNotificationAction? {
    let kind: AgentNotificationAction.Kind
    switch identifier {
    case AgentAlertIDs.approve: kind = .approve
    case AgentAlertIDs.deny: kind = .deny
    case AgentAlertIDs.reply: kind = .reply
    default: return nil
    }
    guard let requestId, let requestThread else { return nil }
    let reply = kind == .reply ? (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : ""
    if kind == .reply, reply.isEmpty { return nil }
    return AgentNotificationAction(kind: kind, thread: requestThread, requestId: requestId, text: reply)
  }

  private static func nonEmpty(_ value: Any?) -> String? {
    guard let string = value as? String, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return string
  }
}

/// Sends a button's answer once the thread's live projection shows the request (RN
/// `performAgentNotificationAction` after 1fa20c9713): a warm resume can still hold a "live"
/// projection from before the alert, so a request it lacks means wait, never answered.
public enum NotificationAnswer {
  /// What the opened thread shows while the button waits.
  public enum ThreadState: Sendable {
    case deleted
    /// Loading, synchronizing or stale: not yet trustworthy.
    case catchingUp
    case live(ThreadProjection?)
  }

  public enum Outcome: Sendable, Equatable {
    case sent
    /// Answered elsewhere or no longer answerable: nothing to report.
    case skipped
    /// The answer did not leave the phone (no sync, no request, or the send failed while the
    /// request is still pending).
    case unsent
  }

  /// The two limits stay inside the ~30 s iOS gives a notification action, after the ~4 s a cold
  /// background launch takes to reach the handler; connecting and syncing took 13 s cold on the
  /// simulator.
  public static func perform(
    _ action: AgentNotificationAction,
    states: AsyncStream<ThreadState>,
    canOperate: @escaping @Sendable () async -> Bool,
    send: @escaping @Sendable (RequestCommand) async throws -> Void,
    stillPending: @escaping @Sendable () async -> Bool,
    syncTimeout: Duration = .seconds(17),
    sendTimeout: Duration = .seconds(7)
  ) async -> Outcome {
    let plan = await first(within: syncTimeout) {
      for await state in states {
        switch state {
        case .deleted: return AgentNotificationActionPlan.skip
        case .catchingUp: continue
        case .live(let projection):
          let plan = AgentNotificationActionPlan.plan(action, projection: projection, canOperate: await canOperate())
          if plan != .wait { return plan }
        }
      }
      return nil
    }
    guard let plan else { return .unsent }
    guard case .send(let command) = plan else { return .skipped }
    let sent = await first(within: sendTimeout) { () -> Bool? in
      do {
        try await send(command)
        return true
      } catch {
        return false
      }
    }
    if sent == true { return .sent }
    // Another device may have answered while this one sent; that is not a failure to report.
    return await stillPending() ? .unsent : .skipped
  }

  /// `body`'s result, or nil when it finishes empty or `limit` passes first.
  public static func first<Value: Sendable>(within limit: Duration, _ body: @escaping @Sendable () async -> Value?) async -> Value? {
    await withTaskGroup(of: Value?.self) { group in
      group.addTask { await body() }
      group.addTask {
        try? await Task.sleep(for: limit)
        return nil
      }
      let result = await group.next() ?? nil
      group.cancelAll()
      return result
    }
  }
}

/// Which delivered alerts are out of date: an approval or question alert whose thread no longer
/// waits on the user, because it was answered on another device or in the app.
public enum AlertClearing {
  /// Threads holding a request, plus every ancestor (a child's wait alerts on its listed parent).
  public static func waitingThreads(environmentId: String, threads: [ThreadShell]) -> Set<ThreadRef> {
    let parents = Dictionary(threads.map { ($0.id, $0.lineage.parentThreadId) }, uniquingKeysWith: { first, _ in first })
    var waiting: Set<ThreadRef> = []
    for thread in threads {
      let facts = ThreadFacts(environmentId: environmentId, thread: thread)
      guard facts.hasPendingApprovals || facts.hasPendingUserInput else { continue }
      var current: String? = thread.id
      for _ in 0..<16 {
        guard let id = current, waiting.insert(ThreadRef(environmentId: environmentId, threadId: id)).inserted else { break }
        current = parents[id] ?? nil
      }
    }
    return waiting
  }

  /// The alert asks for an answer its computer's live list no longer shows as waiting.
  public static func isStale(_ alert: AgentAlert, waiting: Set<ThreadRef>) -> Bool {
    guard alert.asksForAnswer else { return false }
    return !waiting.contains(alert.thread) && !(alert.requestThread.map(waiting.contains) ?? false)
  }
}
