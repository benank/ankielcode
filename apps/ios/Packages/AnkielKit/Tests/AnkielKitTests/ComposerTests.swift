import Foundation
import ImageIO
import Testing

@testable import AnkielKit

/// A scripted sink: records what the store sends and answers from `results` in order.
@MainActor
final class FakeComposerSink: ComposerSink {
  enum Sent: Equatable {
    case command(type: String, commandId: String)
    case message(MessageDispatch)
    case launch(ThreadLaunch)
  }

  var connected = true
  var sent: [Sent] = []
  /// Answers for message sends and launches, in order; empty means success.
  var results: [EnvironmentRequestError?] = []
  var uploadResult: Result<String, EnvironmentRequestError> = .success("att_uploaded")
  var uploads: [UploadFile] = []
  var discarded: [String] = []
  var launched: [String] = []

  func canSend(to environmentId: String) -> Bool { connected }

  private func next() throws(EnvironmentRequestError) {
    if !results.isEmpty, let error = results.removeFirst() { throw error }
  }

  func send(_ command: ThreadCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    sent.append(.command(type: command.action.type, commandId: command.commandId.rawValue))
    return 1
  }

  func send(_ message: MessageDispatch, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    sent.append(.message(message))
    try next()
    return 42
  }

  func launch(_ launch: ThreadLaunch, in environmentId: String) async throws(EnvironmentRequestError) -> ThreadLaunchResult {
    sent.append(.launch(launch))
    try next()
    return ThreadLaunchResult(threadId: launch.threadId, sequence: 7)
  }

  func upload(
    _ file: UploadFile, in environmentId: String, progress: @escaping @Sendable (Double) -> Void
  ) async throws(EnvironmentRequestError) -> String {
    uploads.append(file)
    progress(0.5)
    return try uploadResult.get()
  }

  func discardUpload(_ attachmentId: String, in environmentId: String) async { discarded.append(attachmentId) }

  func threadLaunched(_ result: ThreadLaunchResult, in environmentId: String) { launched.append(result.threadId) }

  var messages: [MessageDispatch] {
    sent.compactMap { if case .message(let message) = $0 { message } else { nil } }
  }
}

@MainActor
@Suite("Composer store")
struct ComposerStoreTests {
  let ref = ThreadRef(environmentId: "env-1", threadId: "thread-1")
  let settings = ComposerStore.ThreadSettings(
    modelSelection: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5"), runtimeMode: .auto,
    interactionMode: .default)

  func makeStore(_ sink: FakeComposerSink, directory: URL? = nil) async -> ComposerStore {
    let store = ComposerStore(directory: directory, sink: sink)
    store.retryDelay = { _ in .zero }
    await store.load()
    return store
  }

  static func temporaryDirectory() -> URL {
    URL.temporaryDirectory.appending(path: "composer-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
  }

  @Test("a send shows as pending, dispatches once and hides when the feed has it")
  func sendAndReconcile() async throws {
    let sink = FakeComposerSink()
    let store = await makeStore(sink)
    store.setText("  Add a test  ", for: ref.key)
    let message = try #require(store.send(ref.key, to: ref, delivery: .start, thread: settings))
    #expect(store.draft(ref.key).text.isEmpty)
    #expect(store.pending(ref.key, known: []).map(\.messageId) == [message.messageId])
    await store.idle()
    #expect(sink.messages.map(\.text) == ["Add a test"])
    #expect(sink.messages.first?.commandId.rawValue == message.commandId)
    #expect(store.outbox.first?.state == .sent(sequence: 42))
    // Accepted but not in the feed yet: still shown, so nothing flickers away.
    #expect(store.pending(ref.key, known: []).count == 1)
    store.reconcile(ref.key, known: [message.messageId])
    #expect(store.outbox.isEmpty)
  }

  @Test("a dropped reply resends with the same command id")
  func transportRetryKeepsCommandId() async throws {
    let sink = FakeComposerSink()
    sink.results = [.failed("socket closed"), nil]
    let store = await makeStore(sink)
    store.setText("Hello", for: ref.key)
    store.send(ref.key, to: ref, delivery: .start, thread: settings)
    await store.idle()
    #expect(sink.messages.count == 2)
    #expect(Set(sink.messages.map(\.commandId)).count == 1)
    #expect(store.outbox.first?.state.isSent == true)
  }

  @Test("a refusal fails the message; retry mints a new command id")
  func refusalThenRetry() async throws {
    let sink = FakeComposerSink()
    sink.results = [.rejected(message: "Thread is archived.")]
    let store = await makeStore(sink)
    store.setText("Hello", for: ref.key)
    let message = try #require(store.send(ref.key, to: ref, delivery: .start, thread: settings))
    await store.idle()
    #expect(store.outbox.first?.state == .failed(message: "Thread is archived.", retriesSameCommand: false))
    store.retry(message.messageId)
    await store.idle()
    #expect(sink.messages.count == 2)
    #expect(sink.messages[0].commandId != sink.messages[1].commandId)
    #expect(store.outbox.first?.state.isSent == true)
  }

  @Test("repeated transport failures end in a failed state that retries the same command")
  func transportGivesUp() async throws {
    let sink = FakeComposerSink()
    sink.results = Array(repeating: .failed("timeout"), count: 3)
    let store = await makeStore(sink)
    store.maxTransportAttempts = 3
    store.setText("Hello", for: ref.key)
    store.send(ref.key, to: ref, delivery: .start, thread: settings)
    await store.idle()
    #expect(store.outbox.first?.state == .failed(message: "timeout", retriesSameCommand: true))
  }

  @Test("offline messages wait, then send when woken")
  func offlineWaits() async throws {
    let sink = FakeComposerSink()
    sink.connected = false
    let store = await makeStore(sink)
    store.setText("Later", for: ref.key)
    store.send(ref.key, to: ref, delivery: .start, thread: settings)
    await settle()
    #expect(sink.sent.isEmpty)
    #expect(store.outbox.first?.state == .queued)
    sink.connected = true
    store.wake()
    await store.idle()
    #expect(sink.messages.map(\.text) == ["Later"])
  }

  @Test("messages in one thread go one at a time, in order")
  func ordered() async throws {
    let sink = FakeComposerSink()
    let store = await makeStore(sink)
    for text in ["one", "two", "three"] {
      store.setText(text, for: ref.key)
      store.send(ref.key, to: ref, delivery: .queue, thread: settings)
    }
    await store.idle()
    #expect(sink.messages.map(\.text) == ["one", "two", "three"])
    #expect(sink.messages.allSatisfy { $0.delivery == .queue })
  }

  @Test("a changed runtime mode and plan mode are reset before the message, with derived ids")
  func settingsFirst() async throws {
    let sink = FakeComposerSink()
    let store = await makeStore(sink)
    store.updateDraft(ref.key) {
      $0.text = "Go"
      $0.runtimeMode = .fullAccess
    }
    let planned = ComposerStore.ThreadSettings(modelSelection: settings.modelSelection, runtimeMode: .auto, interactionMode: .plan)
    let message = try #require(store.send(ref.key, to: ref, delivery: .start, thread: planned))
    await store.idle()
    #expect(sink.sent.prefix(2) == [
      .command(type: "thread.runtime-mode.set", commandId: "\(message.commandId):runtime-mode"),
      .command(type: "thread.interaction-mode.set", commandId: "\(message.commandId):interaction-mode"),
    ])
    #expect(sink.messages.count == 1)
    #expect(store.draft(ref.key).runtimeMode == nil)
  }

  @Test("a new thread launches with its project and the pick, then remembers it")
  func launch() async throws {
    let sink = FakeComposerSink()
    let store = await makeStore(sink)
    let draftKey = "new:env-1"
    let pick = ModelSelection(instanceId: "devReplay", model: "replay")
    store.updateDraft(draftKey) {
      $0.text = "Start here"
      $0.modelSelection = pick
      $0.projectId = "project-1"
    }
    let creation = OutboxMessage.Creation(projectId: "project-1", title: "Start here")
    let settings = ComposerStore.ThreadSettings(modelSelection: nil, runtimeMode: .auto, interactionMode: nil)
    #expect(store.isAwaitingCreation(ref) == false)
    store.send(draftKey, to: ref, delivery: .start, thread: settings, creation: creation)
    #expect(store.isAwaitingCreation(ref))
    #expect(store.drafts[draftKey] == nil)
    await store.idle()
    guard case .launch(let launch)? = sink.sent.first else {
      Issue.record("no launch")
      return
    }
    #expect(launch.projectId == "project-1")
    #expect(launch.modelSelection == pick)
    #expect(launch.runtimeMode == .auto)
    #expect(sink.launched == [ref.threadId])
    #expect(store.isAwaitingCreation(ref) == false)
    #expect(store.memory.lastModelSelection == pick)
  }

  @Test("a refused launch can return to the new-thread draft")
  func launchFailureRestores() async throws {
    let sink = FakeComposerSink()
    sink.results = [.rejected(message: "Project not found.")]
    let store = await makeStore(sink)
    store.updateDraft("new:env-1") {
      $0.text = "Start here"
      $0.modelSelection = ModelSelection(instanceId: "devReplay", model: "replay")
    }
    let message = try #require(
      store.send(
        "new:env-1", to: ref, delivery: .start,
        thread: .init(modelSelection: nil, runtimeMode: .auto, interactionMode: nil),
        creation: .init(projectId: "project-1", title: "Start here")))
    await store.idle()
    #expect(store.failedCreation(ref)?.messageId == message.messageId)
    store.restoreToDraft(message.messageId, key: "new:env-1")
    #expect(store.outbox.isEmpty)
    #expect(store.draft("new:env-1").text == "Start here")
    #expect(store.draft("new:env-1").projectId == "project-1")
  }

  @Test("attachments upload when added and go out by their server id")
  func attachments() async throws {
    let sink = FakeComposerSink()
    let directory = Self.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = await makeStore(sink, directory: directory)
    let attachment = try await store.addAttachment(
      Data(repeating: 7, count: 1024), name: "photo.png", mimeType: "image/png", kind: .image, to: ref.key,
      environmentId: ref.environmentId)
    #expect(FileManager.default.fileExists(atPath: store.fileURL(attachment).path()))
    await eventually { store.uploadState(store.draft(ref.key).attachments[0], environmentId: ref.environmentId) == .ready(attachmentId: "att_uploaded") }
    #expect(sink.uploads.map(\.sizeBytes) == [1024])
    store.send(ref.key, to: ref, delivery: .start, thread: settings)
    await store.idle()
    #expect(sink.uploads.count == 1, "the outbox reuses the draft's upload")
    #expect(sink.messages.first?.attachments.map(\.id) == ["att_uploaded"])
    #expect(sink.messages.first?.attachments.first?.type == "image")
  }

  @Test("a failed upload blocks sending until it is removed; removing deletes the file")
  func failedUploadBlocks() async throws {
    let sink = FakeComposerSink()
    sink.uploadResult = .failure(.rejected(message: "bad size"))
    let directory = Self.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = await makeStore(sink, directory: directory)
    store.setText("See attached", for: ref.key)
    let attachment = try await store.addAttachment(
      Data(repeating: 1, count: 10), name: "a.txt", mimeType: "text/plain", kind: .file, to: ref.key, environmentId: ref.environmentId)
    await eventually { store.hasFailedUpload(ref.key, environmentId: ref.environmentId) }
    #expect(store.send(ref.key, to: ref, delivery: .start, thread: settings) == nil)
    store.removeAttachment(attachment.id, from: ref.key)
    #expect(!store.hasFailedUpload(ref.key, environmentId: ref.environmentId))
    await eventually { !FileManager.default.fileExists(atPath: store.fileURL(attachment).path()) }
    #expect(store.send(ref.key, to: ref, delivery: .start, thread: settings) != nil)
  }

  @Test("attachments over the limits are refused")
  func limits() async throws {
    let store = await makeStore(FakeComposerSink(), directory: Self.temporaryDirectory())
    await #expect(throws: ComposerStore.AttachmentError.tooLarge(isImage: true)) {
      try await store.addAttachment(
        Data(count: AttachmentLimits.maxImageBytes + 1), name: "big.png", mimeType: "image/png", kind: .image, to: "k",
        environmentId: nil)
    }
    await #expect(throws: ComposerStore.AttachmentError.unreadable) {
      try await store.addAttachment(Data(), name: "empty.txt", mimeType: "text/plain", kind: .file, to: "k", environmentId: nil)
    }
  }

  @Test("drafts and unsent messages survive a relaunch; a message caught mid-send resends with its id")
  func persistence() async throws {
    let directory = Self.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let offline = FakeComposerSink()
    offline.connected = false
    let first = await makeStore(offline, directory: directory)
    first.setText("Draft text", for: "other")
    first.setText("Unsent", for: ref.key)
    let message = try #require(first.send(ref.key, to: ref, delivery: .steer, thread: settings))
    first.remember(ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5", options: [.init(id: "effort", value: "low")]))
    await first.flush()

    let sink = FakeComposerSink()
    let second = await makeStore(sink, directory: directory)
    #expect(second.draft("other").text == "Draft text")
    await second.idle()
    #expect(sink.messages.map(\.commandId.rawValue) == [message.commandId])
    #expect(sink.messages.first?.delivery == .steer)
    #expect(second.memory.options.applying(to: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5")).options == [
      .init(id: "effort", value: "low")
    ])
  }

  @Test("deleting a queued message removes it before it sends")
  func deleteQueued() async throws {
    let sink = FakeComposerSink()
    sink.connected = false
    let store = await makeStore(sink)
    store.setText("Nope", for: ref.key)
    let message = try #require(store.send(ref.key, to: ref, delivery: .start, thread: settings))
    store.delete(message.messageId)
    sink.connected = true
    store.wake()
    await store.idle()
    #expect(sink.sent.isEmpty)
    #expect(store.outbox.isEmpty)
  }
}

@Suite("Model catalog")
struct ModelCatalogTests {
  struct Catalog: Decodable {
    var providers: LossyArray<ServerProvider>
    var settings: ServerSettings
  }

  /// Encoded by the server's own schemas (`check-schemas.mjs`).
  static func catalog() throws -> (providers: [ServerProvider], settings: ServerSettings) {
    let catalog = try JSONDecoder().decode(Catalog.self, from: Fixture.data("provider-catalog"))
    return (catalog.providers.elements, catalog.settings)
  }

  @Test("providers and settings decode from the server's encoding")
  func decodes() throws {
    let (providers, settings) = try Self.catalog()
    #expect(providers.map(\.instanceId) == ["claudeAgent", "devReplay", "codex"])
    #expect(providers[0].supportedRuntimeModes == [.approvalRequired, .auto, .fullAccess])
    #expect(providers[0].continuationGroupKey == "claude")
    #expect(providers[2].label == "Codex")
    #expect(providers[2].isSelectable == false)
    #expect(settings.defaultRuntimeMode == .auto)
    #expect(settings.hiddenModels["claudeAgent"] == ["claude-haiku-5-5"])
    let effort = try #require(ModelCatalog.reasoning(providers[0].models[0].optionDescriptors))
    #expect(effort.selectableChoices.map(\.id) == ["low", "medium", "high", "xhigh"])
    #expect(ModelCatalog.currentValue(effort, in: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5")) == "high")
  }

  @Test("the picker lists selectable providers, hides hidden and legacy models, keeps the current one")
  func groups() throws {
    let (providers, settings) = try Self.catalog()
    let groups = ModelCatalog.groups(providers: providers, settings: settings)
    #expect(groups.map(\.instanceId) == ["claudeAgent", "devReplay"])
    #expect(groups[0].models.map(\.model.slug) == ["claude-opus-5-5", "claude-sonnet-5-5"])
    let current = ModelSelection(instanceId: "claudeAgent", model: "claude-haiku-5-5")
    let withCurrent = ModelCatalog.groups(providers: providers, settings: settings, current: current)
    #expect(withCurrent[0].models.map(\.model.slug).contains("claude-haiku-5-5"))
    let locked = ModelCatalog.groups(providers: providers, settings: settings, locked: "claudeAgent")
    #expect(locked.map(\.instanceId) == ["claudeAgent"])
  }

  @Test("a new thread takes the draft, project, sticky, server default, then the first model")
  func newThreadSelection() throws {
    let (providers, settings) = try Self.catalog()
    let replay = ModelSelection(instanceId: "devReplay", model: "replay")
    let gone = ModelSelection(instanceId: "codex", model: "gpt-5.4")
    func pick(draft: ModelSelection? = nil, project: ModelSelection? = nil, sticky: ModelSelection? = nil) -> String? {
      ModelCatalog.newThreadSelection(draft: draft, projectDefault: project, sticky: sticky, providers: providers, settings: settings)?.model
    }
    #expect(pick(draft: replay) == "replay")
    #expect(pick(project: gone, sticky: replay) == "replay")
    #expect(pick() == "claude-sonnet-5-5")
    var noDefault = settings
    noDefault.defaultModelSelection = nil
    #expect(ModelCatalog.newThreadSelection(draft: nil, projectDefault: nil, sticky: nil, providers: providers, settings: noDefault)?.model == "claude-opus-5-5")
  }

  @Test("labels show the short name and the effort choice")
  func labels() throws {
    let (providers, _) = try Self.catalog()
    let selection = ModelCatalog.setting("effort", to: "xhigh", in: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5"))
    let label = ModelCatalog.label(for: selection, providers: providers)
    #expect(label.model == "Opus 5.5")
    #expect(label.effort == "Extra high")
    #expect(ModelCatalog.runtimeModes(for: providers[0]) == [.approvalRequired, .auto, .fullAccess])
    #expect(ModelCatalog.runtimeModes(for: providers[1]) == RuntimeMode.allCases)
  }

  @Test("config events decode providers and settings, and anything unreadable is ignorable")
  func configEvents() throws {
    let providers = #"{"version":1,"type":"providerStatuses","payload":{"providers":[{"instanceId":"x","driver":"codex","models":"oops"},{"bad":1}]}}"#
    guard case .providers(let list) = try decode(ServerConfigEvent.self, json: providers) else {
      Issue.record("not providers")
      return
    }
    #expect(list.map(\.instanceId) == ["x"])
    #expect(list[0].models.isEmpty)
    let broken = #"{"version":1,"type":"settingsUpdated","payload":"nope"}"#
    guard case .other = try decode(ServerConfigEvent.self, json: broken) else {
      Issue.record("a broken settings event must not throw")
      return
    }
    guard case .other = try decode(ServerConfigEvent.self, json: #"{"version":1,"type":"holograms"}"#) else {
      Issue.record("unknown type")
      return
    }
  }
}

@Suite("Composer send rules")
struct ComposerSendRuleTests {
  func projection(runs: [Run], messages: [String] = []) -> ThreadProjection {
    var projection = Make.projection(runs: runs)
    projection.messages = try! messages.map { id in
      try decode(ConversationMessage.self, json: #"{"id":"\#(id)","role":"user","text":"Queued \#(id)","attachments":[{"type":"image"}]}"#)
    }
    return projection
  }

  @Test("the button sends when idle, stops when empty and working, steers or queues with text")
  func primary() {
    let idle = ThreadRunActivity.idle
    #expect(ComposerPrimaryAction.resolve(hasContent: false, activity: idle) == .send(enabled: false))
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: idle) == .send(enabled: true))
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: idle, blocked: true) == .send(enabled: false))
    let running = ThreadRunActivity(activeRunId: "r", activeRunStatus: .running)
    #expect(ComposerPrimaryAction.resolve(hasContent: false, activity: running) == .stop)
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: running) == .steer)
    let starting = ThreadRunActivity(activeRunId: "r", activeRunStatus: .starting)
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: starting) == .queue)
    #expect(ComposerPrimaryAction.resolve(hasContent: true, activity: running, editingQueued: true) == .update)
  }

  @Test("activity names the active run and the user's queue in order")
  func activity() throws {
    var first = Run(id: "q1", status: .queued)
    first.userMessageId = "m1"
    first.queuePosition = 2
    var second = Run(id: "q2", status: .queued)
    second.userMessageId = "m2"
    second.queuePosition = 1
    let active = Run(id: "a", status: .running)
    let activity = ThreadRunActivity.derive(projection(runs: [Make.run("done"), active, first, second], messages: ["m1", "m2"]))
    #expect(activity.activeRunId == "a")
    #expect(activity.queued.map(\.runId) == ["q2", "q1"])
    #expect(activity.queued.first?.text == "Queued m2")
    #expect(activity.queued.first?.attachmentCount == 1)
    #expect(ThreadRunActivity.derive(projection(runs: [Make.run("done")])).isRunning == false)
  }
}

@Suite("Image fitting")
struct ImageFittingTests {
  static func image(width: Int, height: Int, type: String) throws -> Data {
    let context = try #require(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let output = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(output, type as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return output as Data
  }

  @Test("a small PNG keeps its bytes")
  func keeps() async throws {
    let data = try Self.image(width: 400, height: 300, type: "public.png")
    let fitted = try await ImageFitting.fit(data, mimeType: "image/png")
    #expect(fitted.data == data)
    #expect(fitted.mimeType == "image/png")
  }

  @Test("a PNG over 2000 px scales to 2000 on its long edge and stays PNG")
  func scales() async throws {
    let fitted = try await ImageFitting.fit(try Self.image(width: 3000, height: 1500, type: "public.png"), mimeType: "image/png")
    #expect(fitted.mimeType == "image/png")
    #expect(fitted.pixelSize == CGSize(width: 2000, height: 1000))
  }

  @Test("a type the server does not take becomes JPEG")
  func converts() async throws {
    let fitted = try await ImageFitting.fit(try Self.image(width: 64, height: 64, type: "public.tiff"), mimeType: "image/tiff")
    #expect(fitted.mimeType == "image/jpeg")
    #expect(fitted.pixelSize == CGSize(width: 64, height: 64))
  }

  @Test("bytes that are no image are refused")
  func unreadable() async {
    await #expect(throws: ImageFitting.Failure.self) { try await ImageFitting.fit(Data("nope".utf8), mimeType: "image/png") }
  }
}

@Suite("Thread seeding")
struct ThreadSeedTests {
  @Test("a launched thread's projection seeds the sync, so the first attach resumes after it")
  func seed() async throws {
    let sync = ThreadDetailSync(threadId: Make.threadId, interval: .zero)
    await sync.seed(Make.projection(items: [Make.user("m1")]), sequence: 7)
    #expect(await sync.subscription().afterSequence == 7)
    #expect(await sync.current.messageIds.contains("m1"))
    #expect(await sync.current.isLoaded)
    // A later seed never replaces what the stream delivered.
    await sync.seed(Make.projection(), sequence: 1)
    #expect(await sync.subscription().afterSequence == 7)
  }
}
