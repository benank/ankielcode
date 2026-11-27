import Foundation

/// A client-minted command id (random UUID v4). Mint one per user action and reuse it on retries:
/// the server answers a repeated id with the original result (§7.1).
public struct CommandID: Sendable, Hashable, Codable {
  public var rawValue: String

  public init(_ rawValue: String = UUID().uuidString.lowercased()) {
    self.rawValue = rawValue
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public init(from decoder: any Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }
}

/// The thread housekeeping commands the list sends (`orchestration.dispatchCommand`, §7.7).
public enum ThreadAction: Sendable, Hashable {
  case archive
  case unarchive
  case delete
  case settle
  /// `restoreUnsettledAt` restores the prior active position when undoing a settle.
  case unsettle(restoreUnsettledAt: WireTimestamp?? = nil)
  case snooze(until: Date)
  case unsnooze
  case pin(orderKey: String?)
  case unpin
  case markRead(visitedAt: WireTimestamp)
  case markUnread
  case rename(String)

  public var type: String {
    switch self {
    case .archive: "thread.archive"
    case .unarchive: "thread.unarchive"
    case .delete: "thread.delete"
    case .settle: "thread.settle"
    case .unsettle: "thread.unsettle"
    case .snooze: "thread.snooze"
    case .unsnooze: "thread.unsnooze"
    case .pin: "thread.pin"
    case .unpin: "thread.unpin"
    case .markRead: "thread.visit"
    case .markUnread: "thread.mark-unread"
    case .rename: "thread.metadata.update"
    }
  }
}

/// One `OrchestrationV2Command` for a thread.
public struct ThreadCommand: Sendable, Hashable, Encodable {
  public var commandId: CommandID
  public var threadId: String
  public var action: ThreadAction

  public init(_ action: ThreadAction, threadId: String, commandId: CommandID = CommandID()) {
    self.action = action
    self.threadId = threadId
    self.commandId = commandId
  }

  enum CodingKeys: String, CodingKey {
    case type, commandId, threadId, reason, restoreUnsettledAt, snoozedUntil, orderKey, visitedAt, title
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(action.type, forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    switch action {
    case .archive, .unarchive, .delete, .settle, .unpin, .markUnread:
      break
    case .unsettle(let restore):
      try c.encode("user", forKey: .reason)
      // Present-null and absent differ here: null restores "never unsettled".
      if let restore {
        if let restore { try c.encode(restore, forKey: .restoreUnsettledAt) } else { try c.encodeNil(forKey: .restoreUnsettledAt) }
      }
    case .snooze(let until):
      try c.encode(WireTimestamp(until), forKey: .snoozedUntil)
    case .unsnooze:
      try c.encode("user", forKey: .reason)
    case .pin(let orderKey):
      try c.encodeIfPresent(orderKey, forKey: .orderKey)
    case .markRead(let visitedAt):
      try c.encode(visitedAt, forKey: .visitedAt)
    case .rename(let title):
      try c.encode(title, forKey: .title)
    }
  }

  public static let rpcTag = "orchestration.dispatchCommand"
}

/// `OrchestrationV2DispatchCommandResult`.
public struct DispatchResult: Sendable, Hashable, Decodable {
  public var sequence: Int
}
