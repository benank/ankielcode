import Foundation
import Observation

/// Everything the composers hold: per-thread drafts with their attachments, uploads, the outbox
/// and the option memory. Persisted to one JSON file (attachment bytes beside it), so drafts and
/// unsent messages survive a relaunch.
///
/// Delivery mirrors the RN outbox (`threadOutboxDelivery.ts`): one message at a time per thread, in
/// order; a lost connection or a dropped reply retries with the same command id (the server
/// answers a repeat from its receipt); a refusal marks the message failed for the user to retry,
/// edit or delete.
@MainActor @Observable
public final class ComposerStore {
  public private(set) var drafts: [String: ComposerDraft] = [:]
  public private(set) var outbox: [OutboxMessage] = []
  /// By `uploadKey(environmentId, attachmentId)`.
  public private(set) var uploads: [String: UploadState] = [:]
  public private(set) var memory = Memory()
  public private(set) var isLoaded = false

  public struct Memory: Sendable, Hashable, Codable {
    public var options = ModelOptionMemory()
    /// The last pick a new thread was sent with (RN's sticky selection).
    public var lastModelSelection: ModelSelection?
    public var lastRuntimeMode: RuntimeMode?
  }

  public enum AttachmentError: Error, Sendable, Hashable {
    case tooMany
    case tooLarge(isImage: Bool)
    case unreadable
  }

  /// Where commands go. Set by the app (the registry) or a test.
  @ObservationIgnored public var sink: (any ComposerSink)?
  /// The folder holding `composer.json` and `files/`; nil keeps everything in memory.
  @ObservationIgnored public let directory: URL?
  /// Delay before retry `attempt` (1, 2, 4, 8, 16 s).
  @ObservationIgnored public var retryDelay: @Sendable (Int) -> Duration = { attempt in
    .seconds(min(16, 1 << min(attempt, 4)))
  }
  /// Copy for title seeds (the app passes localized labels).
  @ObservationIgnored public var titleLabels = ThreadTitleSeed.Labels()
  /// Transport failures (not "offline") before a message shows as failed.
  @ObservationIgnored public var maxTransportAttempts = 6
  /// RN's `MESSAGE_DISPATCH_TIMEOUT`: a live socket can carry a message the computer never
  /// answers, which would hold the thread's outbox forever. A dispatch that takes longer counts as
  /// a transport failure: it resends with the same command id (the server answers a repeat from its
  /// receipt if the first one landed) and, after `maxTransportAttempts`, shows Retry.
  @ObservationIgnored public var sendTimeout: Duration = .seconds(60)
  /// Shown on a message that timed out (the app passes localized copy).
  @ObservationIgnored public var sendTimeoutMessage = "The computer did not confirm the message within 60 seconds."

  @ObservationIgnored private var uploadTasks: [String: Task<String, any Error>] = [:]
  @ObservationIgnored private var deliveries: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var wakeSignals: [String: (token: UUID, continuation: CheckedContinuation<Void, Never>)] = [:]
  @ObservationIgnored private var lastSave: Task<Void, Never>?
  @ObservationIgnored private var pendingSave: Task<Void, Never>?

  public init(directory: URL?, sink: (any ComposerSink)? = nil) {
    self.directory = directory
    self.sink = sink
  }

  var filesDirectory: URL {
    (directory ?? URL.temporaryDirectory.appending(path: "ankiel-composer", directoryHint: .isDirectory))
      .appending(path: "files", directoryHint: .isDirectory)
  }

  public func fileURL(_ attachment: DraftAttachment) -> URL {
    filesDirectory.appending(path: attachment.fileName)
  }

  public static func uploadKey(_ environmentId: String, _ attachmentId: String) -> String {
    "\(environmentId)|\(attachmentId)"
  }

  // MARK: Loading and saving

  struct Saved: Codable {
    var drafts: [String: ComposerDraft] = [:]
    var outbox: [OutboxMessage] = []
    var memory = Memory()
  }

  /// Reads the saved state once. Messages the server already accepted are dropped (their thread
  /// shows them); messages caught mid-send go back to the queue and resend with the same id.
  public func load() async {
    guard !isLoaded else { return }
    if let url = directory?.appending(path: "composer.json") {
      let saved: Saved? = await Task.detached {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Saved.self, from: data)
      }.value
      if let saved {
        drafts = saved.drafts
        memory = saved.memory
        outbox = saved.outbox.filter { !$0.state.isSent }.map { message in
          var message = message
          if message.state == .sending { message.state = .queued }
          return message
        }
      }
    }
    isLoaded = true
    wake()
  }

  /// Forgets everything (debug and tests).
  public func reset() {
    for task in uploadTasks.values { task.cancel() }
    for task in deliveries.values { task.cancel() }
    uploadTasks = [:]
    deliveries = [:]
    drafts = [:]
    outbox = []
    uploads = [:]
    memory = Memory()
    if let directory { try? FileManager.default.removeItem(at: directory) }
  }

  private func save() {
    guard let url = directory?.appending(path: "composer.json") else { return }
    pendingSave?.cancel()
    pendingSave = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard let self, !Task.isCancelled else { return }
      self.writeNow(to: url)
    }
  }

  /// Writes immediately (also used when the app goes to the background).
  public func flush() async {
    guard let url = directory?.appending(path: "composer.json") else { return }
    pendingSave?.cancel()
    writeNow(to: url)
    await lastSave?.value
  }

  private func writeNow(to url: URL) {
    let saved = Saved(drafts: drafts.filter { !$0.value.isEmpty }, outbox: outbox, memory: memory)
    let previous = lastSave
    lastSave = Task.detached {
      await previous?.value
      guard let data = try? JSONEncoder().encode(saved) else { return }
      try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? data.write(to: url, options: .atomic)
    }
  }

  // MARK: Drafts

  public func draft(_ key: String) -> ComposerDraft { drafts[key] ?? ComposerDraft() }

  public func updateDraft(_ key: String, _ change: (inout ComposerDraft) -> Void) {
    var draft = drafts[key] ?? ComposerDraft()
    change(&draft)
    guard draft != drafts[key] else { return }
    drafts[key] = draft.isEmpty ? nil : draft
    save()
  }

  public func setText(_ text: String, for key: String) {
    updateDraft(key) { $0.text = text }
  }

  /// Copies bytes into the composer's files and adds them to the draft; uploads start at once when
  /// the computer is connected.
  @discardableResult
  public func addAttachment(
    _ data: Data, name: String, mimeType: String, kind: DraftAttachment.Kind, to key: String, environmentId: String?
  ) async throws(AttachmentError) -> DraftAttachment {
    let current = draft(key).attachments
    guard current.count < AttachmentLimits.maxAttachments else { throw .tooMany }
    guard !data.isEmpty else { throw .unreadable }
    switch kind {
    case .image:
      let total = current.filter { $0.kind == .image }.reduce(0) { $0 + $1.sizeBytes } + data.count
      guard data.count <= AttachmentLimits.maxImageBytes, total <= AttachmentLimits.maxTotalImageBytes else {
        throw .tooLarge(isImage: true)
      }
    case .file:
      guard data.count <= AttachmentLimits.maxFileBytes else { throw .tooLarge(isImage: false) }
    }
    let id = UUID().uuidString.lowercased()
    let ext = (name as NSString).pathExtension
    let fileName = ext.isEmpty ? id : "\(id).\(ext)"
    let url = filesDirectory.appending(path: fileName)
    let folder = filesDirectory
    let written = await Task.detached {
      do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return true
      } catch {
        return false
      }
    }.value
    guard written else { throw .unreadable }
    let attachment = DraftAttachment(
      id: id, kind: kind, name: Self.safeName(name), mimeType: mimeType, sizeBytes: data.count, fileName: fileName)
    updateDraft(key) { $0.attachments.append(attachment) }
    if let environmentId { startUpload(attachment, environmentId: environmentId) }
    return attachment
  }

  /// Removes an attachment: stops its upload, deletes what reached the server and the local copy.
  public func removeAttachment(_ id: String, from key: String) {
    guard let attachment = draft(key).attachments.first(where: { $0.id == id }) else { return }
    updateDraft(key) { $0.attachments.removeAll { $0.id == id } }
    for (uploadKey, task) in uploadTasks where uploadKey.hasSuffix("|\(id)") {
      task.cancel()
      uploadTasks[uploadKey] = nil
    }
    for uploadKey in uploads.keys where uploadKey.hasSuffix("|\(id)") {
      if case .ready(let attachmentId) = uploads[uploadKey], let sink {
        let environmentId = String(uploadKey.prefix { $0 != "|" })
        Task { await sink.discardUpload(attachmentId, in: environmentId) }
      }
      uploads[uploadKey] = nil
    }
    deleteFileIfUnused(attachment)
  }

  /// Uploads every attachment of a draft that is not on `environmentId` yet (after a reconnect or
  /// a change of computer).
  public func startUploads(for key: String, environmentId: String) {
    for attachment in draft(key).attachments where attachment.uploadedId(in: environmentId) == nil {
      startUpload(attachment, environmentId: environmentId)
    }
  }

  public func retryUpload(_ id: String, in key: String, environmentId: String) {
    guard let attachment = draft(key).attachments.first(where: { $0.id == id }) else { return }
    uploads[Self.uploadKey(environmentId, id)] = nil
    startUpload(attachment, environmentId: environmentId)
  }

  public func uploadState(_ attachment: DraftAttachment, environmentId: String?) -> UploadState? {
    guard let environmentId else { return nil }
    if let id = attachment.uploadedId(in: environmentId) { return .ready(attachmentId: id) }
    return uploads[Self.uploadKey(environmentId, attachment.id)]
  }

  /// RN `composerAttachmentUploadBlockReason`: a failed upload blocks sending until it is retried
  /// or removed; one still uploading does not (the outbox waits for it).
  public func hasFailedUpload(_ key: String, environmentId: String?) -> Bool {
    draft(key).attachments.contains { attachment in
      if case .failed? = uploadState(attachment, environmentId: environmentId) { true } else { false }
    }
  }

  private func startUpload(_ attachment: DraftAttachment, environmentId: String) {
    let key = Self.uploadKey(environmentId, attachment.id)
    guard uploadTasks[key] == nil, attachment.uploadedId(in: environmentId) == nil, sink?.canSend(to: environmentId) == true
    else { return }
    Task { _ = try? await upload(attachment, environmentId: environmentId) }
  }

  /// The attachment's id on `environmentId`, uploading it (once) when needed.
  func upload(_ attachment: DraftAttachment, environmentId: String) async throws(EnvironmentRequestError) -> String {
    if let id = attachment.uploadedId(in: environmentId) { return id }
    let key = Self.uploadKey(environmentId, attachment.id)
    if case .ready(let id)? = uploads[key] { return id }
    guard let sink else { throw .notConnected }
    let task: Task<String, any Error>
    if let running = uploadTasks[key] {
      task = running
    } else {
      let file = UploadFile(
        url: fileURL(attachment), kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes)
      uploads[key] = .uploading(0)
      let progress: @Sendable (Double) -> Void = { [weak self] fraction in
        Task { @MainActor in self?.reportProgress(fraction, key: key) }
      }
      task = Task { try await sink.upload(file, in: environmentId, progress: progress) }
      uploadTasks[key] = task
    }
    do {
      let id = try await task.value
      uploadTasks[key] = nil
      uploads[key] = .ready(attachmentId: id)
      recordUpload(attachment.id, environmentId: environmentId, attachmentId: id)
      return id
    } catch {
      uploadTasks[key] = nil
      if error is CancellationError || Task.isCancelled {
        uploads[key] = nil
        throw .failed("Cancelled.")
      }
      let failure = EnvironmentRequestError(error)
      if case .notConnected = failure {
        uploads[key] = nil
      } else if case .rejected(let message, _) = failure {
        uploads[key] = .failed(message ?? "")
      } else if case .failed(let message) = failure {
        uploads[key] = .failed(message)
      }
      throw failure
    }
  }

  private func reportProgress(_ fraction: Double, key: String) {
    guard case .uploading(let current)? = uploads[key] else { return }
    // Coarse steps: the chip shows a ring, and per-byte updates would re-render it constantly.
    let stepped = (fraction * 20).rounded(.down) / 20
    if stepped > current { uploads[key] = .uploading(min(stepped, 0.99)) }
  }

  private func recordUpload(_ id: String, environmentId: String, attachmentId: String) {
    let uploaded = DraftAttachment.Uploaded(environmentId: environmentId, attachmentId: attachmentId)
    var changed = false
    for (key, draft) in drafts where draft.attachments.contains(where: { $0.id == id }) {
      drafts[key]?.attachments = draft.attachments.map { attachment in
        var attachment = attachment
        if attachment.id == id { attachment.uploaded = uploaded }
        return attachment
      }
      changed = true
    }
    for index in outbox.indices where outbox[index].attachments.contains(where: { $0.id == id }) {
      outbox[index].attachments = outbox[index].attachments.map { attachment in
        var attachment = attachment
        if attachment.id == id { attachment.uploaded = uploaded }
        return attachment
      }
      changed = true
    }
    if changed { save() }
  }

  private func deleteFileIfUnused(_ attachment: DraftAttachment) {
    let inUse =
      drafts.values.contains { $0.attachments.contains { $0.id == attachment.id } }
      || outbox.contains { $0.attachments.contains { $0.id == attachment.id } }
    guard !inUse else { return }
    let url = fileURL(attachment)
    Task.detached { try? FileManager.default.removeItem(at: url) }
  }

  static func safeName(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let base = trimmed.isEmpty ? "attachment" : trimmed
    return String(base.prefix(255))
  }

  // MARK: Model options

  public func remember(_ selection: ModelSelection) {
    var options = memory.options
    options.remember(selection)
    guard options != memory.options else { return }
    memory.options = options
    save()
  }

  public func rememberNewThread(model: ModelSelection?, runtimeMode: RuntimeMode?) {
    memory.lastModelSelection = model ?? memory.lastModelSelection
    memory.lastRuntimeMode = runtimeMode ?? memory.lastRuntimeMode
    save()
  }

  // MARK: Sending

  /// What the thread is set to now, to decide which settings commands go first.
  public struct ThreadSettings: Sendable, Hashable {
    public var modelSelection: ModelSelection?
    public var runtimeMode: RuntimeMode?
    public var interactionMode: InteractionMode?

    public init(modelSelection: ModelSelection?, runtimeMode: RuntimeMode?, interactionMode: InteractionMode?) {
      self.modelSelection = modelSelection
      self.runtimeMode = runtimeMode
      self.interactionMode = interactionMode
    }
  }

  /// Moves the draft into the outbox and starts delivering it. Returns nil when there is nothing
  /// to send or a failed upload blocks it. The draft keeps its model and mode picks.
  @discardableResult
  public func send(
    _ key: String, to ref: ThreadRef, delivery: MessageDelivery, thread: ThreadSettings,
    creation: OutboxMessage.Creation? = nil
  ) -> OutboxMessage? {
    let draft = draft(key)
    guard draft.hasContent, draft.text.count <= AttachmentLimits.maxTextCharacters,
      !hasFailedUpload(key, environmentId: ref.environmentId)
    else { return nil }
    let model = draft.modelSelection ?? thread.modelSelection
    let runtimeMode: RuntimeMode? =
      creation != nil ? (draft.runtimeMode ?? thread.runtimeMode) : draft.runtimeMode.flatMap { $0 == thread.runtimeMode ? nil : $0 }
    let interactionMode: InteractionMode? =
      creation == nil && thread.interactionMode != nil && thread.interactionMode != .default ? .default : nil
    let message = OutboxMessage(
      environmentId: ref.environmentId, threadId: ref.threadId,
      text: draft.text.trimmingCharacters(in: .whitespacesAndNewlines), attachments: draft.attachments,
      modelSelection: model, runtimeMode: runtimeMode, interactionMode: interactionMode,
      delivery: creation == nil ? delivery : .start, creation: creation)
    var queued = message
    if creation == nil, draft.freshContext == true { queued.freshContext = true }
    outbox.append(queued)
    if creation != nil {
      drafts[key] = nil
      rememberNewThread(model: model, runtimeMode: runtimeMode)
    } else {
      updateDraft(key) { draft in
        draft.text = ""
        draft.attachments = []
        draft.runtimeMode = nil
        draft.freshContext = nil
      }
    }
    save()
    deliver(queued.threadKey)
    return queued
  }

  /// Messages to show in a thread's feed: everything not yet in the server's projection.
  public func pending(_ threadKey: String, known: Set<String>) -> [OutboxMessage] {
    outbox.filter { $0.threadKey == threadKey && !known.contains($0.messageId) }
  }

  /// Drops accepted messages the feed now shows.
  public func reconcile(_ threadKey: String, known: Set<String>) {
    let seen = outbox.filter { $0.threadKey == threadKey && $0.state.isSent && known.contains($0.messageId) }
    guard !seen.isEmpty else { return }
    outbox.removeAll { message in seen.contains { $0.messageId == message.messageId } }
    for attachment in seen.flatMap(\.attachments) { deleteFileIfUnused(attachment) }
    save()
  }

  /// A new thread whose launch the server has not accepted yet (its stream would not open).
  public func isAwaitingCreation(_ ref: ThreadRef) -> Bool {
    outbox.contains { $0.threadKey == ref.key && $0.creation != nil && !$0.state.isSent }
  }

  public func failedCreation(_ ref: ThreadRef) -> OutboxMessage? {
    outbox.first { $0.threadKey == ref.key && $0.creation != nil && $0.state.isFailed }
  }

  public func retry(_ messageId: String) {
    guard let index = outbox.firstIndex(where: { $0.messageId == messageId }),
      case .failed(_, let sameCommand) = outbox[index].state
    else { return }
    if !sameCommand { outbox[index].commandId = UUID().uuidString.lowercased() }
    outbox[index].state = .queued
    save()
    deliver(outbox[index].threadKey)
  }

  // MARK: Client storage

  /// Drafts that hold text or attachments.
  public var draftCount: Int { drafts.values.filter(\.hasContent).count }

  /// Bytes of attachment copies kept for drafts and unsent messages.
  public func attachmentBytes() async -> Int64 {
    let directory = filesDirectory
    return await Task.detached {
      let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
      return urls.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }.value
  }

  /// Empties every composer's text and attachments (model picks stay); copies unsent messages
  /// still use are kept.
  public func clearDrafts() {
    for (key, draft) in drafts where draft.hasContent {
      for attachment in draft.attachments { removeAttachment(attachment.id, from: key) }
      setText("", for: key)
    }
  }

  public func delete(_ messageId: String) {
    guard let index = outbox.firstIndex(where: { $0.messageId == messageId }), !outbox[index].state.isSent,
      outbox[index].state != .sending
    else { return }
    let message = outbox.remove(at: index)
    for attachment in message.attachments { deleteFileIfUnused(attachment) }
    save()
  }

  /// Puts a failed message back in its composer (`key`) for editing.
  public func restoreToDraft(_ messageId: String, key: String) {
    guard let index = outbox.firstIndex(where: { $0.messageId == messageId }), outbox[index].state.isFailed else { return }
    let message = outbox.remove(at: index)
    updateDraft(key) { draft in
      draft.text = draft.text.isEmpty ? message.text : message.text + "\n\n" + draft.text
      draft.attachments = message.attachments + draft.attachments
      if let creation = message.creation {
        draft.projectId = creation.projectId
        draft.modelSelection = message.modelSelection
        draft.runtimeMode = message.runtimeMode
      }
    }
    save()
  }

  /// Retries every waiting message now (a computer connected, the app came back).
  public func wake() {
    for message in outbox where message.state == .queued || message.state == .sending {
      deliver(message.threadKey)
    }
    let signals = wakeSignals.values
    wakeSignals = [:]
    for signal in signals { signal.continuation.resume() }
  }

  /// Waits for the next send (tests).
  public func idle() async {
    while let task = deliveries.values.first { await task.value }
  }

  // MARK: Delivery

  private func deliver(_ threadKey: String) {
    guard isLoaded, deliveries[threadKey] == nil else { return }
    deliveries[threadKey] = Task { [weak self] in
      await self?.drain(threadKey)
      self?.deliveries[threadKey] = nil
    }
  }

  private func drain(_ threadKey: String) async {
    var attempt = 0
    while !Task.isCancelled {
      guard let head = outbox.first(where: { $0.threadKey == threadKey && ($0.state == .queued || $0.state == .sending) })
      else { return }
      guard let sink, sink.canSend(to: head.environmentId) else {
        if outbox[index(head)].state != .queued { setState(head.messageId, .queued) }
        // Waits for a wake (a connection) or polls slowly.
        await sleepOrWake(threadKey, .seconds(16))
        continue
      }
      setState(head.messageId, .sending)
      switch await send(head, sink: sink) {
      case .accepted(let sequence):
        attempt = 0
        setState(head.messageId, .sent(sequence: sequence))
      case .refused(let message):
        attempt = 0
        setState(head.messageId, .failed(message: message, retriesSameCommand: false))
      case .transport(let message):
        attempt += 1
        if attempt >= maxTransportAttempts {
          attempt = 0
          setState(head.messageId, .failed(message: message, retriesSameCommand: true))
        } else {
          setState(head.messageId, .queued)
          await sleepOrWake(threadKey, retryDelay(attempt))
        }
      case .offline:
        setState(head.messageId, .queued)
        await sleepOrWake(threadKey, retryDelay(max(attempt, 1)))
      }
    }
  }

  private enum Outcome {
    case accepted(Int?)
    case refused(String?)
    case transport(String?)
    case offline
  }

  private func send(_ message: OutboxMessage, sink: any ComposerSink) async -> Outcome {
    let environmentId = message.environmentId
    var attachments: [ChatAttachment] = []
    for attachment in message.attachments {
      do {
        let id = try await upload(attachment, environmentId: environmentId)
        attachments.append(attachment.chatAttachment(id: id))
      } catch {
        return outcome(error)
      }
    }
    // The user may have deleted it while attachments uploaded.
    guard outbox.contains(where: { $0.messageId == message.messageId }) else { return .accepted(nil) }
    // RN times out message dispatches only; a launch waits for its answer.
    if message.creation != nil { return await dispatch(message, attachments: attachments) }
    return await firstOf(timeout: sendTimeout, else: .transport(sendTimeoutMessage)) { [weak self] in
      await self?.dispatch(message, attachments: attachments) ?? .offline
    }
  }

  /// `work`'s outcome, or `fallback` if it takes longer than `timeout`. The send keeps running; a
  /// late answer is ignored (the resend carries the same command id).
  private func firstOf(
    timeout: Duration, else fallback: Outcome, _ work: @escaping @MainActor () async -> Outcome
  ) async -> Outcome {
    let once = Once()
    return await withCheckedContinuation { continuation in
      once.continuation = continuation
      let timer = Task { @MainActor in
        try? await Task.sleep(for: timeout)
        if !Task.isCancelled { once.resume(fallback) }
      }
      Task { @MainActor in
        let outcome = await work()
        timer.cancel()
        once.resume(outcome)
      }
    }
  }

  @MainActor private final class Once {
    var continuation: CheckedContinuation<Outcome, Never>?
    func resume(_ outcome: Outcome) {
      continuation?.resume(returning: outcome)
      continuation = nil
    }
  }

  private func dispatch(_ message: OutboxMessage, attachments: [ChatAttachment]) async -> Outcome {
    let environmentId = message.environmentId
    guard let sink else { return .offline }
    do {
      if let creation = message.creation {
        guard let model = message.modelSelection else { return .refused(nil) }
        let launch = ThreadLaunch(
          commandId: CommandID(message.commandId), threadId: message.threadId, projectId: creation.projectId,
          title: creation.title, modelSelection: model, runtimeMode: message.runtimeMode ?? .auto,
          messageId: message.messageId, text: message.text, attachments: attachments)
        let result = try await sink.launch(launch, in: environmentId)
        sink.threadLaunched(result, in: environmentId)
        return .accepted(result.sequence)
      }
      if let mode = message.runtimeMode {
        _ = try await sink.send(
          ThreadCommand(.setRuntimeMode(mode), threadId: message.threadId, commandId: CommandID("\(message.commandId):runtime-mode")),
          in: environmentId)
      }
      if let mode = message.interactionMode {
        _ = try await sink.send(
          ThreadCommand(
            .setInteractionMode(mode), threadId: message.threadId, commandId: CommandID("\(message.commandId):interaction-mode")),
          in: environmentId)
      }
      let dispatch = MessageDispatch(
        commandId: CommandID(message.commandId), threadId: message.threadId, messageId: message.messageId, text: message.text,
        attachments: attachments, modelSelection: message.modelSelection,
        titleSeed: ThreadTitleSeed.make(text: message.text, attachments: attachments, labels: titleLabels), delivery: message.delivery,
        freshContext: message.freshContext == true)
      return .accepted(try await sink.send(dispatch, in: environmentId))
    } catch {
      return outcome(error)
    }
  }

  private func outcome(_ error: EnvironmentRequestError) -> Outcome {
    switch error {
    case .notConnected: .offline
    case .rejected(let message, _): .refused(message)
    case .failed(let message): .transport(message)
    }
  }

  private func index(_ message: OutboxMessage) -> Int {
    outbox.firstIndex { $0.messageId == message.messageId } ?? 0
  }

  private func setState(_ messageId: String, _ state: OutboxMessage.State) {
    guard let index = outbox.firstIndex(where: { $0.messageId == messageId }), outbox[index].state != state else { return }
    outbox[index].state = state
    save()
  }

  private func sleepOrWake(_ threadKey: String, _ delay: Duration) async {
    let token = UUID()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      wakeSignals.removeValue(forKey: threadKey)?.continuation.resume()
      wakeSignals[threadKey] = (token, continuation)
      Task { [weak self] in
        try? await Task.sleep(for: delay)
        self?.endWait(threadKey, token: token)
      }
    }
  }

  private func endWait(_ threadKey: String, token: UUID) {
    guard wakeSignals[threadKey]?.token == token else { return }
    wakeSignals.removeValue(forKey: threadKey)?.continuation.resume()
  }
}
