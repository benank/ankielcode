import AnkielKit
import SwiftUI

/// The draft's attachments above the text: image thumbnails and file chips, each with its upload
/// state (a progress ring, or a failure badge that retries), and a remove button.
struct AttachmentStrip: View {
  let target: ComposerTarget
  @Environment(AppModel.self) private var model

  private var store: ComposerStore { model.composer }

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: Spacing.sm) {
        ForEach(store.draft(target.draftKey).attachments) { attachment in
          AttachmentChip(
            attachment: attachment, url: store.fileURL(attachment),
            state: store.uploadState(attachment, environmentId: target.connected ? target.environmentId : nil),
            retry: {
              if let environmentId = target.environmentId {
                store.retryUpload(attachment.id, in: target.draftKey, environmentId: environmentId)
              }
            },
            remove: { store.removeAttachment(attachment.id, from: target.draftKey) })
          .motionTransition(.scale(scale: 0.8).combined(with: .opacity))
        }
      }
      .padding(.horizontal, Spacing.xs)
      .padding(.top, Spacing.xs)
    }
    .scrollIndicators(.hidden)
    // Thumbnails are a fixed size; past this their captions only truncate.
    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    .accessibilityIdentifier("composer.attachments")
  }
}

private struct AttachmentChip: View {
  let attachment: DraftAttachment
  let url: URL
  let state: UploadState?
  let retry: () -> Void
  let remove: () -> Void

  private var failed: Bool { if case .failed = state { true } else { false } }

  var body: some View {
    content
      .overlay { overlay }
      .overlay(alignment: .topTrailing) {
        Button(action: remove) {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(Palette.onPrimaryButton)
            .frame(width: 20, height: 20)
            .background(Palette.primaryButton.opacity(0.85), in: .circle)
            .frame(width: 44, height: 44)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .offset(x: 16, y: -16)
        .accessibilityLabel(Text("Remove \(attachment.name)"))
      }
      .padding(.top, Spacing.xs)
      .padding(.trailing, Spacing.xs)
      .contextMenu {
        if failed { Button("Retry upload", systemImage: "arrow.clockwise", action: retry) }
        Button("Remove", systemImage: "trash", role: .destructive, action: remove)
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel(Text(attachment.name))
      .accessibilityValue(Text(stateDescription))
  }

  @ViewBuilder
  private var content: some View {
    switch attachment.kind {
    case .image:
      LocalImage(url: url, points: 60)
        .frame(width: 60, height: 60)
        .clipShape(.rect(cornerRadius: Radius.medium, style: .continuous))
    case .file:
      HStack(spacing: Spacing.sm) {
        if failed {
          Button(action: retry) {
            Image(systemName: "arrow.clockwise.circle.fill")
              .font(Typography.title)
              .symbolRenderingMode(.palette)
              .foregroundStyle(.white, Palette.danger)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(Text("Retry upload"))
        } else {
          Image(systemName: "doc.text")
            .font(Typography.title)
            .foregroundStyle(Palette.textSecondary)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(attachment.name)
            .font(Typography.footnote.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
            .lineLimit(1)
          Text(attachment.sizeBytes.formatted(.byteCount(style: .file)))
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
        }
      }
      .padding(.horizontal, Spacing.md)
      .frame(maxWidth: 200, minHeight: 60, alignment: .leading)
      .background(Palette.fill, in: .rect(cornerRadius: Radius.medium, style: .continuous))
      .overlay {
        if failed {
          RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).strokeBorder(Palette.danger, lineWidth: 1.5)
        }
      }
    }
  }

  @ViewBuilder
  private var overlay: some View {
    switch state {
    case .uploading(let progress)?:
      ZStack {
        RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).fill(.black.opacity(0.28))
        // A determinate ring that moves only when a coarse progress step lands.
        Circle().stroke(.white.opacity(0.35), lineWidth: 3).frame(width: 24, height: 24)
        Circle().trim(from: 0, to: max(0.04, progress))
          .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
          .rotationEffect(.degrees(-90))
          .frame(width: 24, height: 24)
          .motion(Motion.micro, value: progress)
      }
      .allowsHitTesting(false)
    case .failed? where attachment.kind == .image:
      Button(action: retry) {
        ZStack {
          RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).fill(Palette.danger.opacity(0.16))
          RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).strokeBorder(Palette.danger, lineWidth: 1.5)
          Image(systemName: "arrow.clockwise.circle.fill")
            .font(Typography.title)
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, Palette.danger)
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("Retry upload"))
    default:
      EmptyView()
    }
  }

  private var stateDescription: String {
    switch state {
    case .uploading(let progress)?: String(localized: "Uploading, \(Int(progress * 100)) percent")
    case .failed?: String(localized: "Upload failed")
    case .ready?: String(localized: "Ready")
    case nil: String(localized: "Uploads when sent")
    }
  }
}
