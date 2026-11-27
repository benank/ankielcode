import AnkielKit
import SwiftUI

/// Takes the composer's place in an archived thread: it reads but does not send until it is
/// unarchived. The thread's stream reports the change, which brings the composer back.
struct ArchivedThreadBar: View {
  let threadRef: ThreadRef
  @Environment(AppModel.self) private var model
  @State private var working = false
  @State private var failure: String?

  var body: some View {
    HStack(spacing: Spacing.md) {
      Label("This thread is archived", systemImage: "archivebox")
        .font(Typography.subheadline.weight(.medium))
        .foregroundStyle(Palette.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      if model.home.canOperate(threadRef) {
        Button {
          unarchive()
        } label: {
          if working {
            ProgressView()
          } else {
            Text("Unarchive", comment: "verb, swipe action")
              .font(Typography.subheadline.weight(.semibold))
          }
        }
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .disabled(working)
        .accessibilityIdentifier("thread.unarchive")
      }
    }
    .padding(.leading, Spacing.lg)
    .padding(.trailing, Spacing.md)
    .frame(minHeight: 56)
    .chromeGlass(in: .rect(cornerRadius: Radius.composer, style: .continuous))
    .padding(.horizontal, Spacing.md)
    .padding(.bottom, Spacing.xs)
    .sensoryFeedback(.success, trigger: working) { old, new in old && !new && failure == nil }
    .alert(
      String(localized: "Could not unarchive thread"), isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(failure ?? "")
    }
  }

  private func unarchive() {
    working = true
    Task {
      do {
        _ = try await model.registry.dispatch(ThreadCommand(.unarchive, threadId: threadRef.threadId), in: threadRef.environmentId)
      } catch {
        failure = ArchiveModel.message(error)
      }
      working = false
    }
  }
}
