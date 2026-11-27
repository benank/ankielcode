import AnkielKit
import SwiftUI

/// A compact glass capsule on home, shown only while some computer is not healthy (reconnecting,
/// offline, needs pairing, unavailable). Transport status only: a failed subscription on a live
/// socket never shows here. Tapping opens Computers.
struct ConnectionIndicator: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The most serious problem across computers, and how many have one.
  private var problem: (environment: EnvironmentModel, count: Int)? {
    let unhealthy = model.registry.environments.filter { Self.severity($0.status) > 0 }
    guard let worst = unhealthy.max(by: { Self.severity($0.status) < Self.severity($1.status) }) else { return nil }
    return (worst, unhealthy.count)
  }

  /// 0 healthy (or a first attempt still running), then retrying, offline, blocked.
  static func severity(_ status: ConnectionStatus) -> Int {
    switch status {
    case .connected, .connecting: 0
    case .reconnecting: 1
    case .offline: 2
    case .needsPairing, .incompatible, .failed: 3
    }
  }

  var body: some View {
    Group {
      if let problem {
        Button {
          model.sheet = .computers
        } label: {
          HStack(spacing: Spacing.sm) {
            Image(systemName: ConnectionPresentation.symbol(problem.environment.status))
              .foregroundStyle(ConnectionPresentation.tint(problem.environment.status))
              .contentTransition(.symbolEffect(.replace))
            Text(text(problem))
              .lineLimit(1)
          }
          .font(Typography.footnote.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
          .padding(.horizontal, Spacing.xs)
          .frame(minHeight: 28)
        }
        .buttonStyle(.glass)
        .accessibilityHint(Text("Shows your computers and what to try"))
        .transition(.opacity.combined(with: .scale(scale: reduceMotion ? 1 : 0.94)))
      }
    }
    .animation(Motion.resolve(Motion.gentle, reduceMotion: reduceMotion), value: problem?.environment.status)
  }

  private func text(_ problem: (environment: EnvironmentModel, count: Int)) -> String {
    if problem.count > 1, Self.severity(problem.environment.status) > 1 {
      return String(localized: "\(problem.count) computers unavailable")
    }
    return ConnectionPresentation.indicatorText(problem.environment.status, host: problem.environment.label)
  }
}
