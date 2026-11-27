import AnkielKit
import Observation
import SwiftUI

/// Approvals from a thread's subagents and side chats, shown on the parent (RN
/// `ChildThreadApprovals`). Only children whose shell row says an approval waits get a detail
/// subscription, and each is released once it no longer asks.
@MainActor @Observable
final class ChildApprovals {
  private(set) var children: [(title: String, thread: ThreadRef, model: ThreadDetailModel)] = []

  func update(parent: ThreadRef, threads: [ThreadShell], model: AppModel) {
    let asking = ChildApprovalScan.children(of: parent.threadId, in: threads)
    let refs = asking.map { ThreadRef(environmentId: parent.environmentId, threadId: $0.id) }
    let current = children.map(\.thread)
    guard refs != current || zip(asking, children).contains(where: { $0.title != $1.title }) else { return }
    var next: [(title: String, thread: ThreadRef, model: ThreadDetailModel)] = []
    for (shell, ref) in zip(asking, refs) {
      let existing = children.first { $0.thread == ref }?.model
      next.append((shell.title, ref, existing ?? model.openThread(ref)))
    }
    for child in children where !refs.contains(child.thread) { model.closeThread(child.model) }
    children = next
  }

  func close(_ model: AppModel) {
    for child in children { model.closeThread(child.model) }
    children = []
  }

  var approvals: [(title: String, thread: ThreadRef, approvals: [PendingApproval])] {
    children.map { ($0.title, $0.thread, $0.model.state.pending.approvals) }
  }
}
