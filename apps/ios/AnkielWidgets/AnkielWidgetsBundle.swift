import AnkielKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct AnkielWidgetsBundle: WidgetBundle {
  init() { WidgetFont.registerFonts() }

  var body: some Widget {
    SubscriptionUsageWidget()
  }
}

/// Codex and Claude subscription limits from the snapshot the app writes (RN `SubscriptionUsage`).
/// The widget never connects: past a snapshot's expiry it asks to open the app.
struct SubscriptionUsageWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: UsageWidgetStore.widgetKind, intent: SubscriptionUsageIntent.self, provider: UsageTimelineProvider()) { entry in
      SubscriptionUsageEntryView(entry: entry)
    }
    .configurationDisplayName("Subscription usage")
    .description("Subscription quotas from your connected Ankiel Code computers.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular])
  }
}

enum UsagePeriodOption: String, AppEnum {
  case auto, session, weekly

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Limits"
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .auto: "Both", .session: "Session", .weekly: "Weekly",
  ]
}

struct SubscriptionUsageIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Subscription usage"
  static let description = IntentDescription("Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.")

  @Parameter(title: "Codex limits", default: .auto) var codexPeriod: UsagePeriodOption
  @Parameter(title: "Claude limits", default: .auto) var claudePeriod: UsagePeriodOption

  init() {}

  var periods: [String: UsageWidgetLayout.Period] {
    [
      "codex": UsageWidgetLayout.Period(rawValue: codexPeriod.rawValue) ?? .auto,
      "claudeAgent": UsageWidgetLayout.Period(rawValue: claudePeriod.rawValue) ?? .auto,
    ]
  }
}

struct UsageEntry: TimelineEntry {
  var date: Date
  var snapshot: UsageWidgetSnapshot?
  var periods: [String: UsageWidgetLayout.Period] = [:]
}

struct UsageTimelineProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> UsageEntry {
    UsageEntry(date: .now, snapshot: .placeholder(now: .now))
  }

  func snapshot(for configuration: SubscriptionUsageIntent, in context: Context) async -> UsageEntry {
    let snapshot = UsageWidgetStore.shared.read()
    return UsageEntry(
      date: .now, snapshot: context.isPreview && snapshot == nil ? .placeholder(now: .now) : snapshot, periods: configuration.periods)
  }

  /// One entry now, then one at each provider's expiry, so stale data greys out on time.
  func timeline(for configuration: SubscriptionUsageIntent, in context: Context) async -> Timeline<UsageEntry> {
    let now = Date.now
    guard let snapshot = UsageWidgetStore.shared.read() else {
      return Timeline(entries: [UsageEntry(date: now, snapshot: nil)], policy: .never)
    }
    let entries = snapshot.timeline(from: now).map { UsageEntry(date: $0.date, snapshot: snapshot, periods: configuration.periods) }
    return Timeline(entries: entries, policy: .never)
  }
}

struct SubscriptionUsageEntryView: View {
  let entry: UsageEntry
  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var renderingMode
  @Environment(\.isLuminanceReduced) private var luminanceReduced
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let monochrome = renderingMode != .fullColor || luminanceReduced
    // The app theme's colors on the Home Screen in full color; system styles everywhere else.
    let theme = monochrome || family.isAccessory ? nil : WidgetTheme.load()?.colors(colorScheme)
    UsageWidgetView(
      snapshot: entry.snapshot, date: entry.date, family: layoutFamily, periods: entry.periods,
      monochrome: monochrome, theme: theme)
      .containerBackground(for: .widget) {
        if let theme { Color(widgetRGBA: theme.background) } else { Rectangle().fill(.fill.tertiary) }
      }
  }

  private var layoutFamily: UsageWidgetLayout.Family {
    switch family {
    case .systemSmall: .small
    case .systemLarge, .systemExtraLarge: .large
    case .accessoryRectangular: .accessoryRectangular
    case .accessoryCircular: .accessoryCircular
    default: .medium
    }
  }
}

extension WidgetFamily {
  fileprivate var isAccessory: Bool {
    switch self {
    case .accessoryCircular, .accessoryRectangular, .accessoryInline: true
    default: false
    }
  }
}
