#if DEBUG
  import AnkielKit
  import SwiftUI

  /// `ANKIEL_DEBUG_USAGE_OPEN=widgets`: the widget's own views at Home and Lock Screen sizes, in
  /// full color and monochrome, fresh, stale and before any snapshot. The real widget renders the
  /// same `UsageWidgetView`.
  struct UsageWidgetGallery: View {
    let sources: [LimitSource]
    var stale = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.themeSelection) private var themeSelection

    var body: some View {
      let snapshot = UsageWidgetSnapshot.build(sources)
      let date = stale ? Date.now.addingTimeInterval(3600) : Date.now
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            // `ANKIEL_DEBUG_WIDGET_PAGE=2` puts the Lock Screen and large tiles on screen first.
            if UsageDebug.environment["ANKIEL_DEBUG_WIDGET_PAGE"] != "2" {
              tile(snapshot, date, .small, CGSize(width: 170, height: 170))
              tile(snapshot, date, .medium, CGSize(width: 364, height: 170))
              tile(snapshot, date, .medium, CGSize(width: 364, height: 170), monochrome: true)
              tile(nil, date, .medium, CGSize(width: 364, height: 170))
            }
            HStack(spacing: 16) {
              tile(snapshot, date, .accessoryRectangular, CGSize(width: 172, height: 76), monochrome: true)
              tile(snapshot, date, .accessoryCircular, CGSize(width: 76, height: 76), monochrome: true)
            }
            tile(snapshot, date, .large, CGSize(width: 364, height: 382))
          }
          .padding()
        }
        .background(Palette.canvas)
        .navigationTitle(Text(verbatim: "Widget"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Done", systemImage: "xmark") { dismiss() } }
      }
    }

    private func tile(
      _ snapshot: UsageWidgetSnapshot?, _ date: Date, _ family: UsageWidgetLayout.Family, _ size: CGSize, monochrome: Bool = false
    ) -> some View {
      let accessory = family == .accessoryRectangular || family == .accessoryCircular
      let theme = monochrome || accessory ? nil : WidgetTheme(themeSelection).colors(colorScheme)
      return UsageWidgetView(snapshot: snapshot, date: date, family: family, monochrome: monochrome, theme: theme)
        .padding(accessory ? 6 : 16)
        .frame(width: size.width, height: size.height)
        .background(
          monochrome ? AnyShapeStyle(Color.gray.opacity(accessory ? 0.35 : 0.5)) : AnyShapeStyle(theme.map { Color(widgetRGBA: $0.background) } ?? Palette.surfaceRaised),
          in: .rect(cornerRadius: accessory ? (family == .accessoryCircular ? 38 : 12) : 22))
        .foregroundStyle(monochrome ? Color.white : Palette.textPrimary)
        .environment(\.colorScheme, monochrome ? .dark : colorScheme)
        .accessibilityIdentifier("widget.\(family)")
    }
  }
#endif
