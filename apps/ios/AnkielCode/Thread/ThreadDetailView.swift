import AnkielKit
import SwiftUI

/// The thread screen. Phase 5 builds the conversation; for now it shows what the list knows. It
/// renders from the ref alone, because a linked thread may not be in a partial shell.
struct ThreadDetailView: View {
  let threadRef: ThreadRef
  @Environment(AppModel.self) private var model

  var body: some View {
    let thread = model.home.thread(threadRef)
    let environment = model.registry.environment(threadRef.environmentId)
    ScrollView {
      VStack(alignment: .leading, spacing: Spacing.lg) {
        if let thread {
          let facts = ThreadFacts(environmentId: threadRef.environmentId, thread: thread)
          HStack(spacing: Spacing.sm) {
            ThreadLightView(light: ThreadRules.light(facts, wokeAt: nil))
            Text(ThreadCopy.status(Self.label(ThreadRules.rowStatus(facts))))
              .font(Typography.subheadline.weight(.medium))
              .foregroundStyle(Palette.textSecondary)
          }
          if let message = thread.latestVisibleMessage?.text, !message.isEmpty {
            Text(message)
              .font(Typography.body)
              .foregroundStyle(Palette.textPrimary)
              .lineLimit(8)
          }
        } else if environment == nil {
          Text("This thread's computer is not saved on this device.")
            .foregroundStyle(Palette.textSecondary)
        } else {
          Text("This thread is not loaded yet.")
            .foregroundStyle(Palette.textSecondary)
        }
        Text("Conversation arrives in the next phase")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textTertiary)
          .accessibilityIdentifier("thread.placeholder")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(Spacing.lg)
    }
    .background(Palette.canvas)
    .navigationTitle(thread.map { $0.title.isEmpty ? String(localized: "New thread") : $0.title } ?? String(localized: "Thread"))
    .navigationSubtitle(environment?.label ?? "")
    .navigationBarTitleDisplayMode(.inline)
  }

  private static func label(_ status: ThreadListStatus) -> ThreadStatusLabel {
    switch status {
    case .approval: .approval
    case .input: .input
    case .working: .working
    case .waiting: .waiting
    case .failed: .failed
    case .limited: .limited
    case .ready: .done
    }
  }
}

/// New thread. Phase 6 builds the composer here.
struct NewThreadView: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ContentUnavailableView {
        Label("New thread", systemImage: "square.and.pencil")
      } description: {
        Text("The composer arrives in a later phase.")
      }
      .navigationTitle("New thread")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close", systemImage: "xmark") { dismiss() }
        }
      }
    }
  }
}

/// Settings. Phase 8 builds it.
struct SettingsPlaceholderView: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ContentUnavailableView {
        Label("Settings", systemImage: "gearshape")
      } description: {
        Text("Settings arrive in a later phase.")
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", systemImage: "xmark") { dismiss() }
        }
      }
    }
  }
}
