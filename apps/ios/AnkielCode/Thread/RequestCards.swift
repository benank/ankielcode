import AnkielKit
import SwiftUI

/// How a pending card answers. Phase 7 passes real handlers; until then the cards render their
/// choices disabled, so the layout is final and only the wiring is missing.
struct RequestResponder {
  var approve: ((ApprovalCard, ApprovalOption) -> Void)?
  var answer: ((QuestionCard, [String: [String]]) -> Void)?

  static let readOnly = RequestResponder()
}

/// A pending approval at the tail of the thread.
struct ApprovalCardView: View, Equatable {
  let card: ApprovalCard
  var responder: RequestResponder = .readOnly

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.card == rhs.card }

  /// `ProviderApprovalDecision` defaults when the request lists no options (spec §6.6).
  private var options: [ApprovalOption] {
    card.options.isEmpty
      ? [
        ApprovalOption(decision: "accept", label: String(localized: "Allow once"), warning: nil),
        ApprovalOption(decision: "acceptForSession", label: String(localized: "Allow for this session"), warning: nil),
        ApprovalOption(decision: "decline", label: String(localized: "Decline"), warning: nil),
      ]
      : card.options
  }

  var body: some View {
    RequestCardChrome(
      title: title, systemImage: card.requestKind == "permission" ? "lock" : "hand.raised",
      capability: card.capability, answerable: responder.approve != nil
    ) {
      if let prompt = card.prompt, !prompt.isEmpty {
        Text(prompt)
          .font(card.requestKind == "command" ? Typography.monoSmall : Typography.subheadline)
          .foregroundStyle(Palette.textPrimary)
          .padding(Spacing.md)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.small, style: .continuous))
          .textSelection(.enabled)
      }
      if let reason = card.reason, !reason.isEmpty {
        Text(reason).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
      }
      VStack(spacing: Spacing.sm) {
        ForEach(options, id: \.decision) { option in
          Button {
            responder.approve?(card, option)
          } label: {
            Text(option.label)
              .font(Typography.subheadline.weight(.medium))
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
          .tint(option.decision.hasPrefix("accept") ? Palette.accent : Palette.textSecondary)
          .disabled(responder.approve == nil)
        }
      }
    }
  }

  private var title: String {
    switch card.requestKind {
    case "command": String(localized: "Run this command?")
    case "file-change": String(localized: "Allow this file change?")
    case "file-read": String(localized: "Allow reading this file?")
    case "permission": String(localized: "Permission requested")
    default: String(localized: "Approval requested")
    }
  }
}

/// A pending question at the tail of the thread.
struct QuestionCardView: View, Equatable {
  let card: QuestionCard
  var responder: RequestResponder = .readOnly

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.card == rhs.card }

  var body: some View {
    RequestCardChrome(
      title: String(localized: "Input requested"), systemImage: "questionmark.bubble", capability: card.capability,
      answerable: responder.answer != nil
    ) {
      ForEach(card.questions) { question in
        VStack(alignment: .leading, spacing: Spacing.sm) {
          if !question.header.isEmpty {
            Text(question.header)
              .font(Typography.caption.weight(.semibold))
              .foregroundStyle(Palette.textTertiary)
              .textCase(.uppercase)
          }
          Text(question.question)
            .font(Typography.subheadline.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          ForEach(question.options.elements, id: \.label) { option in
            HStack(alignment: .top, spacing: Spacing.sm) {
              Image(systemName: question.multiSelect == true ? "square" : "circle")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textTertiary)
              VStack(alignment: .leading, spacing: 2) {
                Text(option.label).font(Typography.subheadline).foregroundStyle(Palette.textPrimary)
                if !option.description.isEmpty {
                  Text(option.description).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
                }
              }
              Spacer(minLength: 0)
            }
            .padding(.vertical, Spacing.xs)
          }
        }
      }
    }
  }
}

private struct RequestCardChrome<Content: View>: View {
  let title: String
  let systemImage: String
  let capability: RuntimeRequest.ResponseCapability?
  let answerable: Bool
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.md) {
      Label(title, systemImage: systemImage)
        .font(Typography.subheadline.weight(.semibold))
        .foregroundStyle(Palette.textPrimary)
        .symbolRenderingMode(.hierarchical)
      content
      if let note {
        Text(note)
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .padding(Spacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surfaceRaised, in: .rect(cornerRadius: Radius.large, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        .strokeBorder(Palette.attention.opacity(0.45), lineWidth: 1)
    }
    .accessibilityElement(children: .contain)
  }

  private var note: String? {
    if capability?.type == "not_resumable" {
      return capability?.reason ?? String(localized: "This request can no longer be answered.")
    }
    return answerable ? nil : String(localized: "Answer from the desktop app for now.")
  }
}
