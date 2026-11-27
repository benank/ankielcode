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
  @Environment(AppModel.self) private var model

  var body: some View {
    let home = model.home
    Button("Copy thread link", systemImage: "link") {
      UIPasteboard.general.string = ThreadLink.reference(row.ref)
      Haptics.success()
    }
    Button("Copy thread ID", systemImage: "doc.on.doc") {
      UIPasteboard.general.string = row.ref.threadId
      Haptics.success()
    }
    if operable {
      Divider()
      switch row.swipe.primary {
      case .settle: Button("Settle", systemImage: "checkmark") { commit { home.settle(row) } }
      case .unsettle:
        Button("Un-settle", systemImage: "arrow.uturn.backward") { commit { home.perform(.unsettle(), on: row.ref) } }
      case .unsnooze: Button("Wake thread", systemImage: "clock") { commit { home.perform(.unsnooze, on: row.ref) } }
      case .archive: Button("Archive", systemImage: "archivebox") { commit { home.archive(row) } }
      }
      if row.swipe.snooze {
        Menu("Snooze", systemImage: "moon.zzz") {
          ForEach(SnoozePreset.resolve(now: .now)) { preset in
            Button {
              commit { home.snooze(row, until: preset.wake) }
            } label: {
              Text(ThreadCopy.snoozeLabel(preset))
              Text(ThreadCopy.snoozeWhen(preset, now: .now))
            }
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
    }
  }
}
