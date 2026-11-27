import Foundation

/// Where one thread's stream items come from: a live session, or a fixture replay in debug builds.
/// Both run through the same sync, so the fixture exercises the real decode-reduce-derive path.
public protocol ThreadItemSource: Sendable {
  func threadItems(_ subscription: ThreadSubscription) async throws -> RpcStream<ThreadStreamItem>
}

/// What the thread screen renders.
public struct ThreadDetailState: Sendable, Equatable {
  public enum Phase: Sendable, Hashable {
    /// Nothing held yet.
    case loading
    /// Rows are from the snapshot or cache; the stream has not caught up yet.
    case synchronizing
    case live
    /// The stream is not running (no session, or the screen closed); rows may be behind.
    case stale
    case deleted
    /// The server refused the subscription (for example, no such thread), with its own words
    /// when it sent any.
    case unavailable(String?)
    /// The snapshot arrived but this client could not read it.
    case unreadable
  }

  public var phase: Phase = .loading
  public var timeline: ThreadTimeline = .empty
  public var title: String?
  public var projectId: String?
  public var parentThreadId: String?
  /// The active run and the user's queued messages (the composer's send rules).
  public var activity = ThreadRunActivity.idle
  /// The thread's model pick, for the composer when the shell row is not loaded.
  public var threadSelection: ModelSelection?
  /// Every message id the projection holds, so the outbox can hide what the server already shows.
  public var messageIds: Set<String> = []
  /// What the thread waits on the user for (approvals, questions, secrets).
  public var pending = PendingThreadRequests.none
  /// How each request ended, for every request the thread ever held that is no longer pending,
  /// so a card on screen can tell "answered elsewhere" from "expired".
  public var outcomes: [String: RequestOutcome] = [:]
  /// Bumped on every publish that changed the timeline.
  public var revision = 0
  /// The turns with changes to review, newest first.
  public var turnChanges: [TurnChange] = []

  public init() {}

  public var isLoaded: Bool { revision > 0 }
}

/// Follows one thread: subscribes from the held cursor, reduces and derives the timeline off the
/// main actor, and publishes coalesced states (at most one per `interval`, so streaming text never
/// re-lays the feed out per token). The projection and cursor outlive the stream: `detach` stops
/// the subscription (the server stops counting this client as a viewer) but keeps both, so the
/// next `attach` resumes with `afterSequence` instead of a cold snapshot.
public actor ThreadDetailSync {
  public nonisolated let threadId: String
  /// The latest state; older values are dropped if the reader falls behind.
  public nonisolated let states: AsyncStream<ThreadDetailState>

  /// The last applied sequence; only ever set together with the data it covers.
  public private(set) var sequence: Int?
  public private(set) var projection: ThreadProjection?
  public private(set) var lastSubscription: ThreadSubscription?
  /// Items skipped for being unreadable or unknown (diagnostics).
  public private(set) var skippedCount = 0
  /// States published so far (tests: coalescing).
  public private(set) var publishCount = 0

  private var state = ThreadDetailState()
  private let sink: AsyncStream<ThreadDetailState>.Continuation
  private let parser: MarkdownParser
  private let timelineCache = TimelineCache()
  private let interval: Duration
  private let clock = ContinuousClock()
  private var lastPublish: ContinuousClock.Instant?
  private var pendingPublish: Task<Void, Never>?
  private var dirty = false
  private var lastPublished: ThreadDetailState?
  private var follow: Task<Void, Never>?

  public init(threadId: String, style: MarkdownStyle = MarkdownStyle(), interval: Duration = .milliseconds(50)) {
    self.threadId = threadId
    parser = MarkdownParser(style: style)
    self.interval = interval
    (states, sink) = AsyncStream.makeStream(of: ThreadDetailState.self, bufferingPolicy: .bufferingNewest(1))
  }

  /// Follows `source`, replacing any stream already running.
  public func attach(_ source: any ThreadItemSource) {
    follow?.cancel()
    follow = Task { await self.run(source) }
  }

  /// Stops the stream; keeps the projection and cursor for a fast resume.
  public func detach() {
    follow?.cancel()
    follow = nil
    if state.phase == .live || state.phase == .synchronizing {
      state.phase = .stale
      publishNow()
    }
  }

  /// The subscription for the next attach: resume from the cursor when a projection is held.
  func subscription() -> ThreadSubscription {
    ThreadSubscription(threadId: threadId, afterSequence: projection == nil ? nil : sequence)
  }

  private func run(_ source: any ThreadItemSource) async {
    var retryDelay: Duration = .seconds(1)
    while !Task.isCancelled {
      let subscription = subscription()
      lastSubscription = subscription
      if projection != nil, state.phase != .synchronizing {
        state.phase = .synchronizing
        publishNow()
      }
      do {
        for try await item in try await source.threadItems(subscription) {
          if Task.isCancelled { return }
          if apply(item) == .stop { return }
          retryDelay = .seconds(1)
        }
        if Task.isCancelled { return }
      } catch {
        if Task.isCancelled { return }
        // A dead socket belongs to the supervisor, which attaches a new session.
        if case RpcError.connectionClosed = error {
          markStale()
          return
        }
        if case RpcError.failed(let failure) = error {
          state.phase = .unavailable(failure.message)
          publishNow()
          return
        }
      }
      markStale()
      do { try await Task.sleep(for: retryDelay) } catch { return }
      retryDelay = min(retryDelay * 2, .seconds(30))
    }
  }

  enum Outcome { case `continue`, stop }

  /// Applies one item. Synchronous, so the cursor and the data it covers change together.
  func apply(_ item: ThreadStreamItem) -> Outcome {
    switch item {
    case .snapshot(let snapshot):
      var projection = snapshot.projection
      // Keep counting from the held clock so `itemId@revision` keys never repeat.
      projection.revisionClock = self.projection?.revisionClock ?? 0
      projection.stampRevisions()
      self.projection = projection
      sequence = snapshot.snapshotSequence
      if state.phase != .live { state.phase = .synchronizing }
      dirty = true
      // The first rows show at once; later snapshots (a resume that fell back) coalesce.
      if state.revision == 0 { publishNow() } else { schedulePublish() }
    case .synchronized:
      state.phase = .live
      publishNow()
    case .event(let sequence, let event):
      guard sequence > (self.sequence ?? -1) else { return .continue }
      self.sequence = sequence
      if event.type == "thread.deleted" {
        projection = nil
        state.phase = .deleted
        state.timeline = .empty
        publishNow()
        return .stop
      }
      guard var projection else { return .continue }
      if ThreadReducer.apply(event, to: &projection) {
        self.projection = projection
        dirty = true
        schedulePublish()
      }
    case .skipped(let sequence, let reason):
      skippedCount += 1
      if projection == nil, reason.hasPrefix("snapshot") {
        state.phase = .unreadable
        publishNow()
      }
      if let sequence, sequence > (self.sequence ?? -1) { self.sequence = sequence }
    }
    return .continue
  }

  private func markStale() {
    guard state.phase == .live || state.phase == .synchronizing else { return }
    state.phase = .stale
    publishNow()
  }

  // MARK: Publishing

  private func schedulePublish() {
    guard pendingPublish == nil else { return }
    let now = clock.now
    if let last = lastPublish, now - last < interval {
      let wait = interval - (now - last)
      pendingPublish = Task {
        try? await Task.sleep(for: wait)
        self.firePublish()
      }
    } else {
      publishNow()
    }
  }

  private func firePublish() {
    pendingPublish = nil
    publishNow()
  }

  private func publishNow() {
    pendingPublish?.cancel()
    pendingPublish = nil
    lastPublish = clock.now
    if dirty, let projection {
      dirty = false
      let timeline = ThreadTimelineBuilder.build(projection, markdown: parser, cache: timelineCache)
      // Only a change the reader can see counts (it drives follow-to-bottom and the new-content dot).
      if timeline != state.timeline || state.revision == 0 {
        state.timeline = timeline
        state.revision += 1
      }
      state.title = projection.thread.title
      state.projectId = projection.thread.projectId
      state.parentThreadId = projection.thread.lineage?.parentThreadId
      state.activity = ThreadRunActivity.derive(projection)
      state.pending = PendingRequestDerivation.derive(projection)
      state.outcomes = PendingRequestDerivation.outcomes(projection)
      state.threadSelection = projection.thread.modelSelection
      state.turnChanges = TurnChange.derive(projection)
      var ids = Set(projection.messages.map(\.id))
      for row in projection.visibleTurnItems {
        if case .userMessage(let message) = row.item.body { ids.insert(message.messageId) }
      }
      for run in projection.runs { if let id = run.userMessageId { ids.insert(id) } }
      state.messageIds = ids
    }
    guard state != lastPublished else { return }
    lastPublished = state
    publishCount += 1
    sink.yield(state)
  }

  /// Starts from a projection the client already has (a launch result), so the first attach
  /// resumes after `sequence` instead of asking for a snapshot. Ignored once a projection is held.
  public func seed(_ projection: ThreadProjection, sequence: Int) {
    guard self.projection == nil else { return }
    _ = apply(.snapshot(ThreadSnapshot(snapshotSequence: sequence, projection: projection)))
  }

  #if DEBUG
    /// Shows a user message as if the server had sent it (debug builds' fake composer sink).
    public func debugAppendUserMessage(messageId: String, text: String, attachments: [ChatAttachment]) {
      guard var projection else { return }
      let ordinal = (projection.turnItems.map(\.ordinal).max() ?? 0) + 1
      let now = WireTimestamp(Date.now)
      let body = TurnItemBody.UserMessage(messageId: messageId, text: text, inputIntent: .turnStart, attachments: attachments)
      let item = TurnItem(
        id: "turn-item:message:\(messageId)", threadId: threadId, runId: nil, ordinal: ordinal, status: .completed,
        startedAt: now, updatedAt: now, body: .userMessage(body))
      projection.turnItems.append(item)
      projection.visibleTurnItems.append(ProjectedTurnItem(position: projection.visibleTurnItems.count, item: item))
      projection.stampRevisions()
      self.projection = projection
      dirty = true
      publishNow()
    }

    /// Adds a queued run holding a user message (debug builds' fake composer sink).
    public func debugAppendQueuedMessage(runId: String, messageId: String, text: String) {
      guard var projection else { return }
      var run = Run(id: runId, status: .queued)
      run.userMessageId = messageId
      run.queuePosition = projection.runs.count
      projection.runs.append(run)
      let json = try? JSONEncoder().encode(["id": messageId, "role": "user", "text": text])
      if let json, let message = try? JSONDecoder().decode(ConversationMessage.self, from: json) {
        projection.messages.append(message)
      }
      self.projection = projection
      dirty = true
      publishNow()
    }

    /// Ends a request as if the server had (debug builds' fake sink and resolve-elsewhere hook):
    /// the runtime request leaves pending and its item settles; answers show in the resolved row.
    public func debugResolveRequest(
      _ requestId: String, status: RuntimeRequest.Status = .resolved, decision: String? = nil, answers: JSONValue? = nil
    ) {
      guard var projection, let index = projection.runtimeRequests.firstIndex(where: { $0.id == requestId }) else { return }
      projection.runtimeRequests[index].status = WireEnum(status)
      projection.runtimeRequests[index].decision = decision
      projection.runtimeRequests[index].answers = answers
      projection.runtimeRequests[index].resolvedAt = WireTimestamp(Date.now)
      let settled: TurnItemStatus = status == .resolved ? .completed : .cancelled
      func settle(_ item: inout TurnItem) {
        switch item.body {
        case .approvalRequest(let request) where request.requestId == requestId: item.status = WireEnum(settled)
        case .userInputRequest(let request) where request.requestId == requestId: item.status = WireEnum(settled)
        default: break
        }
      }
      for i in projection.turnItems.indices { settle(&projection.turnItems[i]) }
      for i in projection.visibleTurnItems.indices { settle(&projection.visibleTurnItems[i].item) }
      projection.stampRevisions()
      self.projection = projection
      dirty = true
      publishNow()
    }

    /// Settles a secret request (debug builds' fake sink).
    public func debugSettleSecret(_ itemId: String, status: String) {
      guard var projection else { return }
      func settle(_ item: inout TurnItem) {
        guard item.id == itemId, case .secretRequest(var request) = item.body else { return }
        request.secretStatus = status
        item.body = .secretRequest(request)
        item.status = WireEnum(.completed)
      }
      for i in projection.turnItems.indices { settle(&projection.turnItems[i]) }
      for i in projection.visibleTurnItems.indices { settle(&projection.visibleTurnItems[i].item) }
      projection.stampRevisions()
      self.projection = projection
      dirty = true
      publishNow()
    }

    /// Removes a run (the fake sink's cancel and send-now).
    public func debugRemoveRun(_ runId: String) {
      guard var projection else { return }
      projection.runs.removeAll { $0.id == runId }
      self.projection = projection
      dirty = true
      publishNow()
    }
  #endif

  /// Shows that the thread cannot be opened (a fixture with no data, a ref with no source).
  public func markUnavailable(_ message: String? = nil) {
    state.phase = .unavailable(message)
    publishNow()
  }

  /// The current state (tests and diagnostics).
  public var current: ThreadDetailState { state }

  /// Publishes anything still pending (tests).
  public func flush() {
    if dirty || pendingPublish != nil { publishNow() }
  }
}

extension RpcStream {
  /// A stream not backed by a socket (fixtures, tests). `stop` runs when the reader lets go.
  public static func local(_ base: AsyncThrowingStream<Element, any Error>, stop: @escaping @Sendable () -> Void = {})
    -> RpcStream
  {
    RpcStream(base: base, stop: stop)
  }
}
