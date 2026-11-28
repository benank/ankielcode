import AnkielKit
import SwiftUI
import UIKit

/// The user's message: a soft bubble on the trailing side, image thumbnails above it, file chips
/// inside it, and long messages folded (RN `CollapsibleUserMessageBody`).
struct UserMessageView: View, Equatable {
  let row: UserMessageRow
  let expanded: Bool
  let images: ThreadImages
  let toggle: () -> Void
  @Environment(\.filePresenter) private var files

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.images == rhs.images
  }

  /// RN folds a message at least twice the folded height; lines stand in for points here.
  private var foldable: Bool {
    row.text.count > 900 || row.text.reduce(0) { $1 == "\n" ? $0 + 1 : $0 } > 14
  }

  /// Mentions the composer wrote (`[name](path)`, `@path`) read as file links by name.
  static func withFileLinks(_ text: String) -> AttributedString {
    var result = AttributedString()
    for run in ComposerInlineTokens.runs(text) {
      var part = AttributedString(run.text)
      if let path = run.path, let url = URL(string: ComposerFileLink.encodeDestination(path)) {
        part.link = url
        part.underlineStyle = .single
      }
      result += part
    }
    return result
  }

  private var imageAttachments: [ChatAttachment] { row.attachments.filter(\.isImage) }
  private var fileAttachments: [ChatAttachment] { row.attachments.filter { !$0.isImage } }

  var body: some View {
    VStack(alignment: .trailing, spacing: Spacing.sm) {
      if row.freshContext {
        ContextDivider(label: String(localized: "New session"), systemImage: "arrow.clockwise")
      }
      if row.fromAgent {
        Text("Sent by an agent")
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
      }
      if !imageAttachments.isEmpty {
        HStack(spacing: Spacing.sm) {
          ForEach(imageAttachments) { attachment in
            RemoteImage(source: .attachment(attachment), images: images, maxPixel: 480, contentMode: .fill) {
              Palette.fill.overlay { Image(systemName: "photo").foregroundStyle(Palette.textTertiary) }
            }
            .frame(width: 112, height: 112)
            .clipShape(.rect(cornerRadius: Radius.medium, style: .continuous))
            .galleryThumbnail(ThreadImage.id(itemId: row.itemId, source: .attachment(attachment)))
            .accessibilityLabel(Text(attachment.name))
          }
        }
      }
      if !row.text.isEmpty || !fileAttachments.isEmpty {
        VStack(alignment: .leading, spacing: Spacing.sm) {
          ForEach(fileAttachments) { attachment in
            Button { files?.open(attachment: attachment) } label: { FileChip(attachment: attachment) }
              .buttonStyle(.plain)
              .disabled(files == nil)
              .accessibilityHint(Text("Opens the file"))
          }
          if !row.text.isEmpty {
            Text(Self.withFileLinks(row.text))
              .font(Typography.body)
              .foregroundStyle(Palette.textPrimary)
              .lineSpacing(2)
              .lineLimit(foldable && !expanded ? 8 : nil)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
          if foldable {
            Button(action: toggle) {
              Text(expanded ? "Show less" : "Show full message")
                .font(Typography.footnote.weight(.medium))
                .foregroundStyle(Palette.textSecondary)
                .frame(minHeight: 32)
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
          }
        }
        .padding(.horizontal, Spacing.lg - 2)
        .padding(.vertical, Spacing.md - 2)
        .background(Palette.userBubble, in: .rect(cornerRadius: Radius.large, style: .continuous))
        .contextMenu {
          Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = row.text }
        }
      }
      if row.isSteer {
        Label("Sent while working", systemImage: "arrow.turn.down.right")
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, Spacing.xxxl)
  }
}

private struct FileChip: View {
  let attachment: ChatAttachment

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Image(systemName: "doc")
        .foregroundStyle(Palette.textSecondary)
      VStack(alignment: .leading, spacing: 0) {
        Text(attachment.name).font(Typography.footnote.weight(.medium)).lineLimit(1)
        Text(attachment.sizeBytes.formatted(.byteCount(style: .file)))
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .padding(Spacing.sm)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.small, style: .continuous))
  }
}

/// An assistant reply: full width, no bubble, rich markdown. The settled turn's last reply gets a
/// quiet footer with copy and its time.
struct AssistantMessageView: View, Equatable {
  let row: AssistantMessageRow
  let images: ThreadImages
  @State private var copied = 0

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row && lhs.images == rhs.images }

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      MarkdownView(document: row.document, images: images, streaming: row.streaming)
        .environment(\.mediaOwner, row.itemId)
      if let footer = row.footer {
        HStack(spacing: Spacing.xs) {
          Button {
            UIPasteboard.general.string = row.text
            copied += 1
          } label: {
            Image(systemName: copied > 0 ? "checkmark" : "doc.on.doc")
              .contentTransition(.symbolEffect(.replace))
              .font(Typography.footnote)
              .foregroundStyle(Palette.textTertiary)
              .frame(width: 36, height: 36)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(Text("Copy message"))
          .sensoryFeedback(.success, trigger: copied)
          if let date = footer.date {
            Text(date, format: .dateTime.hour().minute())
              .font(Typography.caption.monospacedDigit())
              .foregroundStyle(Palette.textTertiary)
          }
        }
        .padding(.leading, -Spacing.sm)
        .chromeTextSize()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A centered divider for session boundaries, compactions and handoffs.
struct ContextDivider: View {
  let label: String
  let systemImage: String

  var body: some View {
    HStack(spacing: Spacing.sm) {
      line
      Label(label, systemImage: systemImage)
        .font(Typography.caption)
        .foregroundStyle(Palette.textTertiary)
        .lineLimit(2)
        .multilineTextAlignment(.center)
        .layoutPriority(1)
      line
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  private var line: some View {
    Rectangle().fill(Palette.separator).frame(height: 0.5)
  }
}
