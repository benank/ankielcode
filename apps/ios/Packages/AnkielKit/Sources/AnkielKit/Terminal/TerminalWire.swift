import Foundation

/// The RN client's terminal id for a thread's first shell (`DEFAULT_TERMINAL_ID`).
public let defaultTerminalId = "term-1"

/// History a client keeps and asks snapshots to carry (`DEFAULT_MAX_TERMINAL_BUFFER_BYTES`).
public let terminalHistoryBytes = 512 * 1024

/// `TerminalSessionStatus`; the client adds `closed` for a terminal the server forgot.
public enum TerminalStatus: String, Sendable, Hashable, Codable {
  case starting, running, exited, error, closed

  /// The shell accepts input.
  public var isLive: Bool { self == .running || self == .starting }
}

/// The PTY grid every renderer of a shared terminal draws.
public struct TerminalGrid: Sendable, Hashable, Codable {
  public var cols: Int
  public var rows: Int

  public init(cols: Int, rows: Int) {
    self.cols = cols
    self.rows = rows
  }

  /// The server's bounds (`TerminalColsSchema`, `TerminalRowsSchema`).
  public var clamped: TerminalGrid {
    TerminalGrid(cols: min(max(cols, 1), 1000), rows: min(max(rows, 1), 500))
  }

  public static let fallback = TerminalGrid(cols: 80, rows: 24)
}

/// One terminal as `subscribeTerminalMetadata` lists it (`TerminalSummary`).
public struct TerminalSummary: Sendable, Hashable, Decodable {
  public var threadId: String
  public var terminalId: String
  public var cwd: String
  public var worktreePath: String?
  public var status: WireEnum<TerminalStatus>
  public var hasRunningSubprocess: Bool
  /// The running process name, or the server's English idle default ("Terminal 1").
  public var label: String
  public var updatedAt: String

  public init(
    threadId: String, terminalId: String, cwd: String, worktreePath: String? = nil, status: TerminalStatus,
    hasRunningSubprocess: Bool = false, label: String = "", updatedAt: String = ""
  ) {
    self.threadId = threadId
    self.terminalId = terminalId
    self.cwd = cwd
    self.worktreePath = worktreePath
    self.status = .known(status)
    self.hasRunningSubprocess = hasRunningSubprocess
    self.label = label
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey {
    case threadId, terminalId, cwd, worktreePath, status, hasRunningSubprocess, label, updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    terminalId = try c.decode(String.self, forKey: .terminalId)
    cwd = try c.decode(String.self, forKey: .cwd)
    worktreePath = try? c.decodeIfPresent(String.self, forKey: .worktreePath)
    status = try c.decode(WireEnum<TerminalStatus>.self, forKey: .status)
    hasRunningSubprocess = (try? c.decodeIfPresent(Bool.self, forKey: .hasRunningSubprocess)) ?? false
    label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
    updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? ""
  }
}

/// A terminal's state and retained history (`TerminalSessionSnapshot`).
public struct TerminalSnapshot: Sendable, Hashable, Decodable {
  public var threadId: String
  public var terminalId: String
  public var cwd: String
  public var worktreePath: String?
  public var status: WireEnum<TerminalStatus>
  public var history: String
  public var label: String
  public var updatedAt: String
  /// The shared PTY grid; absent from older servers.
  public var grid: TerminalGrid?
  /// Why the shell failed to start.
  public var error: String?

  public init(
    threadId: String, terminalId: String, cwd: String, status: TerminalStatus, history: String = "",
    grid: TerminalGrid? = nil, error: String? = nil
  ) {
    self.threadId = threadId
    self.terminalId = terminalId
    self.cwd = cwd
    worktreePath = nil
    self.status = .known(status)
    self.history = history
    label = ""
    updatedAt = ""
    self.grid = grid
    self.error = error
  }

  enum CodingKeys: String, CodingKey {
    case threadId, terminalId, cwd, worktreePath, status, history, label, updatedAt, cols, rows, error
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    terminalId = try c.decode(String.self, forKey: .terminalId)
    cwd = try c.decode(String.self, forKey: .cwd)
    worktreePath = try? c.decodeIfPresent(String.self, forKey: .worktreePath)
    status = try c.decode(WireEnum<TerminalStatus>.self, forKey: .status)
    history = (try? c.decodeIfPresent(String.self, forKey: .history)) ?? ""
    label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
    updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? ""
    let cols = try? c.decodeIfPresent(Int.self, forKey: .cols)
    let rows = try? c.decodeIfPresent(Int.self, forKey: .rows)
    grid = if let cols, let rows { TerminalGrid(cols: cols, rows: rows) } else { nil }
    error = try? c.decodeIfPresent(String.self, forKey: .error)
  }
}

/// One item of `terminal.attach` (`TerminalAttachStreamEvent`).
public enum TerminalEvent: Sendable, Hashable, Decodable {
  /// The first item of every attachment; a later one is a new server attachment (a reconnect).
  case snapshot(TerminalSnapshot)
  case output(String)
  case exited
  case closed
  case error(String)
  case cleared
  /// The shell started again: replace the screen with this history.
  case restarted(TerminalSnapshot)
  /// The process label or the shared grid changed.
  case activity(hasRunningSubprocess: Bool, label: String, grid: TerminalGrid?)
  case unknown(String)

  enum CodingKeys: String, CodingKey { case type, snapshot, data, message, hasRunningSubprocess, label, cols, rows }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "snapshot": self = .snapshot(try c.decode(TerminalSnapshot.self, forKey: .snapshot))
    case "restarted": self = .restarted(try c.decode(TerminalSnapshot.self, forKey: .snapshot))
    case "output": self = .output(try c.decode(String.self, forKey: .data))
    case "exited": self = .exited
    case "closed": self = .closed
    case "cleared": self = .cleared
    case "error": self = .error((try? c.decode(String.self, forKey: .message)) ?? "")
    case "activity":
      let cols = try? c.decodeIfPresent(Int.self, forKey: .cols)
      let rows = try? c.decodeIfPresent(Int.self, forKey: .rows)
      self = .activity(
        hasRunningSubprocess: (try? c.decode(Bool.self, forKey: .hasRunningSubprocess)) ?? false,
        label: (try? c.decode(String.self, forKey: .label)) ?? "",
        grid: cols.flatMap { cols in rows.map { TerminalGrid(cols: cols, rows: $0) } })
    default: self = .unknown(type)
    }
  }
}

/// One item of `subscribeTerminalMetadata`.
public enum TerminalMetadataEvent: Sendable, Hashable, Decodable {
  case snapshot([TerminalSummary])
  case upsert(TerminalSummary)
  case remove(threadId: String, terminalId: String)
  case unknown

  enum CodingKeys: String, CodingKey { case type, terminals, terminal, threadId, terminalId }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "snapshot": self = .snapshot(try c.decode(LossyArray<TerminalSummary>.self, forKey: .terminals).elements)
    case "upsert": self = .upsert(try c.decode(TerminalSummary.self, forKey: .terminal))
    case "remove":
      self = .remove(
        threadId: try c.decode(String.self, forKey: .threadId), terminalId: try c.decode(String.self, forKey: .terminalId))
    default: self = .unknown
    }
  }

  /// RN `applyTerminalMetadataStreamEvent`.
  public func applied(to terminals: [TerminalSummary]) -> [TerminalSummary] {
    switch self {
    case .snapshot(let all): return all
    case .remove(let threadId, let terminalId):
      return terminals.filter { $0.threadId != threadId || $0.terminalId != terminalId }
    case .upsert(let terminal):
      return terminals.filter { $0.threadId != terminal.threadId || $0.terminalId != terminal.terminalId } + [terminal]
    case .unknown: return terminals
    }
  }
}

// MARK: - Requests

/// `terminal.attach`: opens the shell if needed and streams it. `resume` after the first reply
/// keeps a stopped shell stopped; `maxHistoryBytes` bounds the snapshot's history.
struct TerminalAttachRequest: Encodable, Sendable {
  static let rpcTag = "terminal.attach"
  var threadId: String
  var terminalId: String
  var cwd: String?
  var worktreePath: String?
  var cols: Int?
  var rows: Int?
  var env: [String: String]?
  var resume: Bool?
  var maxHistoryBytes: Int?
}

/// `terminal.open`: starts (or restarts) a shell without attaching.
struct TerminalOpenRequest: Encodable, Sendable {
  static let rpcTag = "terminal.open"
  var threadId: String
  var terminalId: String
  var cwd: String
  var worktreePath: String?
  var cols: Int?
  var rows: Int?
  var env: [String: String]?
}

/// `terminal.write`: at most `TerminalInput.maxWriteLength` UTF-16 units of input.
struct TerminalWriteRequest: Encodable, Sendable {
  static let rpcTag = "terminal.write"
  var threadId: String
  var terminalId: String
  var data: String
}

struct TerminalResizeRequest: Encodable, Sendable {
  static let rpcTag = "terminal.resize"
  var threadId: String
  var terminalId: String
  var cols: Int
  var rows: Int
}

/// `terminal.clear` (`TerminalClearInput`).
struct TerminalTargetRequest: Encodable, Sendable {
  static let clearTag = "terminal.clear"
  var threadId: String
  var terminalId: String
}

/// `terminal.close`; `deleteHistory` also forgets its scrollback.
struct TerminalCloseRequest: Encodable, Sendable {
  static let rpcTag = "terminal.close"
  var threadId: String
  var terminalId: String
  var deleteHistory: Bool?
}

/// `subscribeTerminalMetadata` takes an empty object.
struct TerminalMetadataRequest: Encodable, Sendable {
  static let rpcTag = "subscribeTerminalMetadata"
}

/// The permissions (RN `AuthTerminalReadScope`, `AuthTerminalOperateScope`).
public enum TerminalScope {
  public static let read = "terminal:read"
  public static let operate = "terminal:operate"
}
