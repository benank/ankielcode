import Foundation

/// The commands that undo a list action (a port of `planThreadUndo` in
/// `client-runtime/src/state/threadUndo.ts`), planned from the row as it was before the action.
public enum ThreadUndo {
  public enum Action: Sendable { case settle, snooze, unpin }

  public static func plan(_ action: Action, before thread: ThreadShell) -> [ThreadAction] {
    if action == .snooze { return [.unsnooze] }
    let pin = ThreadAction.pin(orderKey: thread.pinOrderKey)
    // Pinning clears a snooze on the server, so the snooze goes back after the placement.
    let snooze: [ThreadAction] = thread.snoozedUntil?.date.map { [.snooze(until: $0)] } ?? []
    if action == .unpin { return [pin] + snooze }
    // Settling clears a manual active position; a pinned thread is placed by its pin instead.
    let placement: [ThreadAction] =
      if thread.pinnedAt != nil { [pin] } else if let key = thread.activeOrderKey { [.reorderActive(orderKey: key)] } else { [] }
    return [.unsettle(restoreUnsettledAt: .some(thread.unsettledAt))] + placement + snooze
  }
}
