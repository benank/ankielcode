import Foundation

/// Applies thread events to a projection: a port of `applyOrchestrationV2ProjectionEvent`
/// (`client-runtime/src/state/orchestrationV2Projection.ts`) and the visibility rules of
/// `shared/src/orchestrationV2Timeline.ts` (spec §6.5).
public enum ThreadReducer {
  /// A bounded window: drop updates for items older than the window (spec §6.5 "Partial").
  public struct PartialWindow: Sendable, Hashable {
    public var latestLocalTurnOrdinal: Int?
    public init(latestLocalTurnOrdinal: Int?) { self.latestLocalTurnOrdinal = latestLocalTurnOrdinal }
  }

  /// Returns false when the event did not change the projection (another thread's event, or a
  /// partial-window drop).
  @discardableResult
  public static func apply(_ event: ThreadEvent, to projection: inout ThreadProjection, partial: PartialWindow? = nil) -> Bool {
    guard event.threadId == projection.thread.id else { return false }
    switch event.payload {
    case .thread(let thread):
      projection.thread = thread
      if !["thread.visited", "thread.tags-updated", "thread.marked-unread"].contains(event.type) {
        projection.updatedAt = event.occurredAt
      }
    case .run(var run):
      projection.updatedAt = event.occurredAt
      let known = projection.runs.first { $0.id == run.id }
      if run.output == nil, let held = known?.output { run.output = held }
      upsert(run, into: &projection.runs)
      projection.visibleTurnItems = activeRows(projection)
      if known?.status == .queued, run.status != .queued {
        restoreQueuedUserItems(&projection, runId: run.id)
      }
    case .runOutput(let runId, let output):
      projection.updatedAt = event.occurredAt
      if let index = projection.runs.firstIndex(where: { $0.id == runId }) { projection.runs[index].output = output }
    case .attempt(let attempt):
      projection.updatedAt = event.occurredAt
      upsert(attempt, into: &projection.attempts)
      projection.visibleTurnItems = activeRows(projection)
    case .node(let node):
      projection.updatedAt = event.occurredAt
      upsert(node, into: &projection.nodes)
    case .subagent(let subagent):
      projection.updatedAt = event.occurredAt
      upsert(subagent, into: &projection.subagents)
    case .providerTurn(var turn):
      projection.updatedAt = event.occurredAt
      if turn.tokenUsage == nil { turn.tokenUsage = projection.providerTurns.first { $0.id == turn.id }?.tokenUsage }
      upsert(turn, into: &projection.providerTurns)
    case .providerThread(let providerThread):
      projection.updatedAt = event.occurredAt
      if providerThread.appThreadId == projection.thread.id, !providerThread.isQueuedPlaceholder {
        projection.thread.activeProviderThreadId = providerThread.id
      }
      upsert(providerThread, into: &projection.providerThreads)
    case .runtimeRequest(let request):
      projection.updatedAt = event.occurredAt
      upsert(request, into: &projection.runtimeRequests)
    case .message(let message):
      projection.updatedAt = event.occurredAt
      upsert(message, into: &projection.messages)
    case .checkpoint(let checkpoint):
      projection.updatedAt = event.occurredAt
      upsert(checkpoint, into: &projection.checkpoints)
    case .checkpointScope(let scope):
      projection.updatedAt = event.occurredAt
      upsert(scope, into: &projection.checkpointScopes)
    case .turnItem(let incoming):
      return applyTurnItem(incoming, occurredAt: event.occurredAt, to: &projection, partial: partial)
    case .ignored:
      projection.updatedAt = event.occurredAt
    case .unknown:
      return false
    }
    return true
  }

  private static func applyTurnItem(
    _ incoming: TurnItem, occurredAt: WireTimestamp, to projection: inout ThreadProjection, partial: PartialWindow?
  ) -> Bool {
    var item = restoreBodies(incoming, from: projection)
    // Streamed updates land on the newest items, so search from the end.
    let index = projection.turnItems.lastIndex { $0.id == item.id }
    let previous = index.map { projection.turnItems[$0] }
    if let held = previous?.deferredWork { item.deferredWork = held }
    if let partial, index == nil, shouldDropMissing(item, in: projection, partial: partial) {
      return false
    }
    projection.revisionClock += 1
    item.revision = projection.revisionClock
    projection.updatedAt = occurredAt
    if let index { projection.turnItems[index] = item } else { projection.turnItems.append(item) }
    // Only interrupt requests change another item's visibility; streaming text must not recheck
    // every row against every run.
    if item.type == "run_interrupt_request" || previous?.type == "run_interrupt_request" {
      projection.visibleTurnItems = activeRows(projection)
    }
    if isVisible(item, in: projection) {
      upsertRow(item, in: &projection, partial: partial)
    } else {
      removeRow(item.id, from: &projection.visibleTurnItems)
    }
    return true
  }

  // MARK: Visibility

  /// A run that started received its queued input, even if recovery cancelled it later.
  static func isHeld(_ run: Run) -> Bool {
    run.status == .queued || (run.status == .cancelled && run.startedAt == nil)
  }

  public static func isVisible(_ item: TurnItem, in projection: ThreadProjection) -> Bool {
    if let runId = item.runId, projection.runs.contains(where: { $0.id == runId && $0.status == .rolledBack }) {
      return false
    }
    if case .userMessage(let message) = item.body, message.inputIntent == .queuedTurn, let runId = item.runId,
      projection.runs.contains(where: { $0.id == runId && isHeld($0) })
    {
      return false
    }
    return !isSupersededInterrupt(item, in: projection)
  }

  private static func isSupersededInterrupt(_ item: TurnItem, in projection: ThreadProjection) -> Bool {
    guard item.type == "run_interrupt_result", let runId = item.runId, let nodeId = item.nodeId else { return false }
    let superseded = projection.attempts.contains {
      $0.runId == runId && $0.rootNodeId == nodeId && $0.status == "superseded"
    }
    guard superseded else { return false }
    // Show paired stop-then-steer results; hide plain-steer results without a matching request.
    return !projection.turnItems.contains { $0.type == "run_interrupt_request" && $0.runId == runId }
  }

  /// Keeps non-local rows and still-visible local rows, renumbered.
  static func activeRows(_ projection: ThreadProjection) -> [ProjectedTurnItem] {
    let rows = projection.visibleTurnItems
    var held: [String: WireEnum<RunStatus>] = [:]
    for run in projection.runs {
      if run.status == .rolledBack || isHeld(run) { held[run.id] = run.status } else { held[run.id] = nil }
    }
    let hasSuperseded = projection.attempts.contains { $0.status == "superseded" }
    guard !held.isEmpty || hasSuperseded else { return rows }
    var kept: [ProjectedTurnItem] = []
    kept.reserveCapacity(rows.count)
    var changed = false
    for row in rows {
      if !row.isLocal || isVisible(row.item, in: projection) {
        kept.append(row)
      } else {
        changed = true
      }
    }
    return changed ? renumbered(kept) : rows
  }

  // MARK: Rows

  private static func upsertRow(_ item: TurnItem, in projection: inout ThreadProjection, partial: PartialWindow?) {
    var rows = projection.visibleTurnItems
    let index = rows.lastIndex { $0.sourceItemId == item.id }
    if let index, rows[index].isLocal, rows[index].sourceThreadId == item.threadId,
      rows[index].item.ordinal == item.ordinal
    {
      rows[index].item = item
      projection.visibleTurnItems = rows
      return
    }
    if index == nil, let partial, shouldDropMissing(item, in: projection, partial: partial) { return }
    // Insert before the first later local row, as if the old row were removed first.
    var insertion = rows.count
    for (candidate, row) in rows.enumerated() where candidate != index && row.isLocal {
      if row.item.ordinal > item.ordinal || (row.item.ordinal == item.ordinal && row.item.id > item.id) {
        insertion = candidate
        break
      }
    }
    var updated: [ProjectedTurnItem] = []
    updated.reserveCapacity(rows.count + 1)
    let next = ProjectedTurnItem(position: 0, item: item)
    for (source, row) in rows.enumerated() {
      if source == insertion { updated.append(next) }
      if source != index { updated.append(row) }
    }
    if insertion == rows.count { updated.append(next) }
    rows = renumbered(updated)
    projection.visibleTurnItems = rows
  }

  private static func removeRow(_ itemId: String, from rows: inout [ProjectedTurnItem]) {
    guard let index = rows.firstIndex(where: { $0.sourceItemId == itemId }) else { return }
    rows.remove(at: index)
    rows = renumbered(rows)
  }

  private static func renumbered(_ rows: [ProjectedTurnItem]) -> [ProjectedTurnItem] {
    var rows = rows
    for position in rows.indices where rows[position].position != position {
      rows[position].position = position
    }
    return rows
  }

  /// A user item held for a queued run stays hidden until the run leaves the queue; its update
  /// can arrive before or after that run update.
  private static func restoreQueuedUserItems(_ projection: inout ThreadProjection, runId: String) {
    for item in projection.turnItems where item.runId == runId {
      guard case .userMessage(let message) = item.body, message.inputIntent == .queuedTurn,
        isVisible(item, in: projection)
      else { continue }
      upsertRow(item, in: &projection, partial: nil)
    }
  }

  // MARK: Partial windows

  private static func shouldDropMissing(_ item: TurnItem, in projection: ThreadProjection, partial: PartialWindow) -> Bool {
    if projection.visibleTurnItems.contains(where: { $0.sourceItemId == item.id }) { return false }
    guard let runId = item.runId else { return isBelowWindow(item, projection, partial) }
    // Items of an unfinished run are new, not unloaded history.
    if projection.runs.contains(where: { $0.id == runId && ($0.status.known?.isActive ?? false) }) { return false }
    if projection.visibleTurnItems.contains(where: { $0.isLocal && $0.item.runId == runId && $0.item.ordinal <= item.ordinal }) {
      return false
    }
    return isBelowWindow(item, projection, partial)
  }

  private static func isBelowWindow(_ item: TurnItem, _ projection: ThreadProjection, _ partial: PartialWindow) -> Bool {
    if let latest = partial.latestLocalTurnOrdinal, item.ordinal <= latest { return true }
    let oldest = projection.visibleTurnItems.filter(\.isLocal).map(\.item.ordinal).min()
    return oldest.map { item.ordinal < $0 } ?? false
  }

  // MARK: Bodies

  /// Restores a message body the stream blanked (`textOmitted`) from its record, newest first.
  private static func restoreBodies(_ item: TurnItem, from projection: ThreadProjection) -> TurnItem {
    var item = item
    switch item.body {
    case .userMessage(var message) where message.textOmitted == true:
      if let text = projection.messages.last(where: { $0.id == message.messageId })?.text {
        message.text = text
        message.textOmitted = nil
        item.body = .userMessage(message)
      }
    case .assistantMessage(var message) where message.textOmitted == true:
      if let text = projection.messages.last(where: { $0.id == message.messageId })?.text {
        message.text = text
        message.textOmitted = nil
        item.body = .assistantMessage(message)
      }
    default:
      break
    }
    return item
  }

  private static func upsert<Element: Identifiable>(_ element: Element, into list: inout [Element]) where Element.ID == String {
    if let index = list.firstIndex(where: { $0.id == element.id }) { list[index] = element } else { list.append(element) }
  }
}

extension ThreadProjection {
  /// Stamps every item with a revision (after a snapshot).
  mutating func stampRevisions() {
    for index in turnItems.indices {
      revisionClock += 1
      turnItems[index].revision = revisionClock
    }
    let revisions = Dictionary(turnItems.map { ($0.id, $0.revision) }, uniquingKeysWith: { _, last in last })
    for index in visibleTurnItems.indices {
      revisionClock += 1
      visibleTurnItems[index].item.revision = revisions[visibleTurnItems[index].item.id] ?? revisionClock
    }
  }
}
