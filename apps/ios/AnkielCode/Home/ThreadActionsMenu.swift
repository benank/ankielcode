import AnkielKit
import SwiftUI
import UIKit

/// RN's row menu (`layoutThreadListV2RowMenuActions`, nested on iOS): copy actions, the row's
/// primary action and snooze, pin, then the rest under More. Shared by the list's context menu and
/// the thread screen's header; rename and delete ask through the caller's dialogs.
struct ThreadActionsMenu: View {
  let row: ThreadRow
  let operable: Bool
  let rename: () -> Void
  let delete: () -> Void
  /// A committed action: the caller plays its haptic, then runs it.
  let commit: (() -> Void) -> Void
  /// The list leads with the copy actions (RN); the thread's header puts them last.
  var copyFirst = true
  @Environment(AppModel.self) private var model

  var body: some View {
    let home = model.home
    if copyFirst {
      ThreadCopyActions(ref: row.ref)
    }
    if operable {
      if copyFirst { Divider() }
      switch row.swipe.primary {
      case .settle: Button("Settle", systemImage: "checkmark") { commit { home.settle(row) } }
      case .unsettle:
        Button("Un-settle", systemImage: "arrow.uturn.backward") { commit { home.perform(.unsettle(), on: row.ref) } }
      case .unsnooze: Button("Wake thread", systemImage: "clock") { commit { home.perform(.unsnooze, on: row.ref) } }
      case .archive: Button("Archive", systemImage: "archivebox") { commit { home.archive(row) } }
      }
      if row.swipe.snooze {
        Menu("Snooze", systemImage: "moon.zzz") {
          ForEach(SnoozePreset.resolve(model.snoozePresets(row.ref.environmentId), now: .now)) { preset in
            Button {
              commit { home.snooze(row, until: preset.wake) }
            } label: {
              Text(ThreadCopy.snoozeLabel(preset))
              Text(ThreadCopy.snoozeWhen(preset, now: .now))
            }
          }
          Button {
            home.customSnoozeRow = row
          } label: {
            Text("Custom…", comment: "custom snooze time")
          }
        }
      }
      if row.isTopLevel, !row.snoozed {
        if row.pinned {
          Button("Unpin", systemImage: "pin.slash") { commit { home.unpin(row) } }
        } else {
          Button("Pin", systemImage: "pin") { commit { home.pin(row) } }
        }
      }
      Menu("More", systemImage: "ellipsis.circle") {
        Button("Rename", systemImage: "square.and.pencil", action: rename)
        switch row.readToggle {
        case .markRead?: Button("Mark read", systemImage: "envelope.open") { home.toggleRead(row) }
        case .markUnread?: Button("Mark unread", systemImage: "envelope.badge") { home.toggleRead(row) }
        case nil: EmptyView()
        }
        if row.swipe.primary != .archive {
          Button("Archive", systemImage: "archivebox") { commit { home.archive(row) } }
        }
        Button("Delete", systemImage: "trash", role: .destructive, action: delete)
      }
      .accessibilityIdentifier("thread.more")
    }
  }
}

/// Copy thread link and Copy thread ID.
struct ThreadCopyActions: View {
  let ref: ThreadRef

  var body: some View {
    Button("Copy thread link", systemImage: "link") {
      UIPasteboard.general.string = ThreadLink.reference(ref)
      Haptics.success()
    }
    Button("Copy thread ID", systemImage: "doc.on.doc") {
      UIPasteboard.general.string = ref.threadId
      Haptics.success()
    }
  }
}
