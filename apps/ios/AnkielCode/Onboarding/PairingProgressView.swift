import AnkielKit
import SwiftUI

/// The pairing sheet: confirm a link's host, the steps as they happen, then success or a
/// specific failure with what to do next.
struct PairingProgressView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var phase: PairingFlow.Phase { model.pairing.phase }

  var body: some View {
    ScrollView {
      content
        .frame(maxWidth: .infinity)
        .transition(.opacity.combined(with: .scale(scale: reduceMotion ? 1 : 0.98)))
        .id(phaseKey)
        .padding(.horizontal, Spacing.xl)
        .padding(.top, Spacing.xxl)
        .padding(.bottom, Spacing.lg)
    }
    .scrollBounceBehavior(.basedOnSize)
    .animation(Motion.resolve(Motion.transition, reduceMotion: reduceMotion), value: phaseKey)
    .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.height(440), .large])
    .presentationDragIndicator(.visible)
    // Opaque: a glass sheet would refract the welcome screen's glass buttons behind it.
    .presentationBackground(Palette.canvas)
    .interactiveDismissDisabled(model.pairing.isWorking)
    .sensoryFeedback(.selection, trigger: stepIndex)
  }

  /// Steps animate within one card; confirm, success and failure swap the card.
  private var phaseKey: String {
    switch phase {
    case .idle: "idle"
    case .confirm: "confirm"
    case .working: "working"
    case .failed: "failed"
    case .succeeded: "succeeded"
    }
  }

  private var stepIndex: Int {
    if case .working(let step, _) = phase { PairingSteps.index(step) } else { -1 }
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .idle:
      EmptyView()
    case .confirm(let target):
      ConfirmCard(target: target)
    case .working(let step, let host):
      PairingSteps(step: step, host: host)
    case .failed(let problem):
      FailureCard(problem: problem)
    case .succeeded(let host):
      SuccessCard(host: host)
    }
  }
}

private struct ConfirmCard: View {
  @Environment(AppModel.self) private var model
  let target: PairingTarget

  var body: some View {
    VStack(spacing: Spacing.lg) {
      BrandMark(size: 56)
      VStack(spacing: Spacing.sm) {
        Text("Pair with this computer?")
          .font(Typography.title)
          .foregroundStyle(Palette.textPrimary)
        Text(PairingLinkView.displayAddress(target.endpoint))
          .font(Typography.mono)
          .foregroundStyle(Palette.textPrimary)
          .padding(.horizontal, Spacing.md)
          .padding(.vertical, Spacing.sm)
          .background(Palette.fill, in: .rect(cornerRadius: Radius.medium, style: .continuous))
          .textSelection(.enabled)
        Text("Only pair with computers you own. It will be able to show this device its threads.")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
      }
      ActionButtons(
        primary: ("Pair", { model.pairing.run(target) }),
        secondary: ("Cancel", { model.finishPairing() }))
    }
  }
}

private struct PairingSteps: View {
  let step: PairingStep
  let host: String

  static func index(_ step: PairingStep) -> Int {
    switch step {
    case .checkingServer: 0
    case .exchangingCode: 1
    case .connecting: 2
    }
  }

  var body: some View {
    let current = Self.index(step)
    VStack(spacing: Spacing.xl) {
      BrandMark(size: 56)
      VStack(spacing: Spacing.xs) {
        Text("Pairing with \(host)")
          .font(Typography.title)
          .foregroundStyle(Palette.textPrimary)
          .multilineTextAlignment(.center)
        Text("Keep the app open for a moment.")
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
      }
      VStack(alignment: .leading, spacing: Spacing.md) {
        StepRow(title: "Checking the computer", state: state(0, current))
        StepRow(title: "Exchanging the pairing code", state: state(1, current))
        StepRow(title: "Connecting", state: state(2, current))
      }
      .padding(Spacing.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))
    }
  }

  private func state(_ index: Int, _ current: Int) -> StepRow.State {
    index < current ? .done : index == current ? .active : .pending
  }
}

private struct StepRow: View {
  enum State { case pending, active, done }
  let title: LocalizedStringKey
  let state: State

  var body: some View {
    HStack(spacing: Spacing.md) {
      ZStack {
        switch state {
        case .done:
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(Palette.success)
            .motionTransition(.scale.combined(with: .opacity))
        case .active:
          ProgressView()
            .controlSize(.small)
        case .pending:
          Image(systemName: "circle")
            .foregroundStyle(Palette.textTertiary)
        }
      }
      .font(.body)
      .frame(width: 24, height: 24)
      .accessibilityHidden(true)
      Text(title)
        .font(Typography.body)
        .foregroundStyle(state == .pending ? Palette.textTertiary : Palette.textPrimary)
    }
    .motion(Motion.micro, value: state)
    .accessibilityElement(children: .combine)
    .accessibilityValue(
      state == .done ? Text("Done") : state == .active ? Text("In progress") : Text("Waiting"))
  }
}

private struct FailureCard: View {
  @Environment(AppModel.self) private var model
  let problem: PairingProblem

  var body: some View {
    VStack(spacing: Spacing.lg) {
      Image(systemName: problem.systemImage)
        .font(.system(size: 40, weight: .regular))
        .foregroundStyle(Palette.danger)
        .symbolEffect(.bounce, options: .nonRepeating)
        .frame(height: 56)
        .accessibilityHidden(true)
      VStack(spacing: Spacing.sm) {
        Text(problem.title)
          .font(Typography.title)
          .foregroundStyle(Palette.textPrimary)
          .multilineTextAlignment(.center)
        Text(problem.message)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let updates = problem.updates {
        ActionButtons(
          primary: ("Update \(updates.label)", { model.pairing.update(updates.environmentId) }),
          secondary: ("Cancel", { model.finishPairing() }))
      } else if problem.canRetry {
        ActionButtons(
          primary: ("Try again", { model.pairing.retry() }),
          secondary: ("Close", { model.finishPairing() }))
      } else {
        ActionButtons(
          primary: ("Scan a new code", {
            model.finishPairing()
            model.showScanner()
          }),
          secondary: ("Close", { model.finishPairing() }))
      }
    }
  }
}

private struct SuccessCard: View {
  @Environment(AppModel.self) private var model
  let host: String

  var body: some View {
    VStack(spacing: Spacing.lg) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 48))
        .foregroundStyle(Palette.success)
        .symbolEffect(.bounce, options: .nonRepeating)
        .frame(height: 56)
        .accessibilityHidden(true)
      Text("Paired with \(host)")
        .font(Typography.title)
        .foregroundStyle(Palette.textPrimary)
        .multilineTextAlignment(.center)
      ActionButtons(primary: ("Continue", { model.finishPairing() }), secondary: nil)
    }
  }
}

private struct ActionButtons: View {
  let primary: (LocalizedStringKey, () -> Void)
  let secondary: (LocalizedStringKey, () -> Void)?

  var body: some View {
    GlassEffectContainer(spacing: Spacing.md) {
      VStack(spacing: Spacing.sm) {
        Button(action: primary.1) {
          Text(primary.0)
            .font(Typography.headline)
            .foregroundStyle(Palette.onAccent)
            .frame(maxWidth: .infinity, minHeight: 30)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        if let secondary {
          Button(action: secondary.1) {
            Text(secondary.0)
              .font(Typography.headline)
              .frame(maxWidth: .infinity, minHeight: 30)
          }
          .buttonStyle(.glass)
          .controlSize(.large)
        }
      }
    }
  }
}
