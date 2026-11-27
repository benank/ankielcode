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
  @State private var dockHeight: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var childApprovals = ChildApprovals()
  @State private var feedbackBlocked = false

  private var row: ThreadRow? { model.home.row(threadRef) }
  private var shell: ThreadShell? { model.home.thread(threadRef) }
  private var environment: EnvironmentModel? { model.registry.environment(threadRef.environmentId) }

  private var pendingCreation: OutboxMessage? {
    model.composer.outbox.first { $0.threadKey == threadRef.key && $0.creation != nil }
  }

  private var title: String {
    let title = detail.state.title ?? shell?.title ?? row?.title ?? pendingCreation?.creation?.title ?? ""
    // Blank while the thread loads, so its real title does not replace a placeholder.
    guard title.isEmpty, detail.state.isLoaded || awaitingCreation else { return title }
    return String(localized: "New thread")
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
      .onChange(of: childShells, initial: true) { _, threads in
        childApprovals.update(parent: threadRef, threads: threads, model: model)
      }
      .onDisappear { childApprovals.close(model) }
      .alert("Approval feedback", isPresented: $feedbackBlocked) {
        Button("OK", role: .cancel) {}
      } message: {
        Text("Send approval feedback without attachments or added context.")
      }
      .onChange(of: detail.state.messageIds, initial: true) { _, known in
        model.composer.reconcile(threadRef.key, known: known)
      }
      .sensoryFeedback(.impact(weight: .light), trigger: actionCount)
      .sensoryFeedback(.error, trigger: failedSends) { old, new in new > old }
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
        ThreadTimelineView(
          model: detail, images: images, openThread: openChild, pending: pendingRows, trailingSpace: dockHeight)
          .overlay(alignment: .top) { staleNotice }
          .overlay(alignment: .bottom) { dock }
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

  private var requests: PendingRequestController { model.requests(threadRef) }

  /// Pending requests in the order the dock works through them.
  private var queue: [DockRequest] {
    guard !awaitingCreation else { return [] }
    return DockRequest.queue(detail.state.pending, thread: threadRef, children: childApprovals.approvals)
  }

  /// Floats over the feed's end, above the composer: out of the scroll view's safe area, so a
  /// tall card (or the keyboard) never leaves the feed a sliver; the feed adds the same room after
  /// its last row instead.
  private var dock: some View {
    RequestDock(queue: queue, outcomes: detail.state.outcomes, controller: requests, canAnswer: model.canAnswer(threadRef))
      .padding(.top, Spacing.xxl)
      .padding(.bottom, Spacing.sm)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
        dockHeight = height > Spacing.xxl + Spacing.sm + 1 ? height - Spacing.xxl : 0
      }
  }

  /// Shell rows under this thread that ask for an approval (subagents, side chats).
  private var childShells: [ThreadShell] {
    let threads = environment?.shell.threads ?? []
    return ChildApprovalScan.children(of: threadRef.threadId, in: threads)
  }

  @ViewBuilder
  private var composer: some View {
    let target = target
    let queue = queue
    let top = requests.visible(queue).first
    // Questions and secrets take the composer's place; an approval leaves it, so a message can
    // redirect the agent instead (RN).
    let hidesComposer: Bool =
      switch top {
      case .question?, .secret?: true
      default: false
      }
    VStack(spacing: Spacing.sm) {
      if !target.activity.queued.isEmpty {
        QueuedMessagesBar(
          queued: target.activity.queued, held: target.activity.queueHeld, actions: ComposerActions(model: model, target: target)
        )
        .motionTransition(.move(edge: .bottom).combined(with: .opacity))
      }
      if !awaitingCreation, !hidesComposer {
        ComposerView(target: target) { delivery in
          send(delivery, target: target, queue: queue)
        }
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
      }
    }
    .frame(maxWidth: Layout.readingWidth)
    .frame(maxWidth: .infinity)
    .motion(Motion.snappy, value: target.activity.queued.map(\.id))
    .motion(Motion.snappy, value: hidesComposer)
  }

  /// A message sent while approvals wait answers them first (RN `handleSendMessage`): as decline
  /// feedback when the provider takes it, else by declining every one before the message goes.
  private func send(_ delivery: MessageDelivery, target: ComposerTarget, queue: [DockRequest]) {
    // Only this thread's own approvals: a subagent's request is answered on its card (RN keeps
    // child approvals in a separate list the composer never touches).
    let approvals: [(PendingApproval, ThreadRef)] = requests.visible(queue).compactMap { request in
      if case .approval(let approval, let thread, _) = request, thread == threadRef { (approval, thread) } else { nil }
    }
    let questionWaits = queue.contains { if case .question = $0 { true } else { false } }
    guard !approvals.isEmpty, !questionWaits, model.canAnswer(threadRef) else {
      model.composer.send(threadRef.key, to: threadRef, delivery: delivery, thread: target.threadSettings)
      return
    }
    let draft = model.composer.draft(threadRef.key)
    let key = threadRef.key
    let ref = threadRef
    let settings = target.threadSettings
    Task {
      switch await requests.redirect(approvals, text: draft.text, hasAttachments: !draft.attachments.isEmpty) {
      case .none, .declined:
        // A draft edited during the declines is not what the user sent; it stays for another tap.
        guard model.composer.draft(key).text == draft.text else { return }
        model.composer.send(key, to: ref, delivery: delivery, thread: settings)
      case .responded:
        if model.composer.draft(key).text == draft.text { model.composer.setText("", for: key) }
      case .attachmentsNotAllowed:
        feedbackBlocked = true
      case .failed:
        break
      }
    }
  }

  /// Messages of this thread the server refused or that gave up retrying.
  private var failedSends: Int {
    model.composer.outbox.count { message in
      guard message.threadKey == threadRef.key, case .failed = message.state else { return false }
      return true
    }
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
