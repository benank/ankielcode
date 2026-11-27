import Foundation

/// An answer sent from an alert's button (RN `AgentNotificationAction`). Push notifications are
/// not built yet; this is the eligibility rule they will use, shared with any quick action.
public struct AgentNotificationAction: Sendable, Hashable {
  public enum Kind: String, Sendable { case approve, deny, reply }
  public var kind: Kind
  /// The thread holding the request: a child's request is answered on the child.
  public var thread: ThreadRef
  public var requestId: String
  /// The reply's text; empty for approve and deny.
  public var text: String

  public init(kind: Kind, thread: ThreadRef, requestId: String, text: String = "") {
    self.kind = kind
    self.thread = thread
    self.requestId = requestId
    self.text = text
  }
}

/// What the button sends (RN `planAgentNotificationAction`).
public enum AgentNotificationActionPlan: Sendable, Equatable {
  /// The synced thread does not show the request yet.
  case wait
  /// Answered elsewhere, or no longer answerable.
  case skip
  case send(RequestCommand)

  /// Decided from the thread's live projection, mirroring the in-app card: Approve and Deny send
  /// what "Allow once" and "Decline" send, and Reply answers the only question. The command id
  /// is fixed per request and button, so a repeat replays the server's receipt.
  public static func plan(_ action: AgentNotificationAction, projection: ThreadProjection?, canOperate: Bool) -> Self {
    guard let projection, let request = projection.runtimeRequests.first(where: { $0.id == action.requestId }) else {
      return .wait
    }
    guard request.status == .pending, canOperate else { return .skip }
    let pending = PendingRequestDerivation.derive(projection)
    let commandId = CommandID("notification:\(action.kind.rawValue):\(action.requestId)")
    let threadId = action.thread.threadId
    if action.kind == .reply {
      guard let input = pending.userInputs.first(where: { $0.requestId == action.requestId }), input.canRespond,
        input.questions.count == 1, let question = input.questions.first,
        let answers = UserInputAnswers.answers(input.questions, [question.id: UserInputDraft(customAnswer: action.text)])
      else { return .skip }
      return .send(RequestCommand(.answers(answers), threadId: threadId, requestId: action.requestId, commandId: commandId))
    }
    guard let approval = pending.approvals.first(where: { $0.requestId == action.requestId }), approval.isLive else {
      return .skip
    }
    let decision = action.kind == .approve ? "accept" : "decline"
    let offered = approval.options?.map(\.decision) ?? ApprovalChoices.defaultDecisions
    guard offered.contains(decision) else { return .skip }
    return .send(RequestCommand(.decision(decision), threadId: threadId, requestId: action.requestId, commandId: commandId))
  }
}

/// The app icon badge and, later, notification counts: threads waiting on the user.
public enum AttentionCount {
  public static func waiting(_ rows: some Sequence<ThreadFacts>) -> Int {
    rows.reduce(0) { count, facts in
      count + (facts.hasPendingApprovals || facts.hasPendingUserInput || facts.pendingSubagentRequest == .approval ? 1 : 0)
    }
  }
}
