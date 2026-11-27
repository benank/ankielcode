import Foundation
import Observation

/// Where answers go: the environment registry in the app, a fake in tests and debug builds.
@MainActor
public protocol RequestSink: AnyObject {
  func respond(_ command: RequestCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int
  func answerSecret(_ answer: SecretAnswer, in environmentId: String) async throws(EnvironmentRequestError)
}

/// One thing the dock can show, with the thread that holds it (a child's approval is answered on
/// the child).
public enum DockRequest: Sendable, Hashable, Identifiable {
  case approval(PendingApproval, thread: ThreadRef, from: String?)
  case question(PendingUserInput, thread: ThreadRef)
  case secret(PendingSecret, thread: ThreadRef)

  public var id: String {
    switch self {
    case .approval(let approval, let thread, _): "\(thread.threadId):\(approval.requestId)"
    case .question(let input, let thread): "\(thread.threadId):\(input.requestId)"
    case .secret(let secret, let thread): "\(thread.threadId):\(secret.itemId)"
    }
  }

  public var thread: ThreadRef {
    switch self {
    case .approval(_, let thread, _), .question(_, let thread), .secret(_, let thread): thread
    }
  }

  /// The id the server and the request state key on.
  public var requestKey: String {
    switch self {
    case .approval(let approval, _, _): approval.requestId
    case .question(let input, _): input.requestId
    case .secret(let secret, _): secret.itemId
    }
  }

  /// The order the dock works through: the thread's approvals, then child approvals, questions,
  /// secrets (RN shows the first approval above the first question).
  public static func queue(
    _ pending: PendingThreadRequests, thread: ThreadRef, children: [(title: String, thread: ThreadRef, approvals: [PendingApproval])] = []
  ) -> [DockRequest] {
    pending.approvals.map { .approval($0, thread: thread, from: nil) }
      + children.flatMap { child in child.approvals.map { .approval($0, thread: child.thread, from: child.title) } }
      + pending.userInputs.map { .question($0, thread: thread) }
      + pending.secrets.map { .secret($0, thread: thread) }
  }
}

/// Answering a thread's pending requests: sending state, errors, question drafts, the one-shot
/// confirmation after an answer, and the notice when a request on screen ends elsewhere. One per
/// open thread (kept by the app so drafts survive navigating away).
@MainActor @Observable
public final class PendingRequestController {
  public enum Phase: Sendable, Equatable {
    case idle
    /// Sending; `choice` is the decision (or `answers`, `dismiss`, `save`, `decline`).
    case sending(choice: String)
    case failed(EnvironmentRequestError)
  }

  /// Shown in the card's place for a moment after the server took an answer.
  public struct Confirmation: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable { case allowed(String), declined, answered, dismissed, saved, secretDeclined }
    public var id: String
    public var kind: Kind
  }

  /// A request on screen that ended without this device answering it.
  public struct Notice: Sendable, Equatable, Identifiable {
    public var id: String
    public var outcome: RequestOutcome
  }

  /// Keyed by `DockRequest.requestKey`.
  public private(set) var phases: [String: Phase] = [:]
  /// Question edits by request id, then question id (suggested answers are not stored).
  public private(set) var drafts: [String: [String: UserInputDraft]] = [:]
  /// The question step shown, by request id.
  public var pages: [String: Int] = [:]
  public private(set) var confirmation: Confirmation?
  public private(set) var notice: Notice?

  /// Answered and accepted, but the projection still says pending; hidden so the card does not
  /// flash back before the server's event lands.
  public private(set) var answered: Set<String> = []

  @ObservationIgnored public weak var sink: (any RequestSink)?
  /// Command ids per request and choice, reused when a send fails in transit (the server replays
  /// its receipt) and replaced after a refusal (a refused id fails again).
  @ObservationIgnored private var commandIds: [String: CommandID] = [:]
  @ObservationIgnored private var shownKey: String?
  @ObservationIgnored private var pendingKeys: Set<String> = []

  public init(sink: (any RequestSink)? = nil) {
    self.sink = sink
  }

  public func phase(_ key: String) -> Phase { phases[key] ?? .idle }

  public func isSending(_ key: String) -> Bool {
    if case .sending = phase(key) { true } else { false }
  }

  /// The visible queue: what is pending, minus answers the server already took.
  public func visible(_ queue: [DockRequest]) -> [DockRequest] {
    queue.filter { !answered.contains($0.requestKey) }
  }

  /// Follows the thread's requests. A request on screen that left pending without this device
  /// answering it raises a notice; drafts and state of ended requests are dropped.
  public func observe(_ queue: [DockRequest], outcomes: [String: RequestOutcome]) {
    let keys = Set(queue.map(\.requestKey))
    if let shown = shownKey, !keys.contains(shown), !answered.contains(shown), confirmation?.id != shown {
      notice = Notice(id: shown, outcome: outcomes[shown] ?? .resolved(decision: nil))
    }
    answered.formIntersection(keys)
    for key in pendingKeys.subtracting(keys) {
      drafts[key] = nil
      pages[key] = nil
      if case .sending = phases[key] {} else { phases[key] = nil }
      commandIds = commandIds.filter { !$0.key.hasPrefix("\(key)#") }
    }
    pendingKeys = keys
    shownKey = visible(queue).first?.requestKey
  }

  public func clearConfirmation(_ id: String) {
    if confirmation?.id == id { confirmation = nil }
  }

  public func clearNotice(_ id: String) {
    if notice?.id == id { notice = nil }
  }

  // MARK: Approvals

  /// Sends a decision. Returns whether the server took it.
  @discardableResult
  public func approve(
    _ approval: PendingApproval, decision: String, label: String, feedback: String? = nil, thread: ThreadRef
  ) async -> Bool {
    guard approval.isLive, !isSending(approval.requestId) else { return false }
    let reply = RequestCommand.Reply.decision(decision, feedback: feedback)
    let ok = await send(
      key: approval.requestId, choice: decision, environmentId: thread.environmentId
    ) { commandId in
      RequestCommand(reply, threadId: thread.threadId, requestId: approval.requestId, commandId: commandId)
    }
    if ok {
      confirmation = Confirmation(
        id: approval.requestId, kind: ApprovalChoices.isAllow(decision) ? .allowed(label) : .declined)
    }
    return ok
  }

  /// What a composer send does while approvals wait (RN `handleSendMessage`).
  public enum Redirect: Sendable, Equatable {
    /// Nothing waits; send as usual.
    case none
    /// The first approval took the text as decline feedback; do not send it as a message.
    case responded
    /// Every live approval was declined; send the message now.
    case declined
    /// Feedback cannot carry attachments.
    case attachmentsNotAllowed
    /// A decline failed; keep the draft.
    case failed
  }

  /// RN `sendApprovalFeedback` / `declinePendingApprovals`: a message sent while approvals wait
  /// either answers the first one as feedback (when its provider takes feedback) or declines
  /// them all, one at a time, before the message goes.
  public func redirect(_ approvals: [(PendingApproval, ThreadRef)], text: String, hasAttachments: Bool) async -> Redirect {
    guard let (first, thread) = approvals.first else { return .none }
    if first.supportsFeedback && first.isLive {
      if hasAttachments { return .attachmentsNotAllowed }
      let feedback = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !feedback.isEmpty else { return .failed }
      return await approve(first, decision: "decline", label: "", feedback: feedback, thread: thread) ? .responded : .failed
    }
    for (approval, thread) in approvals where approval.isLive {
      guard await approve(approval, decision: "decline", label: "", thread: thread) else { return .failed }
    }
    return .declined
  }

  // MARK: Questions

  /// The drafts the card reads: edits over suggested answers, with attachment state merged in.
  public func drafts(for input: PendingUserInput, attachments: [String: (count: Int, blocked: Bool)] = [:]) -> [String: UserInputDraft] {
    var seeded = UserInputAnswers.seeded(input.questions, drafts[input.requestId] ?? [:])
    for (questionId, state) in attachments {
      var draft = seeded[questionId] ?? UserInputDraft()
      draft.attachmentCount = state.count
      draft.attachmentsBlocked = state.blocked
      seeded[questionId] = draft
    }
    return seeded
  }

  public func toggle(_ value: String, question: UserInputQuestion, in input: PendingUserInput) {
    let current = UserInputAnswers.seeded([question], drafts[input.requestId] ?? [:])[question.id]
    drafts[input.requestId, default: [:]][question.id] = UserInputAnswers.toggling(question, current, value)
  }

  public func setText(_ text: String, question: UserInputQuestion, in input: PendingUserInput) {
    let current = UserInputAnswers.seeded([question], drafts[input.requestId] ?? [:])[question.id]
    drafts[input.requestId, default: [:]][question.id] = UserInputAnswers.settingCustomAnswer(question, current, text)
  }

  public func page(_ input: PendingUserInput) -> Int {
    min(pages[input.requestId] ?? 0, max(0, input.questions.count - 1))
  }

  @discardableResult
  public func submit(
    _ input: PendingUserInput, thread: ThreadRef, attachments: [String: [ChatAttachment]] = [:],
    attachmentState: [String: (count: Int, blocked: Bool)] = [:]
  ) async -> Bool {
    guard input.canRespond, !isSending(input.requestId),
      let answers = UserInputAnswers.answers(input.questions, drafts(for: input, attachments: attachmentState))
    else { return false }
    let ok = await send(key: input.requestId, choice: "answers", environmentId: thread.environmentId) { commandId in
      RequestCommand(
        .answers(answers, attachments: attachments.filter { !$0.value.isEmpty }), threadId: thread.threadId,
        requestId: input.requestId, commandId: commandId)
    }
    if ok { confirmation = Confirmation(id: input.requestId, kind: .answered) }
    return ok
  }

  @discardableResult
  public func dismiss(_ input: PendingUserInput, thread: ThreadRef) async -> Bool {
    guard input.dismissible, !isSending(input.requestId) else { return false }
    let ok = await send(key: input.requestId, choice: "dismiss", environmentId: thread.environmentId) { commandId in
      RequestCommand(.dismiss, threadId: thread.threadId, requestId: input.requestId, commandId: commandId)
    }
    if ok { confirmation = Confirmation(id: input.requestId, kind: .dismissed) }
    return ok
  }

  // MARK: Secrets

  /// Answers a secret request. The values live only in the caller's fields and this call.
  @discardableResult
  public func answer(_ answer: SecretAnswer, environmentId: String) async -> Bool {
    let key = answer.turnItemId
    guard !isSending(key), let sink else {
      if sink == nil { phases[key] = .failed(.notConnected) }
      return false
    }
    let declining = answer.reply == .decline
    phases[key] = .sending(choice: declining ? "decline" : "save")
    do {
      try await sink.answerSecret(answer, in: environmentId)
      phases[key] = .idle
      answered.insert(key)
      confirmation = Confirmation(id: key, kind: declining ? .secretDeclined : .saved)
      return true
    } catch {
      phases[key] = .failed(error)
      return false
    }
  }

  // MARK: Sending

  private func send(
    key: String, choice: String, environmentId: String, command: (CommandID) -> RequestCommand
  ) async -> Bool {
    guard let sink else {
      phases[key] = .failed(.notConnected)
      return false
    }
    let idKey = "\(key)#\(choice)"
    let commandId = commandIds[idKey] ?? CommandID()
    commandIds[idKey] = commandId
    phases[key] = .sending(choice: choice)
    do {
      _ = try await sink.respond(command(commandId), in: environmentId)
      phases[key] = .idle
      answered.insert(key)
      return true
    } catch {
      if case .rejected = error { commandIds[idKey] = nil }
      phases[key] = .failed(error)
      return false
    }
  }
}

extension EnvironmentRegistry: RequestSink {
  public func respond(_ command: RequestCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    try await request(environmentId) { session in
      try await session.call(ThreadCommand.rpcTag, payload: command, as: DispatchResult.self).sequence
    }
  }

  public func answerSecret(_ answer: SecretAnswer, in environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await request(environmentId) { session in
      try await session.call(SecretAnswer.rpcTag, payload: answer, as: JSONValue.self)
    }
  }
}
