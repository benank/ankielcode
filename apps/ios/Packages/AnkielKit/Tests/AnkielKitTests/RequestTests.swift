import Foundation
import Testing

@testable import AnkielKit

/// Ports of `client-runtime/src/state/pendingUserInput.test.ts` and `threadRequests.test.ts`, plus
/// the controller that answers from the dock.
enum RequestMake {
  static let thread = "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87"
  static let ref = ThreadRef(environmentId: "env", threadId: thread)

  static func decode<T: Decodable>(_: T.Type, _ json: String) -> T {
    try! JSONDecoder().decode(T.self, from: Data(json.utf8))
  }

  static func request(
    _ id: String, kind: String = "command", status: String = "pending", capability: String = #"{"type":"live","providerSessionId":"s"}"#,
    extra: String = ""
  ) -> RuntimeRequest {
    decode(RuntimeRequest.self, #"{"id":"\#(id)","nodeId":"n","providerTurnId":null,"nativeRequestRef":null,"kind":"\#(kind)","status":"\#(status)","responseCapability":\#(capability),"createdAt":"2026-11-27T00:00:00.000Z","resolvedAt":null\#(extra)}"#)
  }

  static func item(_ id: String, type: String, ordinal: Int = 1, fields: String) -> TurnItem {
    decode(TurnItem.self, #"{"id":"\#(id)","threadId":"\#(thread)","runId":null,"nodeId":"n","providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":\#(ordinal),"status":"waiting","title":null,"startedAt":null,"completedAt":null,"updatedAt":"2026-11-27T00:00:00.000Z","type":"\#(type)",\#(fields)}"#)
  }

  static func projection(requests: [RuntimeRequest], items: [TurnItem]) -> ThreadProjection {
    var projection = ThreadProjection(thread: AppThread(id: thread, projectId: "p", title: "T"), updatedAt: WireTimestamp(Date(timeIntervalSince1970: 0)))
    projection.runtimeRequests = requests
    projection.turnItems = items
    projection.visibleTurnItems = items.enumerated().map { ProjectedTurnItem(position: $0.offset, item: $0.element) }
    return projection
  }

  static func question(
    _ id: String, options: [UserInputQuestion.Option] = [], multiSelect: Bool? = nil, allowCustomAnswer: Bool? = nil,
    initialAnswer: String? = nil, required: Bool? = nil
  ) -> UserInputQuestion {
    UserInputQuestion(
      id: id, header: id, question: "\(id)?", options: options, multiSelect: multiSelect, allowCustomAnswer: allowCustomAnswer,
      initialAnswer: initialAnswer, required: required)
  }

  static let singleSelect = question(
    "scope", options: [.init(label: "Orchestration-first", description: "Focus on orchestration first"), .init(label: "Node.js", description: "Reuse TypeScript")],
    multiSelect: false)
  static let nativeChoice = question(
    "result", options: [.init(label: "Result", description: "First result", value: " first\t"), .init(label: "Result", description: "Second result", value: "second")],
    multiSelect: false, allowCustomAnswer: false)
}

@Suite("Question answers (pendingUserInput.ts)")
struct UserInputAnswerTests {
  typealias A = UserInputAnswers
  let single = RequestMake.singleSelect
  let native = RequestMake.nativeChoice

  @Test("preserves exact editor text, including a deliberately cleared answer")
  func exactEditorText() {
    var question = single
    question.initialAnswer = "  Proposed message\n"
    #expect(A.answer(question, UserInputDraft(customAnswer: question.initialAnswer)) == .text("  Proposed message\n"))
    #expect(A.answer(question, UserInputDraft(customAnswer: "  Edited message\n\n")) == .text("  Edited message\n\n"))
    #expect(A.answer(question, UserInputDraft(customAnswer: "")) == .text(""))
    #expect(A.answer(question, UserInputDraft(customAnswer: " \n")) == .text(" \n"))
    #expect(A.settingCustomAnswer(question, UserInputDraft(selectedOptionValues: ["Orchestration-first"]), "") == UserInputDraft(customAnswer: ""))
  }

  @Test("prefers a custom answer over selected options")
  func customWins() {
    let draft = UserInputDraft(selectedOptionValues: ["Orchestration-first"], customAnswer: "Keep the existing envelope for one release")
    #expect(A.answer(single, draft) == .text("Keep the existing envelope for one release"))
  }

  @Test("does not replace a required choice with a custom answer")
  func requiredChoice() {
    #expect(A.answer(native, UserInputDraft(selectedOptionValues: ["second"], customAnswer: "Use another result")) == .text("second"))
  }

  @Test("does not submit labels or unknown values when an option has a value")
  func labelsNotValues() {
    #expect(A.answer(native, UserInputDraft(selectedOptionValues: ["Result", "unknown"])) == nil)
  }

  @Test("matches a label only for an option without a value")
  func labelMatch() {
    #expect(A.answer(single, UserInputDraft(selectedOptionValues: [" Node.js "])) == .text("Node.js"))
  }

  @Test("lets an optional text question stay blank")
  func optionalText() {
    let text = RequestMake.question("notes")
    var optional = text
    optional.required = false
    var required = text
    required.required = true
    #expect(A.answer(optional, nil) == .text(""))
    #expect(A.answer(optional, UserInputDraft(customAnswer: " ")) == .text(""))
    #expect(A.answer(text, UserInputDraft(customAnswer: " ")) == nil)
    #expect(A.answer(required, UserInputDraft(customAnswer: "")) == nil)
  }

  @Test("accepts ready attachment-only answers while preserving selected options")
  func attachmentOnly() {
    #expect(A.answer(single, UserInputDraft(attachmentCount: 1)) == .text(""))
    #expect(A.answer(single, UserInputDraft(selectedOptionValues: ["Node.js"], attachmentCount: 1)) == .text("Node.js"))
    #expect(A.answer(single, UserInputDraft(attachmentCount: 1, attachmentsBlocked: true)) == nil)
    var closed = single
    closed.allowCustomAnswer = false
    #expect(A.answer(closed, UserInputDraft(attachmentCount: 1)) == nil)
  }

  @Test("selects and removes options with the same label independently")
  func sameLabel() {
    var question = native
    question.multiSelect = true
    let first = A.toggling(question, nil, " first\t")
    let both = A.toggling(question, first, "second")
    #expect(A.answers([question], ["result": both]) == ["result": .choices([" first\t", "second"])])
    let second = A.toggling(question, both, " first\t")
    #expect(A.answers([question], ["result": second]) == ["result": .choices(["second"])])
  }

  @Test("submits raw option values and leaves the draft alone for an unknown option")
  func rawValues() {
    let first = A.toggling(native, nil, " first\t")
    #expect(A.isSelected(native, first, " first\t"))
    #expect(!A.isSelected(native, first, "second"))
    #expect(A.answers([native], ["result": first]) == ["result": .text(" first\t")])
    #expect(A.toggling(native, first, "Result") == first)
  }

  @Test("rejects arbitrary text when the provider only accepts offered options")
  func closedQuestion() {
    #expect(A.settingCustomAnswer(native, nil, "Other") == UserInputDraft())
    #expect(A.answers([native], ["result": UserInputDraft(customAnswer: "Other")]) == nil)
    #expect(A.answers([native], ["result": UserInputDraft(selectedOptionValues: ["second"], customAnswer: "stale draft")]) == ["result": .text("second")])
  }

  @Test("returns a canonical answer map for complete prompts")
  func canonical() {
    let compat = RequestMake.question("compat", options: [.init(label: "Keep current envelope", description: "Preserve current wire format")], multiSelect: false)
    let answers = A.answers([single, compat], [
      "scope": UserInputDraft(selectedOptionValues: ["Orchestration-first"]),
      "compat": UserInputDraft(customAnswer: "Keep the current envelope for one release window"),
    ])
    #expect(answers == ["scope": .text("Orchestration-first"), "compat": .text("Keep the current envelope for one release window")])
  }

  @Test("answers a multi-select question with no options checked as an empty list")
  func multiNone() {
    let extras = RequestMake.question(
      "extras", options: [.init(label: "Lint", description: "Lint"), .init(label: "Tests", description: "Tests"), .init(label: "CI", description: "CI")],
      multiSelect: true)
    let unchecked = A.toggling(extras, A.toggling(extras, nil, "Lint"), "Lint")
    #expect(A.answers([single, extras], ["scope": UserInputDraft(selectedOptionValues: ["Node.js"]), "extras": unchecked]) == [
      "scope": .text("Node.js"), "extras": .choices([]),
    ])
    var required = extras
    required.required = true
    #expect(A.answers([required], ["extras": unchecked]) == nil)
  }

  @Test("seeds editable answers and preserves edits and selections on later snapshots")
  func seeding() {
    let questions = [
      RequestMake.question("editor", initialAnswer: "  Proposed commit\n\n"),
      RequestMake.question("empty", initialAnswer: ""),
      RequestMake.question("ordinary"),
      RequestMake.question("choices", allowCustomAnswer: false, initialAnswer: "Ignore this"),
    ]
    let seeded = A.seeded(questions, [:])
    #expect(seeded == ["editor": UserInputDraft(customAnswer: "  Proposed commit\n\n"), "empty": UserInputDraft(customAnswer: "")])
    var edits = seeded
    edits["editor"] = UserInputDraft(customAnswer: "")
    edits["empty"] = UserInputDraft(selectedOptionValues: ["empty"], customAnswer: "")
    #expect(A.seeded(questions, edits) == edits)
    #expect(A.seeded(questions, ["editor": UserInputDraft(customAnswer: "Edited commit")])["editor"] == UserInputDraft(customAnswer: "Edited commit"))
    #expect(A.seeded([RequestMake.question("__proto__", initialAnswer: "Proposed")], [:])["__proto__"] == UserInputDraft(customAnswer: "Proposed"))
  }

  @Test("answers encode as strings and arrays keyed by question id")
  func encoding() throws {
    let json = try JSONDecoder().decode(
      JSONValue.self, from: JSONEncoder().encode(["a": UserInputAnswer.text("x"), "b": .choices(["y", "z"])]))
    #expect(json == ["a": "x", "b": ["y", "z"]])
  }
}

@Suite("Pending requests (threadRequests.ts)")
struct PendingRequestDerivationTests {
  static let messageQuestion = RequestMake.item(
    "async-question-item", type: "user_input_request",
    fields: #""requestId":"async-question","responseMode":"message","questions":[{"id":"next","header":"Next","question":"What should happen next?","required":true,"allowCustomAnswer":false,"options":[{"label":"Continue","value":"  continue  ","description":"Resume work"}]}]"#)

  @Test("keeps message responses available after the originating runtime exits")
  func messageResponses() {
    let projection = RequestMake.projection(
      requests: [RequestMake.request("async-question", kind: "user_input", capability: #"{"type":"message"}"#)], items: [Self.messageQuestion])
    let inputs = PendingRequestDerivation.derive(projection).userInputs
    #expect(inputs.count == 1)
    #expect(inputs.first?.responseCapability == "message")
    #expect(inputs.first?.dismissible == true)
    #expect(inputs.first?.canRespond == true)
    #expect(inputs.first?.questions.first?.options.elements.first?.value == "  continue  ")
    #expect(inputs.first?.questions.first?.required == true)
  }

  @Test("only marks asynchronous questions as dismissible")
  func dismissible() {
    let live = RequestMake.item(
      "q", type: "user_input_request",
      fields: #""requestId":"async-question","questions":[{"id":"next","header":"Next","question":"Next?","options":[]}]"#)
    let projection = RequestMake.projection(requests: [RequestMake.request("async-question", kind: "user_input")], items: [live])
    #expect(PendingRequestDerivation.derive(projection).userInputs.first?.dismissible == false)
  }

  @Test("approvals come from runtime requests, with or without their item, in request order")
  func approvals() {
    let item = RequestMake.item(
      "a2", type: "approval_request",
      fields: #""requestId":"r2","requestKind":"permission","prompt":"Write outside the workspace","reason":"  ","fullAccessOverride":"ask_rule","options":[{"decision":"acceptAlways","label":"Always allow","warning":"Applies to every thread"},{"decision":"decline","label":"Decline"}]"#)
    let projection = RequestMake.projection(
      requests: [
        RequestMake.request("r1"),
        RequestMake.request("r2", kind: "permission", capability: #"{"type":"live","providerSessionId":"s","supportsFeedback":true}"#),
        RequestMake.request("r3", kind: "file-change", capability: #"{"type":"not_resumable","reason":"gone"}"#),
        RequestMake.request("r4", kind: "auth_refresh"),
        RequestMake.request("r5", kind: "dynamic_tool_call"),
        RequestMake.request("r6", status: "resolved"),
      ], items: [item])
    let approvals = PendingRequestDerivation.derive(projection).approvals
    #expect(approvals.map(\.requestId) == ["r1", "r2", "r3"])
    #expect(approvals[0].options == nil)
    #expect(approvals[0].detail == nil)
    #expect(approvals[1].detail == "Write outside the workspace")
    #expect(approvals[1].reason == nil)
    #expect(approvals[1].fullAccessOverride == "ask_rule")
    #expect(approvals[1].supportsFeedback)
    #expect(ApprovalChoices.warning(approvals[1].options ?? []) == "Applies to every thread")
    #expect(!approvals[2].isLive)
    #expect(!approvals[2].supportsFeedback)
    #expect(ApprovalChoices.options(approvals[0]).map(\.decision) == ["accept", "acceptForSession", "decline"])
  }

  @Test("pending secrets are the local secret items still waiting")
  func secrets() {
    let pending = RequestMake.item(
      "s1", type: "secret_request", fields: #""label":"Deploy token","reason":"Open https://example.test/tokens.","secretStatus":"pending","delivery":"file""#)
    let saved = RequestMake.item("s2", type: "secret_request", ordinal: 2, fields: #""label":"Other","reason":"","secretStatus":"saved""#)
    let secrets = PendingRequestDerivation.derive(RequestMake.projection(requests: [], items: [pending, saved])).secrets
    #expect(secrets.map(\.itemId) == ["s1"])
    #expect(SecretRequestForm.privacy(secrets[0]) == .fileOne)
    #expect(SecretRequestForm.link(secrets[0])?.host == "example.test")
    #expect(SecretRequestForm.inputs(secrets[0]).map(\.secret) == [true])
    #expect(SecretRequestForm.answer(secrets[0], values: ["": "  "]) == nil)
    #expect(SecretRequestForm.answer(secrets[0], values: ["": " tok "])?.reply == .secret("tok"))
    #expect(!String(describing: SecretRequestForm.answer(secrets[0], values: ["": "tok_hidden"])!).contains("tok_hidden"))
  }

  @Test("a resolved question shows its runtime answers in the feed's answered row")
  func answeredOverlay() throws {
    let item = RequestMake.item(
      "q", type: "user_input_request",
      fields: #""requestId":"rq","questions":[{"id":"sim","header":"Sim","question":"Which simulator?","options":[{"label":"iPhone","description":"Phone"}]}]"#)
    let request = RequestMake.request("rq", kind: "user_input", status: "resolved", extra: #","answers":{"sim":"iPhone"}"#)
    let timeline = ThreadTimelineBuilder.build(RequestMake.projection(requests: [request], items: [item]), markdown: MarkdownParser())
    let answered = timeline.rows.compactMap { row -> AnsweredRow? in
      if case .answered(let answered) = row.content { answered } else { nil }
    }
    #expect(answered.first?.pairs.first?.answer == "iPhone")
  }
}

@Suite("Secret refusals")
struct SecretRefusalTests {
  @Test("only secret and authorization refusals show the server's words")
  func filtered() {
    #expect(EnvironmentRequestError.rejected(message: "The secret store is locked.", tag: "SecretRequestError").secretRefusalMessage
      == "The secret store is locked.")
    #expect(EnvironmentRequestError.rejected(message: "Not allowed.", tag: "EnvironmentAuthorizationError").secretRefusalMessage == "Not allowed.")
    #expect(EnvironmentRequestError.rejected(message: "Expected string, got hunter2", tag: "SchemaError").secretRefusalMessage == nil)
    #expect(EnvironmentRequestError.rejected(message: "No tag").secretRefusalMessage == nil)
    #expect(EnvironmentRequestError.rejected(message: "  ", tag: "SecretRequestError").secretRefusalMessage == nil)
    #expect(EnvironmentRequestError.failed("socket").secretRefusalMessage == nil)
  }

  @Test("a server refusal keeps its tag")
  func tagCarried() {
    let failure = RpcFailure(error: .object(["_tag": .string("SecretRequestError"), "message": .string("Locked.")]))
    #expect(EnvironmentRequestError(RpcError.failed(failure)) == .rejected(message: "Locked.", tag: "SecretRequestError"))
  }
}

@Suite("Request fixtures")
struct RequestFixtureTests {
  @Test("every request fixture derives the requests it is named for")
  func fixtures() throws {
    func pending(_ name: String) throws -> PendingThreadRequests {
      PendingRequestDerivation.derive(try ThreadFixtures.projection("thread-\(name)"))
    }
    #expect(try pending("approval-command").approvals.map(\.supportsFeedback) == [true])
    #expect(try pending("approval-file-change").approvals.first?.options?.count == 3)
    #expect(try pending("approval-file-read").approvals.first?.requestKind == "file-read")
    #expect(try pending("approval-permission").approvals.first?.fullAccessOverride == "provider_check")
    #expect(try pending("approval-mcp").approvals.first?.appName == "Harbor Charts")
    #expect(try pending("approval-stale").approvals.first?.isLive == false)
    #expect(try pending("approvals-queued").approvals.count == 3)
    #expect(try pending("question-single").userInputs.first?.questions.first?.multiSelect == false)
    #expect(try pending("question-multi").userInputs.first?.questions.first?.required == true)
    #expect(try pending("question-text").userInputs.first?.questions.first?.options.elements.isEmpty == true)
    #expect(try pending("question-other").userInputs.first?.questions.first?.options.elements.first?.preview != nil)
    #expect(try pending("question-steps").userInputs.first?.questions.count == 3)
    #expect(try pending("question-message").userInputs.first?.dismissible == true)
    let link = try pending("secret").secrets.first.flatMap(SecretRequestForm.link)
    #expect(link?.host == "feeds.example.test")
    #expect(try pending("secret-fields").secrets.first.map(SecretRequestForm.inputs)?.map(\.secret) == [false, true])
    let mixed = try pending("requests-mixed")
    #expect(mixed.approvals.count == 1 && mixed.userInputs.count == 1 && mixed.secrets.count == 1)
  }
}

@Suite("Requests resolved by the server")
struct RequestResolutionTests {
  @Test("a runtime-request.updated event ends the question, records the outcome and leaves the answered row")
  func resolvedByEvent() throws {
    let items = try ThreadFixtures.items("thread-question-resolved")
    var before: ThreadProjection?
    if case .snapshot(let snapshot)? = items.first { before = snapshot.projection }
    #expect(PendingRequestDerivation.derive(try #require(before)).userInputs.count == 1)
    let after = try ThreadFixtures.projection("thread-question-resolved")
    #expect(PendingRequestDerivation.derive(after).isEmpty)
    #expect(PendingRequestDerivation.outcomes(after)["runtime-request:requests:question:8"] == .resolved(decision: nil))
    let answered = try ThreadFixtures.timeline("thread-question-resolved").rows.compactMap { row -> AnsweredRow? in
      if case .answered(let answered) = row.content { answered } else { nil }
    }
    #expect(answered.first?.pairs.first?.answer == "iPhone 18 Pro")
  }
}

@Suite("Child thread approvals")
struct ChildApprovalScanTests {
  func shell(_ id: String, parent: String?, configure: (inout ThreadShell) -> Void = { _ in }) throws -> ThreadShell {
    var row = try Fixture.thread(id, title: id)
    row.lineage.parentThreadId = parent
    configure(&row)
    return row
  }

  func asking(_ kind: ThreadShell.PendingRuntimeRequest.Kind) -> ThreadShell.PendingRuntimeRequest {
    ThreadShell.PendingRuntimeRequest(id: "r", kind: .known(kind), createdAt: WireTimestamp(rawValue: "2026-06-01T00:00:00.000Z"))
  }

  @Test("finds live subagents and side chats asking for approval, through nested subagents, and nothing else")
  func scan() throws {
    let subagent: (inout ThreadShell) -> Void = {
      $0.lineage.relationshipToParent = .known(.subagent)
      $0.activityRunStatus = .known(.waiting)
    }
    let threads = [
      try shell("parent", parent: nil),
      try shell("sub", parent: "parent") { subagent(&$0); $0.pendingRuntimeRequest = self.asking(.command) },
      try shell("nested", parent: "sub") { subagent(&$0); $0.pendingRuntimeRequest = self.asking(.fileChange) },
      try shell("question", parent: "parent") { subagent(&$0); $0.pendingRuntimeRequest = self.asking(.userInput) },
      try shell("idle", parent: "parent") {
        $0.lineage.relationshipToParent = .known(.subagent)
        $0.pendingRuntimeRequest = self.asking(.command)
      },
      try shell("side", parent: "parent") { $0.lineage.sideChat = true; $0.pendingRuntimeRequest = self.asking(.permission) },
      try shell("other", parent: "someone-else") { subagent(&$0); $0.pendingRuntimeRequest = self.asking(.command) },
    ]
    #expect(ChildApprovalScan.children(of: "parent", in: threads).map(\.id).sorted() == ["nested", "side", "sub"])
  }
}

@Suite("Notification action plan (notificationActions.ts)")
struct NotificationActionPlanTests {
  static let approval = RequestMake.item("a", type: "approval_request", fields: #""requestId":"r1","requestKind":"command","prompt":"ls""#)

  @Test("waits for the request, skips answered or unanswerable ones, and sends a fixed command id")
  func plans() {
    let action = AgentNotificationAction(kind: .approve, thread: RequestMake.ref, requestId: "r1")
    #expect(AgentNotificationActionPlan.plan(action, projection: nil, canOperate: true) == .wait)
    let pending = RequestMake.projection(requests: [RequestMake.request("r1")], items: [Self.approval])
    #expect(AgentNotificationActionPlan.plan(action, projection: pending, canOperate: false) == .skip)
    guard case .send(let command) = AgentNotificationActionPlan.plan(action, projection: pending, canOperate: true) else {
      Issue.record("expected a command")
      return
    }
    #expect(command.reply == .decision("accept"))
    #expect(command.commandId.rawValue == "notification:approve:r1")
    let resolved = RequestMake.projection(requests: [RequestMake.request("r1", status: "resolved")], items: [Self.approval])
    #expect(AgentNotificationActionPlan.plan(action, projection: resolved, canOperate: true) == .skip)
    let stale = RequestMake.projection(
      requests: [RequestMake.request("r1", capability: #"{"type":"not_resumable","reason":"x"}"#)], items: [Self.approval])
    #expect(AgentNotificationActionPlan.plan(action, projection: stale, canOperate: true) == .skip)
  }

  @Test("deny needs a decline the provider offers; reply answers only a single question")
  func denyAndReply() {
    let item = RequestMake.item(
      "a", type: "approval_request", fields: #""requestId":"r1","requestKind":"command","options":[{"decision":"accept","label":"Run"}]"#)
    let deny = AgentNotificationAction(kind: .deny, thread: RequestMake.ref, requestId: "r1")
    #expect(AgentNotificationActionPlan.plan(deny, projection: RequestMake.projection(requests: [RequestMake.request("r1")], items: [item]), canOperate: true) == .skip)
    let one = RequestMake.item("q", type: "user_input_request", fields: #""requestId":"q1","questions":[{"id":"a","header":"A","question":"A?","options":[]}]"#)
    let reply = AgentNotificationAction(kind: .reply, thread: RequestMake.ref, requestId: "q1", text: "yes")
    let plan = AgentNotificationActionPlan.plan(
      reply, projection: RequestMake.projection(requests: [RequestMake.request("q1", kind: "user_input")], items: [one]), canOperate: true)
    guard case .send(let command) = plan else {
      Issue.record("expected a reply")
      return
    }
    #expect(command.reply == .answers(["a": .text("yes")]))
  }
}

@MainActor
final class FakeRequestSink: RequestSink {
  var commands: [RequestCommand] = []
  var secrets: [SecretAnswer] = []
  var failures: [EnvironmentRequestError] = []
  var gate: CheckedContinuation<Void, Never>?
  var holds = false

  func respond(_ command: RequestCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    commands.append(command)
    if holds { await withCheckedContinuation { gate = $0 } }
    if !failures.isEmpty { throw failures.removeFirst() }
    return commands.count
  }

  func answerSecret(_ answer: SecretAnswer, in environmentId: String) async throws(EnvironmentRequestError) {
    secrets.append(answer)
    if !failures.isEmpty { throw failures.removeFirst() }
  }

  func release() {
    gate?.resume()
    gate = nil
  }
}

@MainActor
@Suite("Answering from the dock")
struct PendingRequestControllerTests {
  static let approval = PendingApproval(requestId: "r1", requestKind: "command", detail: "rm -rf build")
  static let second = PendingApproval(requestId: "r2", requestKind: "command")

  @Test("allow sends the decision, confirms, and hides the card until the server resolves it")
  func allow() async {
    let sink = FakeRequestSink()
    let controller = PendingRequestController(sink: sink)
    let queue = [DockRequest.approval(Self.approval, thread: RequestMake.ref, from: nil)]
    controller.observe(queue, outcomes: [:])
    #expect(await controller.approve(Self.approval, decision: "accept", label: "Allow once", thread: RequestMake.ref))
    #expect(sink.commands.map(\.reply) == [.decision("accept")])
    #expect(sink.commands.first?.threadId == RequestMake.thread)
    #expect(controller.confirmation == .init(id: "r1", kind: .allowed("Allow once")))
    #expect(controller.visible(queue).isEmpty)
    controller.observe([], outcomes: ["r1": .resolved(decision: "accept")])
    #expect(controller.notice == nil)
  }

  @Test("a failed send returns to answerable with its error; a transit retry reuses the command id")
  func failure() async {
    let sink = FakeRequestSink()
    sink.failures = [.notConnected, .rejected(message: "Gone")]
    let controller = PendingRequestController(sink: sink)
    #expect(await !controller.approve(Self.approval, decision: "decline", label: "Decline", thread: RequestMake.ref))
    #expect(controller.phase("r1") == .failed(.notConnected))
    #expect(await !controller.approve(Self.approval, decision: "decline", label: "Decline", thread: RequestMake.ref))
    #expect(sink.commands[0].commandId == sink.commands[1].commandId)
    #expect(controller.phase("r1") == .failed(.rejected(message: "Gone")))
    #expect(await controller.approve(Self.approval, decision: "decline", label: "Decline", thread: RequestMake.ref))
    #expect(sink.commands[2].commandId != sink.commands[1].commandId)
    #expect(controller.confirmation?.kind == .declined)
  }

  @Test("a second tap while sending is ignored")
  func noDoubleSend() async {
    let sink = FakeRequestSink()
    sink.holds = true
    let controller = PendingRequestController(sink: sink)
    let first = Task { await controller.approve(Self.approval, decision: "accept", label: "Allow", thread: RequestMake.ref) }
    while sink.gate == nil { await Task.yield() }
    #expect(controller.isSending("r1"))
    #expect(await !controller.approve(Self.approval, decision: "decline", label: "Decline", thread: RequestMake.ref))
    sink.release()
    #expect(await first.value)
    #expect(sink.commands.count == 1)
  }

  @Test("a request on screen that ends elsewhere raises a notice with its outcome")
  func elsewhere() {
    let controller = PendingRequestController(sink: FakeRequestSink())
    controller.observe(
      [.approval(Self.approval, thread: RequestMake.ref, from: nil), .approval(Self.second, thread: RequestMake.ref, from: nil)],
      outcomes: [:])
    controller.observe([.approval(Self.second, thread: RequestMake.ref, from: nil)], outcomes: ["r1": .expired])
    #expect(controller.notice == .init(id: "r1", outcome: .expired))
    controller.clearNotice("r1")
    // The next request took the screen, so its ending raises the next notice.
    controller.observe([], outcomes: ["r2": .resolved(decision: "accept")])
    #expect(controller.notice?.id == "r2")
  }

  @Test("feedback declines only the first approval; otherwise every live approval is declined in order")
  func redirect() async {
    let sink = FakeRequestSink()
    let controller = PendingRequestController(sink: sink)
    var feedback = Self.approval
    feedback.supportsFeedback = true
    #expect(await controller.redirect([(feedback, RequestMake.ref), (Self.second, RequestMake.ref)], text: "  Safer please.  ", hasAttachments: false) == .responded)
    #expect(sink.commands.map(\.reply) == [.decision("decline", feedback: "Safer please.")])
    #expect(await controller.redirect([(feedback, RequestMake.ref)], text: "x", hasAttachments: true) == .attachmentsNotAllowed)
    var stale = Self.approval
    stale.isLive = false
    sink.commands = []
    #expect(await controller.redirect([(stale, RequestMake.ref), (Self.second, RequestMake.ref)], text: "Do X", hasAttachments: true) == .declined)
    #expect(sink.commands.map(\.requestId) == ["r2"])
    sink.failures = [.notConnected]
    #expect(await controller.redirect([(Self.second, RequestMake.ref)], text: "Do X", hasAttachments: false) == .failed)
  }

  @Test("questions: drafts over suggested answers, submit sends every answer, dismiss only when allowed")
  func questions() async {
    let sink = FakeRequestSink()
    let controller = PendingRequestController(sink: sink)
    let pick = RequestMake.singleSelect
    let note = RequestMake.question("note", initialAnswer: "Looks good")
    let input = PendingUserInput(requestId: "q1", questions: [pick, note])
    #expect(controller.drafts(for: input)["note"]?.customAnswer == "Looks good")
    #expect(await !controller.submit(input, thread: RequestMake.ref))
    controller.toggle("Node.js", question: pick, in: input)
    #expect(await !controller.dismiss(input, thread: RequestMake.ref))
    #expect(await controller.submit(input, thread: RequestMake.ref))
    #expect(sink.commands.last?.reply == .answers(["scope": .text("Node.js"), "note": .text("Looks good")]))
    #expect(controller.confirmation?.kind == .answered)
    controller.observe([], outcomes: [:])
    var message = input
    message.requestId = "q2"
    message.dismissible = true
    #expect(await controller.dismiss(message, thread: RequestMake.ref))
    #expect(sink.commands.last?.reply == .dismiss)
  }

  @Test("drafts of a request that left pending are dropped")
  func pruning() {
    let controller = PendingRequestController(sink: FakeRequestSink())
    let input = PendingUserInput(requestId: "q1", questions: [RequestMake.singleSelect])
    controller.observe([.question(input, thread: RequestMake.ref)], outcomes: [:])
    controller.toggle("Node.js", question: RequestMake.singleSelect, in: input)
    #expect(controller.drafts["q1"] != nil)
    controller.observe([], outcomes: ["q1": .cancelled])
    #expect(controller.drafts["q1"] == nil)
    #expect(controller.notice == .init(id: "q1", outcome: .cancelled))
  }

  @Test("secrets send once and fail back with the values kept by the caller")
  func secrets() async {
    let sink = FakeRequestSink()
    sink.failures = [.rejected(message: nil)]
    let controller = PendingRequestController(sink: sink)
    let answer = SecretAnswer(threadId: RequestMake.thread, turnItemId: "s1", reply: .secret("x"))
    #expect(await !controller.answer(answer, environmentId: "env"))
    #expect(controller.phase("s1") == .failed(.rejected(message: nil)))
    #expect(await controller.answer(answer, environmentId: "env"))
    #expect(controller.confirmation?.kind == .saved)
  }
}
