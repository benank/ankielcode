import AnkielKit
import SwiftUI
import UIKit

/// The thread screen: the conversation under glass bars, the thread's actions in the header, and
/// the composer's place at the bottom. It renders from the ref alone, because a linked thread may
/// not be in a partial shell.
struct ThreadDetailView: View {
  let threadRef: ThreadRef
  @Environment(AppModel.self) private var model
  @State private var detail: ThreadDetailModel?
  /// Stands in while a new thread's launch is unacknowledged: its stream cannot open yet.
  @State private var placeholder: ThreadDetailModel?

  private var awaitingCreation: Bool { model.composer.isAwaitingCreation(threadRef) }

  var body: some View {
    Group {
      if let shown = detail ?? placeholder {
        ThreadScreen(threadRef: threadRef, detail: shown, awaitingCreation: detail == nil)
      } else {
        Palette.canvas
      }
    }
    .onAppear(perform: open)
    .onChange(of: awaitingCreation) { _, _ in open() }
    .onDisappear {
      if let detail { model.closeThread(detail) }
      detail = nil
    }
  }

  private func open() {
    guard detail == nil else { return }
    if awaitingCreation {
      if placeholder == nil {
        placeholder = ThreadDetailModel(ref: threadRef, sync: ThreadDetailSync(threadId: threadRef.threadId))
      }
      return
    }
    detail = model.openThread(threadRef)
    placeholder = nil
  }
}

private struct ThreadScreen: View {
  let threadRef: ThreadRef
  let detail: ThreadDetailModel
  let awaitingCreation: Bool
  @Environment(AppModel.self) private var model
  @State private var renaming: String?
  @State private var deleting = false
  @State private var actionCount = 0

  private var row: ThreadRow? { model.home.row(threadRef) }
  private var shell: ThreadShell? { model.home.thread(threadRef) }
  private var environment: EnvironmentModel? { model.registry.environment(threadRef.environmentId) }

  private var pendingCreation: OutboxMessage? {
    model.composer.outbox.first { $0.threadKey == threadRef.key && $0.creation != nil }
  }

  private var title: String {
    let title = detail.state.title ?? shell?.title ?? row?.title ?? pendingCreation?.creation?.title ?? ""
    return title.isEmpty ? String(localized: "New thread") : title
  }

  private var subtitle: String {
    let projectId = detail.state.projectId ?? shell?.projectId
    let project = projectId.flatMap { id in environment?.shell.snapshot?.projects.first { $0.id == id }?.title }
    var parts = [project, environment?.label ?? ThreadDebug.environmentLabel(threadRef)].compactMap { $0 }
    if let status = WorkCopy.status(detail.state.timeline.status) { parts.insert(status, at: 0) }
    return parts.joined(separator: " · ")
  }

  var body: some View {
    content
      .background(Palette.canvas)
      .navigationTitle(title)
      .navigationSubtitle(subtitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbar }
      .safeAreaInset(edge: .bottom, spacing: 0) { composer }
      .onChange(of: detail.state.messageIds, initial: true) { _, known in
        model.composer.reconcile(threadRef.key, known: known)
      }
      .sensoryFeedback(.impact(weight: .light), trigger: actionCount)
      .alert("Rename thread", isPresented: renamePresented) {
        TextField("Title", text: renameText)
        Button("Cancel", role: .cancel) {}
        Button("Save") { model.home.rename(threadRef, to: renaming ?? "") }
      }
      .alert("Delete thread?", isPresented: $deleting) {
        Button("Cancel", role: .cancel) {}
        Button("Delete", role: .destructive) {
          model.home.perform(.delete, on: threadRef)
          model.navigator.close(threadRef)
        }
      } message: {
        Text("“\(title)” will be permanently deleted, including its terminal history.")
      }
  }

  @ViewBuilder
  private var content: some View {
    switch detail.state.phase {
    case .deleted:
      ContentUnavailableView {
        Label("Thread deleted", systemImage: "trash")
      } description: {
        Text("This thread was deleted on its computer.")
      }
    case .unavailable(let message) where !detail.state.isLoaded:
      ContentUnavailableView {
        Label("Could not open this thread", systemImage: "exclamationmark.bubble")
      } description: {
        Text(message ?? String(localized: "The computer did not send this thread."))
      }
    case .unreadable where !detail.state.isLoaded:
      ContentUnavailableView {
        Label("Could not read this thread", systemImage: "exclamationmark.bubble")
      } description: {
        Text("This thread uses something this version of the app cannot read yet. Update the app.")
      }
    default:
      if detail.state.isLoaded || awaitingCreation {
        ThreadTimelineView(model: detail, images: images, openThread: openChild, pending: pendingRows)
          .overlay(alignment: .top) { staleNotice }
          .overlay {
            if detail.state.timeline.rows.isEmpty, pendingRows.isEmpty { EmptyThreadPrompt() }
          }
      } else if environment == nil, !ThreadDebug.isFixture(threadRef) {
        ContentUnavailableView {
          Label("Computer not saved", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
        } description: {
          Text("This thread's computer is not saved on this device.")
        }
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel(Text("Loading thread"))
      }
    }
  }

  @ViewBuilder
  private var staleNotice: some View {
    if detail.state.phase == .stale, !ThreadDebug.isFixture(threadRef) {
      StatusPill(text: "Not connected · showing saved messages", systemImage: "wifi.slash", tint: Palette.attention)
        .padding(.top, Spacing.sm)
        .transition(.opacity)
    }
  }

  // MARK: Composer

  private var target: ComposerTarget { .thread(threadRef, detail: awaitingCreation ? nil : detail, model: model) }

  @ViewBuilder
  private var composer: some View {
    let target = target
    VStack(spacing: Spacing.sm) {
      if !target.activity.queued.isEmpty {
        QueuedMessagesBar(
          queued: target.activity.queued, held: target.activity.queueHeld, actions: ComposerActions(model: model, target: target)
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
      }
      if !awaitingCreation {
        ComposerView(target: target) { delivery in
          model.composer.send(threadRef.key, to: threadRef, delivery: delivery, thread: target.threadSettings)
        }
      }
    }
    .motion(Motion.snappy, value: target.activity.queued.map(\.id))
  }

  private var pendingRows: [PendingRow] {
    let target = target
    return model.composer.pending(threadRef.key, known: detail.state.messageIds).map { message in
      PendingRow(message: message, environmentLabel: target.environmentLabel, connected: target.connected)
    }
  }

  private var images: ThreadImages {
    ThreadDebug.isFixture(threadRef) ? .none : .live(threadRef, registry: model.registry)
  }

  private func openChild(_ threadId: String) {
    model.navigator.push(ThreadRef(environmentId: threadRef.environmentId, threadId: threadId))
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if let row {
          ThreadActionsMenu(
            row: row, operable: model.home.canOperate(threadRef), rename: { renaming = row.title },
            delete: { deleting = true }, commit: commit)
        } else {
          Button("Copy thread link", systemImage: "link") {
            UIPasteboard.general.string = ThreadLink.reference(threadRef)
            Haptics.success()
          }
          Button("Copy thread ID", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = threadRef.threadId
            Haptics.success()
          }
        }
      } label: {
        Label("Thread actions", systemImage: "ellipsis")
      }
      .accessibilityIdentifier("thread.menu")
    }
  }

  private func commit(_ action: () -> Void) {
    actionCount += 1
    action()
  }

  private var renamePresented: Binding<Bool> {
    Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
  }

  private var renameText: Binding<String> {
    Binding(get: { renaming ?? "" }, set: { renaming = $0 })
  }
}
