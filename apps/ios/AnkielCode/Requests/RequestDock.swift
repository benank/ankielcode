import AnkielKit
import SwiftUI

/// What the thread waits on the user for, docked above the composer as a floating card (the way
/// chat apps present tool confirmations), with the feed still scrollable behind it. One request
/// at a time, in queue order; a count says how many wait. Approvals sit above the composer, which
/// stays so a message can redirect the agent (it declines first, RN's behavior); questions and
/// secrets take the composer's place. After an answer the card turns into a short confirmation;
/// a request on screen that ends elsewhere leaves a short notice.
struct RequestDock: View {
  let queue: [DockRequest]
  let outcomes: [String: RequestOutcome]
  let controller: PendingRequestController
  let canAnswer: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var visible: [DockRequest] { controller.visible(queue) }

  var body: some View {
    VStack(spacing: Spacing.sm) {
      if let notice = controller.notice {
        RequestNoticeView(text: RequestCopy.notice(notice.outcome))
          .task(id: notice.id) {
            try? await Task.sleep(for: .seconds(2.6))
            controller.clearNotice(notice.id)
          }
          .transition(.opacity)
      }
      if let confirmation = controller.confirmation {
        RequestConfirmationView(confirmation: confirmation)
          .task(id: confirmation.id) {
            try? await Task.sleep(for: .seconds(1.1))
            controller.clearConfirmation(confirmation.id)
          }
          .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
      } else if let top = visible.first {
        card(top, position: 1, total: visible.count)
          .id(top.id)
          .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
      }
    }
    .padding(.horizontal, Spacing.md)
    .motion(Motion.snappy, value: controller.confirmation?.id)
    .motion(Motion.snappy, value: visible.first?.id)
    .motion(Motion.micro, value: controller.notice?.id)
    .sensoryFeedback(trigger: controller.confirmation) { _, new in
      switch new?.kind {
      case .allowed?, .answered?, .saved?: .success
      case .declined?, .secretDeclined?: .warning
      case .dismissed?: .impact(weight: .light)
      case nil: nil
      }
    }
    .onChange(of: queue, initial: true) { _, queue in
      controller.observe(queue, outcomes: outcomes)
    }
  }

  @ViewBuilder
  private func card(_ request: DockRequest, position: Int, total: Int) -> some View {
    let header = RequestQueueHeader(position: position, total: total)
    switch request {
    case .approval(let approval, let thread, let from):
      ApprovalCardView(
        approval: approval, from: from, header: header, controller: controller, canAnswer: canAnswer
      ) { option in
        Task { await controller.approve(approval, decision: option.decision, label: option.label, thread: thread) }
      }
    case .question(let input, let thread):
      QuestionCardView(
        input: input, header: header, controller: controller, canAnswer: canAnswer, thread: thread)
    case .secret(let secret, _):
      SecretCardView(
        secret: secret, header: header, controller: controller, canAnswer: canAnswer,
        environmentId: request.thread.environmentId)
    }
  }
}

/// "1 of 3" for a queue of requests.
struct RequestQueueHeader: Equatable {
  let position: Int
  let total: Int
}

/// The floating card every request uses: a glass panel (chrome over the feed, not content), its
/// header, a scrolling body capped in height so the actions below always stay reachable, and
/// the actions pinned at the bottom.
struct RequestCardChrome<Body: View, Actions: View>: View {
  let title: String
  let symbol: String
  var subtitle: String?
  var header: RequestQueueHeader
  /// Shown in the header's trailing corner (a collapse control).
  var accessory: AnyView?
  @ViewBuilder var content: Body
  @ViewBuilder var actions: Actions

  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.md) {
      headerRow.fixedSize(horizontal: false, vertical: true)
      // Sized by its content; only this part gives way when space runs out (keyboard, large
      // text), so the header and the actions always stay on screen.
      ScrollView {
        VStack(alignment: .leading, spacing: Spacing.md) { content }
          .frame(maxWidth: .infinity, alignment: .leading)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(maxHeight: contentHeight > 0 ? contentHeight : nil)
      actions.fixedSize(horizontal: false, vertical: true)
    }
    .padding(Spacing.lg)
    .frame(maxWidth: 760, alignment: .leading)
    .background {
      if reduceTransparency {
        RoundedRectangle(cornerRadius: Radius.sheet, style: .continuous).fill(Palette.surfaceRaised)
      }
    }
    .glassEffect(reduceTransparency ? .identity : .regular, in: .rect(cornerRadius: Radius.sheet, style: .continuous))
    .accessibilityElement(children: .contain)
  }

  private var headerRow: some View {
      HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
        Image(systemName: symbol)
          .font(Typography.subheadline.weight(.semibold))
          .foregroundStyle(Palette.attention)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(Typography.headline)
            .foregroundStyle(Palette.textPrimary)
            .accessibilityAddTraits(.isHeader)
          if let subtitle {
            Text(subtitle)
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
          }
        }
        Spacer(minLength: Spacing.sm)
        if header.total > 1 {
          Text("\(header.position) of \(header.total)")
            .font(Typography.footnote.monospacedDigit())
            .foregroundStyle(Palette.textSecondary)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xxs)
            .background(Palette.fill, in: .capsule)
            .contentTransition(.numericText())
            .accessibilityLabel(Text("Request \(header.position) of \(header.total)"))
            .accessibilityIdentifier("request.count")
        }
        if let accessory { accessory }
      }
  }
}

/// The request's text in a quiet opaque block: commands and paths in mono, wrapping, selectable.
struct RequestDetailBlock: View {
  let text: String
  var mono = true

  var body: some View {
    Text(text)
      .font(mono ? Typography.mono : Typography.callout)
      .foregroundStyle(Palette.textPrimary)
      .lineSpacing(2)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .padding(Spacing.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.medium, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
          .strokeBorder(Palette.separator, lineWidth: 0.5)
      }
      .accessibilityIdentifier("request.detail")
  }
}

/// How a request button looks: the one primary action filled, others quieter.
enum RequestButtonRole {
  case primary, secondary, quiet
}

struct RequestButton: View {
  let title: String
  let role: RequestButtonRole
  var sending = false
  var disabled = false
  var identifier: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        Text(title)
          .font(Typography.body.weight(role == .quiet ? .regular : .semibold))
          .multilineTextAlignment(.center)
          .opacity(sending ? 0 : 1)
        if sending {
          ProgressView()
            .controlSize(.small)
            .tint(role == .primary ? Palette.onPrimaryButton : Palette.textPrimary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, Spacing.sm)
      .contentShape(.rect)
    }
    .buttonStyle(RequestButtonLook(role: role, sending: sending))
    .disabled(disabled || sending)
    .accessibilityIdentifier(identifier ?? "")
    .accessibilityValue(sending ? Text("Sending") : Text(""))
  }
}

/// Filled for the primary action, a quiet fill for the secondary, text only for the rest. Disabled
/// buttons fade instead of turning into dark slabs.
private struct RequestButtonLook: ButtonStyle {
  let role: RequestButtonRole
  /// The tapped button stays solid while its answer is on the way.
  var sending = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(foreground)
      .background {
        switch role {
        case .primary: Capsule().fill(Palette.primaryButton)
        case .secondary: Capsule().fill(Palette.fill)
        case .quiet: EmptyView()
        }
      }
      .opacity(isEnabled || sending ? (configuration.isPressed ? 0.7 : 1) : 0.4)
      .scaleEffect(configuration.isPressed && role != .quiet ? 0.98 : 1)
      .animation(Motion.microFast, value: configuration.isPressed)
  }

  private var foreground: Color {
    switch role {
    case .primary: Palette.onPrimaryButton
    case .secondary: Palette.textPrimary
    case .quiet: Palette.textSecondary
    }
  }
}

/// A line under the actions: why the card cannot be answered, or what went wrong.
struct RequestFootnote: View {
  let text: String
  var isError = false

  var body: some View {
    Label {
      Text(text)
    } icon: {
      Image(systemName: isError ? "exclamationmark.circle.fill" : "info.circle")
    }
    .font(Typography.footnote)
    .foregroundStyle(isError ? Palette.danger : Palette.textSecondary)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier(isError ? "request.error" : "request.note")
    .accessibilityAddTraits(isError ? .updatesFrequently : [])
  }
}

/// The card's place for a moment after an answer went through.
struct RequestConfirmationView: View {
  let confirmation: PendingRequestController.Confirmation
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  var body: some View {
    let copy = RequestCopy.confirmation(confirmation.kind)
    let tint: Color =
      switch confirmation.kind {
      case .allowed, .answered, .saved: Palette.success
      default: Palette.textSecondary
      }
    HStack(spacing: Spacing.sm) {
      Image(systemName: copy.symbol)
        .font(Typography.headline)
        .foregroundStyle(tint)
        .symbolEffect(.bounce, value: confirmation.id)
      Text(copy.title).font(Typography.subheadline.weight(.semibold)).foregroundStyle(Palette.textPrimary)
      if let detail = copy.detail {
        Text(detail).font(Typography.subheadline).foregroundStyle(Palette.textSecondary).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Spacing.lg)
    .frame(minHeight: 52)
    .frame(maxWidth: 760)
    .background {
      if reduceTransparency { Capsule().fill(Palette.surfaceRaised) }
    }
    .glassEffect(reduceTransparency ? .identity : .regular, in: .capsule)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("request.confirmation")
  }
}

struct RequestNoticeView: View {
  let text: String

  var body: some View {
    Label {
      Text(verbatim: text)
    } icon: {
      Image(systemName: "info.circle").foregroundStyle(Palette.textSecondary)
    }
    .font(Typography.footnote.weight(.medium))
    .foregroundStyle(Palette.textPrimary)
    .padding(.horizontal, Spacing.md)
    .padding(.vertical, Spacing.sm)
    .chromeGlass()
    .accessibilityIdentifier("request.notice")
  }
}
