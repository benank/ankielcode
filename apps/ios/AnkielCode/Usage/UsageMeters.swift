import AnkielKit
import SwiftUI

/// A thin capsule meter: the remaining (or used) share filled, with an optional tick for where
/// even pace would be. Values change with a one-shot fill animation, never a running one.
struct CapsuleMeter: View {
  /// 0…100.
  let value: Double
  var tint: Color = Palette.meterFill
  /// 0…100: where an even pace would put the fill.
  var tick: Double?
  var height: CGFloat = 6
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let fraction = min(1, max(0, value / 100))
    Capsule()
      .fill(Palette.meterTrack)
      .overlay(alignment: .leading) {
        MeterFill(fraction: fraction).fill(tint)
      }
      .overlay(alignment: .leading) {
        if let tick {
          // The full-width frame gives `visualEffect` the bar's width without a layout pass.
          let at = min(1, max(0, tick / 100))
          Capsule()
            .fill(Palette.textPrimary)
            .frame(width: 2, height: height + 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .visualEffect { content, proxy in
              content.offset(x: min(max(proxy.size.width * at - 1, 0), proxy.size.width - 2))
            }
        }
      }
      .frame(height: height)
      .animation(Motion.resolve(Motion.micro, reduceMotion: reduceMotion), value: fraction)
      .accessibilityHidden(true)
  }
}

/// The filled part of a capsule meter, with round ends at any width.
nonisolated struct MeterFill: Shape {
  var fraction: Double

  var animatableData: Double {
    get { fraction }
    set { fraction = newValue }
  }

  func path(in rect: CGRect) -> Path {
    guard fraction > 0 else { return Path() }
    let width = max(rect.height, rect.width * fraction)
    return Capsule().path(in: CGRect(x: rect.minX, y: rect.minY, width: width, height: rect.height))
  }
}

/// RN's header ring: the highest spend across connected accounts; dashed when nothing reports.
struct UsageRing: View {
  let percent: Double?
  var size: CGFloat = 20
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let used = min(100, max(0, percent ?? 0)) / 100
    ZStack {
      Circle()
        .stroke(Palette.textTertiary.opacity(0.35), style: StrokeStyle(lineWidth: 2.5, dash: percent == nil ? [2, 2] : []))
      Circle()
        .trim(from: 0, to: used)
        .stroke((percent ?? 0) >= 90 ? Palette.danger : Palette.textPrimary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .padding(1.25)
    .frame(width: size, height: size)
    .animation(Motion.resolve(Motion.micro, reduceMotion: reduceMotion), value: used)
  }
}

extension ContextWindowSnapshot {
  /// Meter color: neutral, attention at 90%, danger past the window.
  var tint: Color {
    switch level {
    case .normal: Palette.meterFill
    case .high: Palette.attention
    case .over: Palette.danger
    }
  }
}

/// The thread header's context meter: a short capsule and the percent used in mono type.
struct ContextMeter: View {
  let window: ContextWindowSnapshot

  var body: some View {
    HStack(spacing: Spacing.xs) {
      CapsuleMeter(value: Double(window.shownPercent ?? 0), tint: window.tint, height: 4)
        .frame(width: 22)
      Group {
        if let percent = window.shownPercent {
          TechLabel(window.level == .over ? "100%+" : "\(percent)%")
        } else {
          TechLabel(ContextWindow.formatTokens(window.usedTokens))
        }
      }
      .foregroundStyle(window.level == .normal ? Palette.textSecondary : window.tint)
      .contentTransition(.numericText())
      .fixedSize()
    }
    .padding(.horizontal, Spacing.xxs)
  }
}
