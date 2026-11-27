import Foundation
import Observation

/// A session a terminal talks through: unary calls and the attach stream.
public protocol TerminalChannel: Sendable {
  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as: Response.Type
  ) async throws -> Response
  func stream<Item: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, of: Item.Type
  ) async throws -> RpcStream<Item>
}

/// Where a terminal finds its computer's live session.
@MainActor
public protocol TerminalHost: AnyObject {
  /// Suspends until a live session other than `previous` exists; nil once the task is cancelled.
  func channel(after previous: ObjectIdentifier?) async -> (id: ObjectIdentifier, channel: any TerminalChannel)?
  /// The session holds `terminal:operate` (read right before each command).
  var canOperate: Bool { get }
}

/// One terminal of a thread, as `terminal.attach` addresses it.
public struct TerminalTarget: Sendable, Hashable {
  public var environmentId: String
  public var threadId: String
  public var terminalId: String

  public init(environmentId: String, threadId: String, terminalId: String) {
    self.environmentId = environmentId
    self.threadId = threadId
    self.terminalId = terminalId
  }

  public var key: String { "\(environmentId):\(threadId):\(terminalId)" }
}

/// Where a new shell starts (RN `resolveTerminalOpenLocation`): `worktreePath` nil is the project checkout.
public struct TerminalLocation: Sendable, Hashable {
  public var cwd: String
  public var worktreePath: String?
  public var env: [String: String]?

  public init(cwd: String, worktreePath: String?, env: [String: String]? = nil) {
    self.cwd = cwd
    self.worktreePath = worktreePath
    self.env = env
  }
}

/// What the renderer does with output.
public enum TerminalOutput: Sendable, Hashable {
  /// Start over with this history (a snapshot or a restart).
  case reset(String)
  case append(String)
}

/// The measured grid of each terminal on this device, so a reattach starts at the size the
/// screen last had (RN `terminalUiState`).
@MainActor
public enum TerminalGridCache {
  private static var grids: [String: TerminalGrid] = [:]
  public static func grid(_ target: TerminalTarget) -> TerminalGrid? { grids[target.key] }
  static func store(_ grid: TerminalGrid, for target: TerminalTarget) { grids[target.key] = grid }
}

/// One shown terminal: follows the attach stream across reconnects (`resume` after the first
/// reply), keeps a bounded replay for its renderer, writes input in order, resizes the shell to
/// the measured grid on every new attachment, and closes a shell that exits while shown
/// (RN `createTerminalSession` plus `applyTerminalAttachStreamEvent`).
@MainActor @Observable
public final class TerminalSessionModel {
  public enum Phase: Sendable, Hashable {
    /// No live session to the computer.
    case waiting
    case attaching
    case attached
    /// The server refused the attachment; retry with `restart()`.
    case failed(String)
  }

  public let target: TerminalTarget
  public private(set) var phase = Phase.waiting
  public private(set) var status = TerminalStatus.closed
  /// Why the shell failed (an `error` event or a snapshot's `error`).
  public private(set) var error: String?
  /// The PTY grid every renderer draws; nil from servers without shared geometry.
  public private(set) var sharedGrid: TerminalGrid?
  public private(set) var label = ""
  public private(set) var hasRunningSubprocess = false
  public private(set) var cwd: String?
  /// Bumped for every event that changed the screen; 0 until the first snapshot.
  public private(set) var version = 0

  /// The shell ended while shown, or the user closed it; the screen leaves it.
  @ObservationIgnored public var onExit: (() -> Void)?
  /// Output for the renderer. Setting it replays what arrived so far.
  @ObservationIgnored public var output: ((TerminalOutput) -> Void)? {
    didSet { if version > 0 { output?(.reset(replay.text)) } }
  }
  @ObservationIgnored public private(set) var replay = TerminalReplay()

  @ObservationIgnored private let host: any TerminalHost
  @ObservationIgnored private let location: TerminalLocation
  @ObservationIgnored private var lifecycle = TerminalLifecycle()
  @ObservationIgnored private var run: Task<Void, Never>?
  @ObservationIgnored private var channel: (any TerminalChannel)?
  @ObservationIgnored private var replied = false
  @ObservationIgnored private var grid: TerminalGrid
  @ObservationIgnored private var gridMeasured = false
  /// The attachment the shell was last resized for; a new snapshot is a new generation.
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var resizedGeneration: Int?
  @ObservationIgnored private var resizing = false
  @ObservationIgnored private var pendingInput = ""
  @ObservationIgnored private var writing = false
  /// Increments whenever the shell starts or stops accepting input, so queued writes for an old
  /// shell never reach a new one.
  @ObservationIgnored private var liveness = 0
  @ObservationIgnored private var lastLive = false

  public init(target: TerminalTarget, location: TerminalLocation, host: any TerminalHost) {
    self.target = target
    self.location = location
    self.host = host
    grid = TerminalGridCache.grid(target) ?? .fallback
  }

  /// The shell takes input now.
  public var isLive: Bool { phase == .attached && status.isLive }

  /// Follows the terminal until `stop()`. The server sizes the PTY to every attached viewer, so a
  /// screen that leaves must stop.
  public func start() {
    guard run == nil else { return }
    run = Task { [weak self] in await self?.follow() }
  }

  public func stop() {
    run?.cancel()
    run = nil
    channel = nil
    detach()
    phase = .waiting
  }

  /// Retries after a refusal.
  public func restart() {
    stop()
    start()
  }

  private func follow() async {
    var previous: ObjectIdentifier?
    while !Task.isCancelled {
      guard let next = await host.channel(after: previous) else { return }
      previous = next.id
      channel = next.channel
      phase = .attaching
      do {
        let stream = try await next.channel.stream(TerminalAttachRequest.rpcTag, payload: attachRequest(), of: TerminalEvent.self)
        for try await event in stream {
          replied = true
          if phase != .attached { phase = .attached }
          apply(event)
        }
      } catch is CancellationError {
        return
      } catch RpcError.failed(let failure) {
        if !Task.isCancelled { phase = .failed(Self.describe(failure)) }
      } catch RpcError.defect(let defect) {
        if !Task.isCancelled { phase = .failed(defect.stringValue ?? "") }
      } catch RpcError.interrupted {
        // The server ended this attachment on a live socket: attach again on the same session.
        previous = nil
        try? await Task.sleep(for: .seconds(1))
      } catch {
        // The socket went away: wait for the supervisor's next session.
      }
      guard !Task.isCancelled else { return }
      channel = nil
      detach()
      if case .failed = phase {} else { phase = .waiting }
    }
  }

  /// A refusal in the server's words; folder errors carry only the path.
  static func describe(_ failure: RpcFailure) -> String {
    if let message = failure.message, !message.isEmpty { return message }
    if let cwd = failure.error["cwd"]?.stringValue {
      switch failure.tag {
      case "TerminalCwdNotFoundError": return "Terminal folder does not exist: \(cwd)"
      case "TerminalCwdNotDirectoryError": return "Terminal cwd is not a directory: \(cwd)"
      default: return "Failed to access terminal cwd: \(cwd)"
      }
    }
    return failure.tag ?? ""
  }

  private func attachRequest() -> TerminalAttachRequest {
    let grid = grid.clamped
    return TerminalAttachRequest(
      threadId: target.threadId, terminalId: target.terminalId, cwd: location.cwd,
      worktreePath: location.worktreePath, cols: grid.cols, rows: grid.rows, env: location.env,
      resume: replied ? true : nil, maxHistoryBytes: terminalHistoryBytes)
  }

  private func detach() {
    lifecycle.detached()
    resizedGeneration = nil
    setLive(false)
  }

  // MARK: Events

  func apply(_ event: TerminalEvent) {
    switch event {
    case .snapshot(let snapshot), .restarted(let snapshot):
      replay.reset(snapshot.history)
      output?(.reset(replay.text))
      status = snapshot.status.known ?? .closed
      error = snapshot.error
      cwd = snapshot.cwd
      if let grid = snapshot.grid { sharedGrid = grid }
      if !snapshot.label.isEmpty { label = snapshot.label }
      generation += 1
      resizedGeneration = nil
      if case .restarted = event { liveness += 1 }
    case .output(let data):
      replay.append(data)
      output?(.append(data))
      if status == .closed { status = .running }
      error = nil
    case .cleared:
      // Screen and scrollback only: a full reset would drop the modes the program negotiated.
      let clear = "\u{1B}[H\u{1B}[2J\u{1B}[3J"
      replay.append(clear)
      output?(.append(clear))
      error = nil
    case .exited:
      status = .exited
      error = nil
    case .closed:
      status = .closed
      error = nil
    case .error(let message):
      status = .error
      error = message
    case .activity(let running, let label, let grid):
      hasRunningSubprocess = running
      self.label = label
      if let grid, grid != sharedGrid { sharedGrid = grid }
      return
    case .unknown:
      return
    }
    version += 1
    setLive(status.isLive)
    if status == .running, resizedGeneration != generation { sendResize() }
    switch lifecycle.status(status, version: version) {
    case .exit?:
      guard host.canOperate else { return }
      let target = target
      if let channel { Task { try? await Self.close(target, deleteHistory: false, via: channel) } }
      onExit?()
    case .reopen?:
      reopen()
    case nil: break
    }
  }

  private func setLive(_ live: Bool) {
    guard live != lastLive else { return }
    lastLive = live
    liveness += 1
    if !live { pendingInput = "" }
  }

  private func reopen() {
    guard host.canOperate, let channel else {
      lifecycle.reopenFailed()
      return
    }
    let grid = grid.clamped
    let request = TerminalOpenRequest(
      threadId: target.threadId, terminalId: target.terminalId, cwd: location.cwd,
      worktreePath: location.worktreePath, cols: grid.cols, rows: grid.rows, env: location.env)
    Task {
      do {
        _ = try await channel.call(TerminalOpenRequest.rpcTag, payload: request, as: RpcVoid.self)
      } catch {
        lifecycle.reopenFailed()
      }
    }
  }

  // MARK: Commands

  /// The renderer measured a grid; the shell follows while it runs.
  public func reportGrid(_ size: TerminalGrid) {
    let size = size.clamped
    guard !gridMeasured || size != grid else { return }
    gridMeasured = true
    grid = size
    TerminalGridCache.store(size, for: target)
    resizedGeneration = nil
    if status == .running { sendResize() }
  }

  /// The latest grid wins: a resize in flight is followed by one for whatever the grid is then.
  private func sendResize(retried: Bool = false) {
    guard !resizing, let channel, host.canOperate, phase == .attached else { return }
    resizing = true
    let generation = generation
    let grid = grid
    let request = TerminalResizeRequest(threadId: target.threadId, terminalId: target.terminalId, cols: grid.cols, rows: grid.rows)
    Task {
      let ok = (try? await channel.call(TerminalResizeRequest.rpcTag, payload: request, as: RpcVoid.self)) != nil
      resizing = false
      guard self.channel != nil, self.generation == generation else { return }
      if ok, grid == self.grid {
        resizedGeneration = generation
      } else if ok || !retried {
        sendResize(retried: !ok)
      }
    }
  }

  /// Sends input in order. Keystrokes typed while a write is in flight go out together next.
  public func write(_ data: String) {
    guard !data.isEmpty, isLive, host.canOperate else { return }
    pendingInput += data
    guard !writing else { return }
    writing = true
    Task { await pump() }
  }

  private func pump() async {
    defer { writing = false }
    let liveness = liveness
    while !pendingInput.isEmpty, let channel, liveness == self.liveness {
      let data = pendingInput
      pendingInput = ""
      for chunk in TerminalInput.chunks(data) {
        let request = TerminalWriteRequest(threadId: target.threadId, terminalId: target.terminalId, data: chunk)
        do {
          _ = try await channel.call(TerminalWriteRequest.rpcTag, payload: request, as: RpcVoid.self)
        } catch {
          pendingInput = ""
          return
        }
        guard liveness == self.liveness else { return }
      }
    }
  }

  /// Erases the screen and scrollback for every viewer.
  public func clear() {
    guard let channel, host.canOperate else { return }
    let request = TerminalTargetRequest(threadId: target.threadId, terminalId: target.terminalId)
    Task { _ = try? await channel.call(TerminalTargetRequest.clearTag, payload: request, as: RpcVoid.self) }
  }

  /// Stops the shell and forgets its history; the screen leaves it on success.
  public func close() async throws(EnvironmentRequestError) {
    guard let channel else { throw .notConnected }
    guard host.canOperate else { throw .rejected(message: nil) }
    do {
      try await Self.close(target, deleteHistory: true, via: channel)
    } catch {
      throw EnvironmentRequestError(error)
    }
    lifecycle.detached()
    onExit?()
  }

  private static func close(_ target: TerminalTarget, deleteHistory: Bool, via channel: any TerminalChannel) async throws {
    let request = TerminalCloseRequest(
      threadId: target.threadId, terminalId: target.terminalId, deleteHistory: deleteHistory ? true : nil)
    _ = try await channel.call(TerminalCloseRequest.rpcTag, payload: request, as: RpcVoid.self)
  }
}
