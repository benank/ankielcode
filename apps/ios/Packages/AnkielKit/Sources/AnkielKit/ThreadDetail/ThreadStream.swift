import Foundation

/// `orchestration.subscribeThread` input (spec §6.1). This client asks for the full snapshot with
/// nothing compacted: none of the bounded/deferred/deduped/compact-id opt-ins are sent, because
/// their restore steps are not implemented.
public struct ThreadSubscription: Sendable, Hashable, Encodable {
  public static let rpcTag = "orchestration.subscribeThread"

  public var threadId: String
  public var afterSequence: Int?
  public var requestCompletionMarker: Bool?

  public init(threadId: String, afterSequence: Int? = nil) {
    self.threadId = threadId
    self.afterSequence = afterSequence
    requestCompletionMarker = true
  }
}

/// One thread stream item. Decoding never throws: a frame the client cannot read becomes
/// `.skipped` (advancing the cursor when its sequence is readable), because one bad item must not
/// fail the chunk and with it the whole stream.
public enum ThreadStreamItem: Sendable {
  case snapshot(ThreadSnapshot)
  case synchronized
  case event(sequence: Int, ThreadEvent)
  /// An unknown `kind`, an unknown event type, or a body that would not decode.
  case skipped(sequence: Int?, reason: String)
}

public struct ThreadSnapshot: Sendable {
  public var snapshotSequence: Int
  public var projection: ThreadProjection
  public var historyCursor: String?
  public var hasMoreHistory: Bool?
  public var latestLocalTurnOrdinal: Int?

  public init(snapshotSequence: Int, projection: ThreadProjection) {
    self.snapshotSequence = snapshotSequence
    self.projection = projection
  }
}

extension ThreadStreamItem: Decodable {
  enum CodingKeys: String, CodingKey {
    case kind, sequence, event, snapshotSequence, projection, historyCursor, hasMoreHistory, latestLocalTurnOrdinal
  }

  public init(from decoder: any Decoder) throws {
    guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
      self = .skipped(sequence: nil, reason: "not an object")
      return
    }
    let kind = container.loose(String.self, .kind) ?? ""
    switch kind {
    case "synchronized":
      self = .synchronized
    case "snapshot":
      do {
        var snapshot = ThreadSnapshot(
          snapshotSequence: try container.decode(Int.self, forKey: .snapshotSequence),
          projection: try container.decode(ThreadProjection.self, forKey: .projection))
        snapshot.historyCursor = container.loose(String.self, .historyCursor)
        snapshot.hasMoreHistory = container.loose(Bool.self, .hasMoreHistory)
        snapshot.latestLocalTurnOrdinal = container.loose(Int.self, .latestLocalTurnOrdinal)
        self = .snapshot(snapshot)
      } catch {
        self = .skipped(sequence: nil, reason: "snapshot: \(describeDecodingError(error))")
      }
    case "event":
      let sequence = container.loose(Int.self, .sequence)
      guard let sequence else {
        self = .skipped(sequence: nil, reason: "event without a sequence")
        return
      }
      do {
        let event = try container.decode(ThreadEvent.self, forKey: .event)
        if case .unknown = event.payload {
          self = .skipped(sequence: sequence, reason: "unknown event \(event.type)")
        } else {
          self = .event(sequence: sequence, event)
        }
      } catch {
        self = .skipped(sequence: sequence, reason: "event: \(describeDecodingError(error))")
      }
    default:
      self = .skipped(sequence: container.loose(Int.self, .sequence), reason: "unknown kind \(kind)")
    }
  }
}

/// `OrchestrationV2DomainEvent`: the envelope and the payloads the reducer reads.
public struct ThreadEvent: Sendable {
  public var id: String
  public var type: String
  public var threadId: String
  public var occurredAt: WireTimestamp
  public var payload: Payload

  public enum Payload: Sendable {
    case thread(AppThread)
    case run(Run)
    case runOutput(runId: String, output: JSONValue?)
    case attempt(RunAttempt)
    case node(ExecutionNode)
    case subagent(Subagent)
    case providerTurn(ProviderTurn)
    case runtimeRequest(RuntimeRequest)
    case message(ConversationMessage)
    case turnItem(TurnItem)
    /// A known event that changes nothing this client holds.
    case ignored
    case unknown
  }

  public init(id: String, type: String, threadId: String, occurredAt: WireTimestamp, payload: Payload) {
    self.id = id
    self.type = type
    self.threadId = threadId
    self.occurredAt = occurredAt
    self.payload = payload
  }

  /// `thread.*` events whose payload is the whole thread.
  static let threadEvents: Set<String> = [
    "thread.created", "thread.archived", "thread.unarchived", "thread.deleted", "thread.settled",
    "thread.unsettled", "thread.snoozed", "thread.unsnoozed", "thread.auto-settle-set", "thread.pinned",
    "thread.unpinned", "thread.pin-reordered", "thread.active-reordered", "thread.metadata-updated",
    "thread.pull-request-synced", "thread.issue-synced", "thread.runtime-mode-updated",
    "thread.interaction-mode-updated", "thread.model-selection-updated", "thread.provider-switched",
    "thread.visited", "thread.tags-updated", "thread.marked-unread",
  ]

  /// Known events whose records this client does not hold.
  static let ignoredEvents: Set<String> = [
    "thread.visit-recorded", "thread.pull-request-link-updated", "run.background-work-cancelled",
    "provider-session.attached", "provider-session.updated", "provider-session.detached",
    "provider-thread.updated", "plan.updated", "checkpoint-scope.created", "checkpoint.captured",
    "checkpoint.rollback-requested", "context-handoff.updated", "context-transfer.created",
    "context-transfer.updated",
  ]
}

extension ThreadEvent: Decodable {
  enum CodingKeys: String, CodingKey { case id, type, threadId, occurredAt, payload }
  private struct RunOutput: Decodable {
    var runId: String
    var output: JSONValue?
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = container.loose(String.self, .id) ?? ""
    type = try container.decode(String.self, forKey: .type)
    threadId = try container.decode(String.self, forKey: .threadId)
    occurredAt = try container.decode(WireTimestamp.self, forKey: .occurredAt)
    func payload<Value: Decodable>(_: Value.Type) throws -> Value {
      try container.decode(Value.self, forKey: .payload)
    }
    switch type {
    case _ where Self.threadEvents.contains(type): self.payload = .thread(try payload(AppThread.self))
    case "run.created", "run.updated": self.payload = .run(try payload(Run.self))
    case "run.output-submitted":
      let output = try payload(RunOutput.self)
      self.payload = .runOutput(runId: output.runId, output: output.output)
    case "run-attempt.created", "run-attempt.updated": self.payload = .attempt(try payload(RunAttempt.self))
    case "node.updated": self.payload = .node(try payload(ExecutionNode.self))
    case "subagent.updated": self.payload = .subagent(try payload(Subagent.self))
    case "provider-turn.updated": self.payload = .providerTurn(try payload(ProviderTurn.self))
    case "runtime-request.updated": self.payload = .runtimeRequest(try payload(RuntimeRequest.self))
    case "message.updated": self.payload = .message(try payload(ConversationMessage.self))
    case "turn-item.updated": self.payload = .turnItem(try payload(TurnItem.self))
    case _ where Self.ignoredEvents.contains(type): self.payload = .ignored
    default: self.payload = .unknown
    }
  }
}
