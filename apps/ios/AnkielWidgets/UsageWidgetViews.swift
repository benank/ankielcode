import AnkielKit
import SwiftUI
import WidgetKit

/// The subscription usage widget's views. Compiled into the widget and the app (debug previews),
/// so they take the family and rendering mode as values instead of reading the environment.
/// Copy comes from the app's String Catalog, so the widget speaks the app's language.
struct UsageWidgetView: View {
  let snapshot: UsageWidgetSnapshot?
  let date: Date
  let family: UsageWidgetLayout.Family
  var periods: [String: UsageWidgetLayout.Period] = [:]
  /// Not full color: accented (tinted Home Screen), vibrant (Lock Screen) or clear glass.
  var monochrome = false

  var body: some View {
    let shown = snapshot?.shown(at: date)
    let columns = shown.map { UsageWidgetLayout.columns($0, family: family, periods: periods) } ?? []
    Group {
      switch family {
      case .accessoryCircular: circular(columns)
      case .accessoryRectangular: rectangular(columns)
      default: system(columns, checkedAt: shown?.checkedAt, connected: snapshot != nil)
      }
    }
    .widgetURL(UsageWidgetStore.deepLink)
  }

  // MARK: Home Screen

  private func system(_ columns: [UsageWidgetLayout.Column], checkedAt: Date?, connected: Bool) -> some View {
    VStack(alignment: .leading, spacing: family == .small ? 6 : 8) {
      if columns.isEmpty {
        Text(connected ? WidgetCopy.noLimits : WidgetCopy.openApp)
          .font(.caption)
          .foregroundStyle(.secondary)
      } else if family == .small {
        VStack(alignment: .leading, spacing: 8) { ForEach(columns) { column($0) } }
      } else {
        HStack(alignment: .top, spacing: 16) { ForEach(columns) { column($0) } }
      }
      Spacer(minLength: 0)
      Text(checkedAt.map { WidgetCopy.asOf($0) } ?? WidgetCopy.tapToConnect)
        .font(.system(.caption2, design: .monospaced))
        .textCase(.uppercase)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func column(_ column: UsageWidgetLayout.Column) -> some View {
    VStack(alignment: .leading, spacing: family == .small ? 2 : 4) {
      Text(column.provider.name)
        .font(family == .small ? .caption.weight(.bold) : .headline)
        .lineLimit(1)
        .widgetAccentable()
      if column.windows.isEmpty || family != .small {
        Text(WidgetCopy.detail(column.detail))
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      ForEach(column.windows) { window in
        windowRow(window, provider: column.provider)
      }
      if family == .large, column.hiddenCount > 0 {
        Text(WidgetCopy.more(column.hiddenCount))
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func windowRow(_ window: UsageWidgetSnapshot.Window, provider: UsageWidgetSnapshot.Provider) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 4) {
        Text(window.label)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Spacer(minLength: 2)
        Text(WidgetCopy.percentLeft(window.remaining))
          .font(.system(.caption2, design: .monospaced).weight(.semibold))
          .foregroundStyle(window.remaining <= 10 && !monochrome ? Color.red : Color.primary)
          .lineLimit(1)
          .layoutPriority(1)
      }
      bar(window.remaining, driver: provider.driver)
      if family != .small, let reset = WidgetCopy.reset(window) {
        Text(reset)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(WidgetCopy.accessibility(provider: provider.name, window: window))
  }

  private func bar(_ remaining: Int, driver: String) -> some View {
    WidgetBar(remaining: remaining, tint: monochrome ? Color.primary : remaining <= 10 ? Color.red : WidgetCopy.tint(driver))
  }

  // MARK: Lock Screen

  private func rectangular(_ columns: [UsageWidgetLayout.Column]) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(columns.prefix(2)) { column in
        HStack(spacing: 4) {
          Text(column.tightest.map { "\(column.provider.name) · \($0.label)" } ?? column.provider.name)
            .lineLimit(1)
          Spacer(minLength: 2)
          Text(column.tightest.map { WidgetCopy.percentLeft($0.remaining) } ?? WidgetCopy.openAppShort)
            .lineLimit(1)
            .layoutPriority(1)
        }
        .font(.caption.weight(.semibold))
        if let tightest = column.tightest {
          WidgetBar(remaining: tightest.remaining, tint: .primary)
        }
      }
      if columns.isEmpty { Text(WidgetCopy.openApp).font(.caption) }
    }
  }

  /// The tightest window across providers as a ring.
  private func circular(_ columns: [UsageWidgetLayout.Column]) -> some View {
    let tightest = columns.compactMap { column in column.tightest.map { (column.provider, $0) } }.min { $0.1.remaining < $1.1.remaining }
    return Gauge(value: Double(tightest?.1.remaining ?? 0), in: 0...100) {
      Text(verbatim: tightest.map { String($0.0.name.prefix(1)) } ?? "–")
    } currentValueLabel: {
      Text(verbatim: tightest.map { "\($0.1.remaining)" } ?? "–")
        .font(.system(.body, design: .monospaced).weight(.semibold))
    }
    .gaugeStyle(.accessoryCircularCapacity)
    .widgetAccentable()
    .accessibilityLabel(tightest.map { WidgetCopy.accessibility(provider: $0.0.name, window: $0.1) } ?? WidgetCopy.openApp)
  }
}

/// A thin capsule bar of the share left, drawn (a linear `Gauge` is too heavy at this size).
struct WidgetBar: View {
  let remaining: Int
  let tint: Color

  var body: some View {
    Capsule()
      .fill(Color.primary.opacity(0.12))
      .overlay(alignment: .leading) {
        WidgetBarFill(fraction: Double(min(100, max(0, remaining))) / 100).fill(tint).widgetAccentable()
      }
      .frame(height: 4)
  }
}

nonisolated struct WidgetBarFill: Shape {
  var fraction: Double

  func path(in rect: CGRect) -> Path {
    guard fraction > 0 else { return Path() }
    return Capsule().path(in: CGRect(x: rect.minX, y: rect.minY, width: max(rect.height, rect.width * fraction), height: rect.height))
  }
}

/// The widget's copy, read from the containing app's catalog (an extension's own bundle has none).
enum WidgetCopy {
  static let bundle: Bundle = {
    let main = Bundle.main
    guard main.bundleURL.pathExtension == "appex" else { return main }
    return Bundle(url: main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()) ?? main
  }()

  static var noLimits: String { String(localized: "No subscription limits available.", bundle: bundle) }
  static var openApp: String { String(localized: "Open Ankiel Code to see usage", bundle: bundle) }
  static var openAppShort: String { String(localized: "Open the app", bundle: bundle) }
  static var tapToConnect: String { String(localized: "Tap to connect in Ankiel Code", bundle: bundle) }

  static func asOf(_ date: Date) -> String {
    let time = date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    return String(localized: "As of \(time)", bundle: bundle)
  }

  static func percentLeft(_ remaining: Int) -> String { String(localized: "\(remaining)% left", bundle: bundle) }

  static func more(_ count: Int) -> String { String(localized: "\(count) more in Ankiel Code", bundle: bundle) }

  static func detail(_ detail: UsageWidgetLayout.Detail) -> String {
    switch detail {
    case .noSessionLimit: String(localized: "No session limit reported", bundle: bundle)
    case .noWeeklyLimit: String(localized: "No weekly limit reported", bundle: bundle)
    case .provider(.noLimits): String(localized: "No limits available", bundle: bundle)
    case .provider(.refresh): String(localized: "Open Ankiel Code to refresh", bundle: bundle)
    case .provider(.subscriptionRemaining): String(localized: "Subscription remaining", bundle: bundle)
    case .provider(.pooled(let accounts)): String(localized: "\(accounts) accounts · pooled", bundle: bundle)
    }
  }

  static func reset(_ window: UsageWidgetSnapshot.Window) -> String? {
    guard let at = window.resetAt else { return String(localized: "Reset time unavailable", bundle: bundle) }
    // RN `clockLabel`: the time today, the weekday and time this week, else the date.
    let time =
      Calendar.current.isDateInToday(at)
      ? at.formatted(.dateTime.hour().minute())
      : at.timeIntervalSinceNow < 6 * 86_400 ? at.formatted(.dateTime.weekday(.abbreviated).hour().minute()) : at.formatted(.dateTime.month(.abbreviated).day())
    return window.resetUpcoming
      ? String(localized: "Resets \(time)", bundle: bundle) : String(localized: "Reset \(time)", bundle: bundle)
  }

  static func accessibility(provider: String, window: UsageWidgetSnapshot.Window) -> String {
    String(localized: "\(provider), \(window.label), \(window.remaining) percent remaining", bundle: bundle)
  }

  /// RN's widget tints: Claude's orange, Codex's gray.
  static func tint(_ driver: String) -> Color {
    driver == "claudeAgent" ? Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255) : Color(white: 0.56)
  }
}
