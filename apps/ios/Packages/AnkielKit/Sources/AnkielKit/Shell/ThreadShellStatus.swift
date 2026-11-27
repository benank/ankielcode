extension ThreadShell {
  /// A turn is in flight (`activityRunStatus` set, or a live run status).
  public var isWorking: Bool {
    if activityRunStatus != nil { return true }
    switch status.known {
    case .preparing, .queued, .starting, .running, .waiting: return true
    default: return false
    }
  }

  /// An approval, question or secret waits on the user.
  public var needsAttention: Bool { pendingRuntimeRequest != nil }

  public var isSettled: Bool { settledOverride == .settled }

  /// Shown in the top-level list (subagents, side chats and workflow steps nest elsewhere).
  public var isListed: Bool { lineage.isListed && deletedAt == nil && archivedAt == nil }
}
