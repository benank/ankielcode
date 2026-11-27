import AnkielKit
import Foundation

/// The app's request sink, over a plain session.
@MainActor
final class SessionRequestSink: RequestSink {
  let session: EnvironmentSession
  init(_ session: EnvironmentSession) { self.session = session }

  func respond(_ command: RequestCommand, in _: String) async throws(EnvironmentRequestError) -> Int {
    do {
      return try await session.rpc.call(ThreadCommand.rpcTag, payload: command, as: DispatchResult.self).sequence
    } catch {
      throw EnvironmentRequestError(error)
    }
  }

  func answerSecret(_ answer: SecretAnswer, in _: String) async throws(EnvironmentRequestError) {
    do {
      _ = try await session.rpc.call(SecretAnswer.rpcTag, payload: answer, as: JSONValue.self)
    } catch {
      throw EnvironmentRequestError(error)
    }
  }
}

func waitingFor(_ state: ThreadDetailState) -> Bool { !state.pending.isEmpty }

/// `--live requests`: a question answered (an offered option, then free text), an approval declined
/// through the composer path, and an approval answered by another session while this one watches.
@MainActor
func liveRequests(_ session: EnvironmentSession, other: EnvironmentSession) async throws {
  let ref = { (threadId: String) in ThreadRef(environmentId: session.environmentId, threadId: threadId) }
  var failures: [String] = []
  let sink = SessionRequestSink(session)

  for mode in ["option", "text"] {
    try await withReplayThread(session, scenario: "question") { threadId, _, watcher in
      let state = try await watcher.until(60, "a question", waitingFor)
      guard let input = state.pending.userInputs.first, let question = input.questions.first else {
        throw ProbeFailure(description: "No question; pending \(state.pending)")
      }
      print("  question \(question.id): “\(question.question)” options \(question.options.elements.map(\.label)) multi=\(question.multiSelect.map(String.init) ?? "nil") custom=\(question.allowCustomAnswer.map(String.init) ?? "nil") required=\(question.required.map(String.init) ?? "nil") capability=\(input.responseCapability) dismissible=\(input.dismissible)")
      if mode == "text", question.allowCustomAnswer == false {
        print("  – this question takes no free text (allowCustomAnswer false); skipped")
        _ = try? await other.rpc.call(
          ThreadCommand.rpcTag,
          payload: RequestCommand(.answers([question.id: .text(question.options.elements.first?.label ?? "")]), threadId: threadId, requestId: input.requestId),
          as: DispatchResult.self)
        return
      }
      let controller = PendingRequestController(sink: sink)
      if mode == "option", let option = question.options.elements.first {
        controller.toggle(UserInputAnswers.optionValue(option), question: question, in: input)
      } else {
        controller.setText("Whatever keeps the fixture readable", question: question, in: input)
      }
      let ok = await controller.submit(input, thread: ref(threadId))
      print("  answered with \(mode): \(ok ? "accepted" : "REFUSED \(String(describing: controller.phase(input.requestId)))")")
      if !ok { failures.append("question \(mode)") ; return }
      let after = try await watcher.until(60, "the turn to finish", idle)
      let answered = after.timeline.rows.contains { if case .answered = $0.content { true } else { false } }
      print("  after: rows \(describeRows(after)); outcome \(after.outcomes[input.requestId].map { "\($0)" } ?? "none"); answered row \(answered)")
      if !answered { failures.append("answered row (\(mode))") }
    }
  }

  // Decline through the composer: feedback when the provider takes it, else decline then send.
  try await withReplayThread(session, scenario: "approval") { threadId, _, watcher in
    let state = try await watcher.until(60, "an approval", waitingFor)
    guard let approval = state.pending.approvals.first else { throw ProbeFailure(description: "No approval") }
    if let raw = try? await rawSnapshot(session, threadId: threadId) {
      for row in raw["projection"]?["turnItems"]?.arrayValue ?? [] where row["type"]?.stringValue == "approval_request" || row["requestId"] != nil {
        print("  raw item: \(String(decoding: try JSONEncoder.sorted.encode(row), as: UTF8.self).prefix(1500))")
      }
      for request in raw["projection"]?["runtimeRequests"]?.arrayValue ?? [] {
        print("  raw request: \(String(decoding: try JSONEncoder.sorted.encode(request), as: UTF8.self).prefix(1500))")
      }
    }
    print("  approval \(approval.requestKind) options \(approval.options?.map(\.label) ?? []) live=\(approval.isLive) feedback=\(approval.supportsFeedback)")
    let controller = PendingRequestController(sink: sink)
    let text = "Do not write that file; describe it instead."
    let redirect = await controller.redirect([(approval, ref(threadId))], text: text, hasAttachments: false)
    print("  composer redirect → \(redirect)")
    if redirect == .declined {
      let message = MessageDispatch(commandId: CommandID(), threadId: threadId, messageId: UUID().uuidString.lowercased(), text: text)
      _ = try await session.rpc.call(ThreadCommand.rpcTag, payload: message, as: DispatchResult.self)
    }
    let after = try await watcher.until(60, "the thread to settle after the decline", idle)
    let users = after.timeline.rows.filter { if case .user = $0.content { true } else { false } }.count
    print("  after: rows \(describeRows(after)); outcome \(after.outcomes[approval.requestId].map { "\($0)" } ?? "none"); user messages \(users)")
    if case .resolved(let decision)? = after.outcomes[approval.requestId], decision == "decline" {} else { failures.append("decline outcome") }
  }

  // Answered on another device while this one shows the card.
  try await withReplayThread(session, scenario: "approval") { threadId, _, watcher in
    let state = try await watcher.until(60, "an approval", waitingFor)
    guard let approval = state.pending.approvals.first else { throw ProbeFailure(description: "No approval") }
    let controller = PendingRequestController(sink: sink)
    let queue = DockRequest.queue(state.pending, thread: ref(threadId))
    controller.observe(queue, outcomes: state.outcomes)
    _ = try await other.rpc.call(
      ThreadCommand.rpcTag, payload: RequestCommand(.decision("accept"), threadId: threadId, requestId: approval.requestId),
      as: DispatchResult.self)
    print("  the other session accepted \(approval.requestId)")
    let after = try await watcher.until(30, "this session to see it resolved") { $0.pending.isEmpty }
    controller.observe(DockRequest.queue(after.pending, thread: ref(threadId)), outcomes: after.outcomes)
    print("  this session: outcome \(after.outcomes[approval.requestId].map { "\($0)" } ?? "none"); notice \(controller.notice.map { "\($0.outcome)" } ?? "none")")
    if controller.notice == nil { failures.append("elsewhere notice") }
    // A late answer from this session must fail cleanly, not hang.
    let late = await controller.approve(approval, decision: "decline", label: "", thread: ref(threadId))
    print("  a late decline from this session: \(late ? "accepted (!)" : "refused: \(controller.phase(approval.requestId))")")
    _ = try await watcher.until(60, "the turn to finish", idle)
  }
  withExtendedLifetime(sink) {}
  if !failures.isEmpty { throw ProbeFailure(description: "Failed: \(failures)") }
}
