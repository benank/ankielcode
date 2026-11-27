import AnkielKit
import SwiftUI

/// A pending approval: what is asked (the command in mono, wrapping, before anything else), why,
/// and exactly the choices the provider offers. RN `PendingApprovalCard`.
struct ApprovalCardView: View {
  let approval: PendingApproval
  /// The child thread's title when a subagent asks.
  let from: String?
  let header: RequestQueueHeader
  let controller: PendingRequestController
  let canAnswer: Bool
  let choose: (ApprovalOption) -> Void

  @State private var explaining = false

  private var options: [ApprovalOption] { ApprovalChoices.options(approval, labels: RequestCopy.labels) }

  private var sendingDecision: String? {
    if case .sending(let choice) = controller.phase(approval.requestId) { choice } else { nil }
  }

  private var error: EnvironmentRequestError? {
    if case .failed(let error) = controller.phase(approval.requestId) { error } else { nil }
  }

  private var subtitle: String? {
    [from.map { String(localized: "Approval from \($0)") }, approval.appName].compactMap { $0 }.first
  }

  var body: some View {
    RequestCardChrome(
      title: RequestCopy.approvalTitle(approval.requestKind), symbol: RequestCopy.approvalSymbol(approval.requestKind),
      subtitle: subtitle, header: header
    ) {
      if from != nil, let appName = approval.appName {
        Text(appName).font(Typography.subheadline).foregroundStyle(Palette.textSecondary)
      }
      if let detail = approval.detail {
        RequestDetailBlock(text: detail, mono: ["command", "file-change", "file-read"].contains(approval.requestKind))
      }
      if let reason = approval.reason {
        Text(reason)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let override = approval.fullAccessOverride {
        DisclosureGroup(isExpanded: $explaining) {
          Text(RequestCopy.fullAccessExplanation(override))
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Spacing.xs)
        } label: {
          Text(RequestCopy.fullAccessQuestion).font(Typography.footnote.weight(.medium)).foregroundStyle(Palette.textSecondary)
        }
        .tint(Palette.textSecondary)
      }
      if let warning = ApprovalChoices.warning(options) {
        Label(warning, systemImage: "exclamationmark.triangle")
          .font(Typography.footnote)
          .foregroundStyle(Palette.attention)
          .fixedSize(horizontal: false, vertical: true)
      }
    } actions: {
      VStack(spacing: Spacing.sm) {
        ForEach(Array(options.enumerated()), id: \.offset) { index, option in
          RequestButton(
            title: option.label, role: role(option, index: index), sending: sendingDecision == option.decision,
            disabled: !approval.isLive || !canAnswer || sendingDecision != nil, identifier: "approval.\(option.decision)"
          ) {
            choose(option)
          }
        }
        if !approval.isLive {
          RequestFootnote(text: RequestCopy.notResumable)
        } else if !canAnswer {
          RequestFootnote(text: String(localized: "This connection cannot respond to approvals."))
        }
        if let error {
          RequestFootnote(
            text: RequestCopy.failure(error, fallback: String(localized: "Failed to submit approval decision.")), isError: true)
        }
      }
    }
    .accessibilityIdentifier("request.approval")
  }

  /// RN tones: "accept" is the primary action, "acceptForSession" secondary, the rest quiet. When
  /// the provider offers no plain accept, its first allow-like choice leads.
  private func role(_ option: ApprovalOption, index: Int) -> RequestButtonRole {
    let primary = options.first { $0.decision == "accept" }?.decision ?? options.first { ApprovalChoices.isAllow($0.decision) }?.decision
    if option.decision == primary { return .primary }
    return ApprovalChoices.isAllow(option.decision) ? .secondary : .quiet
  }
}
