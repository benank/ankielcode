import AnkielKit
import SwiftUI

/// "Add Comment" (RN `ReviewCommentComposerSheet`): the picked lines and a comment, added to the
/// thread's composer draft as a review comment the agent reads with the diff.
struct ReviewCommentSheet: View {
  let target: ReviewCommentTarget
  let threadRef: ThreadRef
  let done: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @FocusState private var focused: Bool

  private var selectionLabel: String {
    let first = target.lines.first.flatMap { $0.newNumber ?? $0.oldNumber }
    let last = target.lines.last.flatMap { $0.newNumber ?? $0.oldNumber }
    if target.lines.count == 1 {
      return first.map { String(localized: "Line \($0)") } ?? String(localized: "File comment")
    }
    if let first, let last { return String(localized: "Lines \(first)-\(last)") }
    return String(localized: "\(target.lines.count) lines selected")
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: Spacing.lg) {
          VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(verbatim: selectionLabel)
              .font(Typography.footnote.weight(.semibold))
              .foregroundStyle(Palette.textSecondary)
            Text(verbatim: target.filePath)
              .font(Typography.monoSmall)
              .foregroundStyle(Palette.textTertiary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          preview
          TextField("Add a comment", text: $text, axis: .vertical)
            .lineLimit(3...10)
            .focused($focused)
            .padding(Spacing.md)
            .background(Palette.fill, in: .rect(cornerRadius: Radius.field))
            .accessibilityIdentifier("review.comment.text")
        }
        .padding(Spacing.lg)
      }
      .scrollDismissesKeyboard(.interactively)
      .navigationTitle("Add Comment")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(action: submit) { Text("Comment", comment: "verb, submit button") }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("review.comment.submit")
        }
      }
      .onAppear { focused = true }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  /// Up to five of the picked lines (RN `REVIEW_COMMENT_PREVIEW_MAX_LINES`).
  private var preview: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(target.lines.prefix(5).enumerated()), id: \.offset) { _, line in
        HStack(spacing: Spacing.sm) {
          Text(verbatim: (line.newNumber ?? line.oldNumber).map(String.init) ?? "")
            .foregroundStyle(Palette.diffGutter)
            .frame(minWidth: 28, alignment: .trailing)
          Text(verbatim: line.kind == .added ? "+" : line.kind == .removed ? "−" : " ")
            .foregroundStyle(line.kind == .added ? Palette.diffAdded : Palette.diffRemoved)
          Text(verbatim: line.text.isEmpty ? " " : line.text)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .font(Typography.monoSmall)
        .padding(.vertical, 2)
        .padding(.horizontal, Spacing.sm)
        .background(line.kind == .added ? Palette.diffAddedRow : line.kind == .removed ? Palette.diffRemovedRow : .clear)
      }
      if target.lines.count > 5 {
        Text("\(target.lines.count - 5) more lines")
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
          .padding(Spacing.sm)
      }
    }
    .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.medium))
    .clipShape(.rect(cornerRadius: Radius.medium))
    .accessibilityElement(children: .combine)
  }

  private func submit() {
    let block = target.block(comment: text)
    let key = threadRef.key
    model.composer.setText(ReviewCommentTarget.append(block, to: model.composer.draft(key).text), for: key)
    Haptics.success()
    done()
    dismiss()
  }
}
