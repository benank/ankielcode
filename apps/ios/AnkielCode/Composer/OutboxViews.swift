import AnkielKit
import ImageIO
import SwiftUI

/// A message the server has not shown yet: the user's bubble at once, with a quiet status
/// (sending, waiting for the computer) or a failure that offers retry, edit and delete.
struct PendingMessageView: View {
  let message: OutboxMessage
  let environmentLabel: String?
  let connected: Bool
  let retry: () -> Void
  let edit: () -> Void
  let delete: () -> Void

  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(alignment: .trailing, spacing: Spacing.xs + 2) {
      let images = message.attachments.filter { $0.kind == .image }
      if !images.isEmpty {
        HStack(spacing: Spacing.sm) {
          ForEach(images) { attachment in
            LocalImage(url: model.composer.fileURL(attachment))
              .frame(width: 112, height: 112)
              .clipShape(.rect(cornerRadius: Radius.medium, style: .continuous))
              .accessibilityLabel(Text(attachment.name))
          }
        }
      }
      let files = message.attachments.filter { $0.kind == .file }
      if !message.text.isEmpty || !files.isEmpty {
        VStack(alignment: .leading, spacing: Spacing.sm) {
          ForEach(files) { file in
            Label(file.name, systemImage: "doc.text")
              .font(Typography.footnote.weight(.medium))
              .foregroundStyle(Palette.textSecondary)
              .lineLimit(1)
          }
          if !message.text.isEmpty {
            Text(message.text)
              .font(Typography.body)
              .foregroundStyle(Palette.textPrimary)
              .lineSpacing(2)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
        }
        .padding(.horizontal, Spacing.lg - 2)
        .padding(.vertical, Spacing.md - 2)
        .background(Palette.userBubble, in: .rect(cornerRadius: Radius.large, style: .continuous))
        .overlay {
          if message.state.isFailed {
            RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
              .strokeBorder(Palette.danger.opacity(0.55), lineWidth: 1)
          }
        }
        .opacity(message.state.isFailed ? 0.85 : 1)
      }
      status
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, Spacing.xxxl)
    .contextMenu {
      if message.state.isFailed {
        Button("Retry", systemImage: "arrow.clockwise", action: retry)
        Button("Edit", systemImage: "pencil", action: edit)
      }
      if message.state != .sending, !message.state.isSent {
        Button("Delete", systemImage: "trash", role: .destructive, action: delete)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("pending.\(message.state.isFailed ? "failed" : message.state.isSent ? "sent" : "sending")")
  }

  @ViewBuilder
  private var status: some View {
    switch message.state {
    case .queued, .sending:
      Label {
        if !connected {
          Text(environmentLabel.map { String(localized: "Waiting for \($0)") } ?? String(localized: "Waiting for the computer"))
        } else {
          Text(message.delivery == .queue ? "Queueing…" : "Sending…")
        }
      } icon: {
        Image(systemName: connected ? "arrow.up.circle" : "clock")
      }
      .font(Typography.caption)
      .foregroundStyle(Palette.textTertiary)
      .labelStyle(.titleAndIcon)
      if !connected, message.state == .queued {
        Button("Delete", role: .destructive, action: delete)
          .font(Typography.footnote)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .tint(Palette.textSecondary)
          .accessibilityIdentifier("pending.delete")
      }
    case .failed(let reason, _):
      VStack(alignment: .trailing, spacing: Spacing.xs) {
        Label {
          Text(reason.map { String(localized: "Not sent · \($0)") } ?? String(localized: "Not sent"))
            .multilineTextAlignment(.trailing)
        } icon: {
          Image(systemName: "exclamationmark.circle.fill")
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.danger)
        HStack(spacing: Spacing.sm) {
          Button("Delete", role: .destructive, action: delete)
            .accessibilityIdentifier("pending.delete")
          Button("Edit", action: edit)
            .accessibilityIdentifier("pending.edit")
          Button("Retry", action: retry)
            .fontWeight(.semibold)
            .accessibilityIdentifier("pending.retry")
        }
        .font(Typography.footnote)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .tint(Palette.textSecondary)
      }
    case .sent:
      EmptyView()
    }
  }
}

/// An attachment's local copy, decoded off the main actor.
struct LocalImage: View {
  let url: URL
  var points: CGFloat = 112
  @State private var image: UIImage?
  @Environment(\.displayScale) private var scale

  var body: some View {
    ZStack {
      Palette.fill
      if let image { Image(uiImage: image).resizable().scaledToFill() }
    }
    .task(id: url) { image = await Self.load(url, pixels: Int(points * scale)) }
  }

  @concurrent
  static func load(_ url: URL, pixels: Int) async -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: pixels,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }
}

/// The user's queued messages above the composer (RN `ThreadQueueControl`): a compact summary
/// that opens to each message with send now, edit and remove.
struct QueuedMessagesBar: View {
  let queued: [ThreadRunActivity.QueuedMessage]
  let held: Bool
  let actions: ComposerActions

  @State private var expanded = false
  @State private var editing: ThreadRunActivity.QueuedMessage?
  @State private var editText = ""
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withMotion(Motion.snappy, reduceMotion: reduceMotion) { expanded.toggle() }
      } label: {
        HStack(spacing: Spacing.sm) {
          Image(systemName: "list.number")
            .foregroundStyle(Palette.textSecondary)
          Text(held ? "\(queued.count) queued · held" : "\(queued.count) queued")
            .font(Typography.footnote.weight(.semibold))
            .foregroundStyle(Palette.textPrimary)
            .contentTransition(.numericText())
          if !expanded, let first = queued.first {
            Text(first.text.isEmpty ? String(localized: "Attachments") : first.text)
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
              .lineLimit(1)
          }
          Spacer(minLength: 0)
          Image(systemName: "chevron.up")
            .font(Typography.caption.weight(.semibold))
            .foregroundStyle(Palette.textTertiary)
            .rotationEffect(.degrees(expanded ? 180 : 0))
        }
        .padding(.horizontal, Spacing.lg)
        .frame(minHeight: 44)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("queue.toggle")
      .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
      if expanded {
        ForEach(Array(queued.enumerated()), id: \.element.id) { index, message in
          Divider().padding(.leading, Spacing.lg)
          row(message, number: index + 1)
            .transition(.opacity)
        }
      }
    }
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.large, style: .continuous))
    .padding(.horizontal, Spacing.md)
    .alert("Edit queued message", isPresented: editPresented) {
      TextField("Message", text: $editText, axis: .vertical)
      Button("Cancel", role: .cancel) {}
      Button("Save") { if let editing { actions.editQueued(editing, text: editText) } }
    }
  }

  private func row(_ message: ThreadRunActivity.QueuedMessage, number: Int) -> some View {
    HStack(spacing: Spacing.md) {
      Text(verbatim: "\(number)")
        .font(Typography.caption.weight(.semibold).monospacedDigit())
        .foregroundStyle(Palette.textTertiary)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: 2) {
        Text(message.text.isEmpty ? String(localized: "Queued message") : message.text)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(2)
        if message.attachmentCount > 0 {
          Text("^[\(message.attachmentCount) attachment](inflect: true)")
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
        }
      }
      Spacer(minLength: 0)
      Button {
        actions.sendQueuedNow(message)
      } label: {
        Image(systemName: "arrow.up")
          .font(Typography.footnote.weight(.bold))
          .foregroundStyle(Palette.textPrimary)
          .frame(width: 30, height: 30)
          .background(Palette.fill, in: .circle)
          .frame(width: 44, height: 44)
          .contentShape(.circle)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("Send now, queued message \(number)"))
      Menu {
        Button("Send now", systemImage: "arrow.up") { actions.sendQueuedNow(message) }
        Button("Edit", systemImage: "pencil") {
          editText = message.text
          editing = message
        }
        Button("Remove", systemImage: "trash", role: .destructive) { actions.removeQueued(message) }
      } label: {
        Image(systemName: "ellipsis")
          .foregroundStyle(Palette.textSecondary)
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .accessibilityLabel(Text("Actions for queued message \(number)"))
    }
    .padding(.leading, Spacing.lg)
    .padding(.trailing, Spacing.xs)
    .padding(.vertical, Spacing.xxs)
  }

  private var editPresented: Binding<Bool> {
    Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })
  }
}

/// One pending message in the feed, with what its status line needs.
struct PendingRow: Hashable, Identifiable {
  var message: OutboxMessage
  var environmentLabel: String?
  var connected: Bool
  var id: String { "pending:\(message.messageId)" }
}

/// A pending row with its actions: a failed message retries, deletes, or goes back to its
/// composer (a new thread's first message goes back to the new-thread flow).
struct PendingRowView: View {
  let row: PendingRow
  @Environment(AppModel.self) private var model

  var body: some View {
    PendingMessageView(
      message: row.message, environmentLabel: row.environmentLabel, connected: row.connected,
      retry: { model.composer.retry(row.message.messageId) },
      edit: edit,
      delete: {
        model.composer.delete(row.message.messageId)
        if row.message.creation != nil { model.navigator.close(threadRef) }
      })
    .id(row.id)
  }

  private var threadRef: ThreadRef { ThreadRef(environmentId: row.message.environmentId, threadId: row.message.threadId) }

  private func edit() {
    if row.message.creation != nil {
      model.composer.restoreToDraft(row.message.messageId, key: ComposerTarget.newThreadKey)
      model.composer.updateDraft(ComposerTarget.newThreadKey) { $0.environmentId = row.message.environmentId }
      model.navigator.close(threadRef)
      model.navigator.newThread()
    } else {
      model.composer.restoreToDraft(row.message.messageId, key: threadRef.key)
    }
  }
}

/// A thread with nothing in it yet.
struct EmptyThreadPrompt: View {
  var body: some View {
    VStack(spacing: Spacing.sm) {
      Image(systemName: "bubble.left.and.text.bubble.right")
        .font(.system(size: 34, weight: .light))
        .foregroundStyle(Palette.textTertiary)
      Text("Nothing here yet")
        .font(Typography.headline)
        .foregroundStyle(Palette.textPrimary)
      Text("Send a message to get the agent started.")
        .font(Typography.subheadline)
        .foregroundStyle(Palette.textSecondary)
        .multilineTextAlignment(.center)
    }
    .padding(Spacing.xl)
    .allowsHitTesting(false)
    .accessibilityElement(children: .combine)
  }
}
