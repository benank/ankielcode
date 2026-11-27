import AnkielKit
import Foundation

/// Runs `body` with a Replay thread of the probe project, then stops and deletes it.
func withReplayThread(
  _ session: EnvironmentSession, scenario: String, runtimeMode: RuntimeMode = .approvalRequired,
  _ body: (String, ThreadDetailSync, TurnWatcher) async throws -> Void
) async throws {
  let (result, _) = try await launchReplayThread(session, scenario: scenario, runtimeMode: runtimeMode)
  let threadId = result.threadId
  print("launched \(scenario) thread \(threadId)")
  let sync = ThreadDetailSync(threadId: threadId)
  if let projection = result.projection, let sequence = result.sequence { await sync.seed(projection, sequence: sequence) }
  let watcher = TurnWatcher()
  let feed = follow(sync, into: watcher)
  await sync.attach(SessionItemSource(session: session))
  do {
    try await body(threadId, sync, watcher)
  } catch {
    feed.cancel()
    await sync.detach()
    _ = try? await dispatch(session, .stop, threadId)
    await deleteThread(session, threadId)
    throw error
  }
  feed.cancel()
  await sync.detach()
  await deleteThread(session, threadId)
  let gone = try await shellThreads(session).contains { $0.id == threadId }
  print("  deleted thread \(gone ? "STILL LISTED" : "gone from the shell")")
}

@discardableResult
func dispatch(_ session: EnvironmentSession, _ action: ThreadAction, _ threadId: String, commandId: CommandID = CommandID()) async throws -> Int {
  try await session.rpc.call(ThreadCommand.rpcTag, payload: ThreadCommand(action, threadId: threadId, commandId: commandId), as: DispatchResult.self).sequence
}

func idle(_ state: ThreadDetailState) -> Bool {
  state.phase == .live && state.revision > 1 && !state.activity.isRunning && state.timeline.status != .working
    && state.pending.isEmpty
}

/// `--live undo`: a manual active position survives settle + the app's undo plan.
func liveUndo(_ session: EnvironmentSession) async throws {
  try await withReplayThread(session, scenario: "multi-turn", runtimeMode: .fullAccess) { threadId, _, watcher in
    _ = try await watcher.until(60, "the first turn to finish", idle)
    try await dispatch(session, .reorderActive(orderKey: "a0V"), threadId)
    let before = try await currentThread(session, threadId)
    print("  before settle: activeOrderKey=\(before.activeOrderKey ?? "nil") unsettledAt=\(before.unsettledAt?.rawValue ?? "nil")")
    try await dispatch(session, .settle, threadId)
    let settled = try await currentThread(session, threadId)
    print("  settled: activeOrderKey=\(settled.activeOrderKey ?? "nil") settledAt=\(settled.settledAt?.rawValue ?? "nil")")
    for step in ThreadUndo.plan(.settle, before: before) { try await dispatch(session, step, threadId) }
    let after = try await currentThread(session, threadId)
    print("  after undo: activeOrderKey=\(after.activeOrderKey ?? "nil") unsettledAt=\(after.unsettledAt?.rawValue ?? "nil") settledAt=\(after.settledAt?.rawValue ?? "nil")")
    guard after.activeOrderKey == before.activeOrderKey, after.settledAt == nil else {
      throw ProbeFailure(description: "Undo did not restore the active position.")
    }
    print("  ✓ undo restored the manual position")
  }
}

/// `--live interrupt`: stop a running turn; then what the server sends after a client
/// `Interrupt` of a stream and of a unary call.
func liveInterrupt(_ session: EnvironmentSession, tap: FrameTap) async throws {
  try await withReplayThread(session, scenario: "showcase", runtimeMode: .fullAccess) { threadId, sync, watcher in
    let working = try await watcher.until(30, "the turn to start working") { $0.timeline.status == .working && $0.activity.isRunning }
    print("  working, run \(working.activity.activeRunId ?? "?")")
    let sequence = try await dispatch(session, .stop, threadId)
    print("  thread.stop → seq \(sequence)")
    let stopped = try await watcher.until(30, "the run to stop") { !$0.activity.isRunning }
    print("  after stop: status \(stopped.timeline.status), rows \(describeRows(stopped))")
    if let run = await sync.projection?.runs.last { print("  run status \(run.status.rawValue)") }
  }
  // A thread stream the client interrupts: does an Exit come back?
  let threads = try await shellThreads(session)
  if let first = threads.first {
    let stream = try await session.rpc.stream(ThreadSubscription.rpcTag, payload: ThreadSubscription(threadId: first.id), of: JSONValue.self)
    for try await _ in stream { break }
    try await Task.sleep(for: .seconds(2))
  }
  let counts = tap.counts.withLock { $0 }
  print("interrupts sent: \(counts.interrupted.count); exits after interrupt: \(counts.exitsAfterInterrupt.count)")
  for (id, frame) in counts.exitsAfterInterrupt.sorted(by: { $0.key < $1.key }) { print("  \(id): \(frame)") }
}
