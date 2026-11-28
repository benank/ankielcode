import AnkielKit
import SwiftUI
import UIKit

/// The theme preference, applied to every window. Set on the window rather than with
/// `preferredColorScheme`, which does not reach sheets that are already up and does not always
/// return them to the system appearance.
enum Appearance {
  /// Navigation bar titles in Geist (large titles regular and tightly tracked). Set on the
  /// appearance proxy, not a `UINavigationBarAppearance`, so the bars keep their system glass.
  static func configureChrome() {
    let bar = UINavigationBar.appearance()
    bar.titleTextAttributes = [.font: Typography.uiFont(.headline, weight: .semibold)]
    bar.largeTitleTextAttributes = [
      .font: Typography.uiFont(.largeTitle, weight: .medium), .kern: -0.9,
    ]
  }

  static func apply(_ mode: ThemeMode, theme: ThemeSelection) {
    let style: UIUserInterfaceStyle =
      switch mode {
      case .system: .unspecified
      case .light: .light
      case .dark: .dark
      }
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows {
        if window.overrideUserInterfaceStyle != style { window.overrideUserInterfaceStyle = style }
        if window.traitCollection.theme != theme { window.traitOverrides.theme = theme }
        window.tintColor = UIColor(\.accent)
      }
    }
    WidgetTheme(theme).save()
  }
}

#if DEBUG
  extension Appearance {
    /// `ANKIEL_DEBUG_THEME=<id>` sets both themes at launch; `<id>@<seconds>` sets them that long
    /// after launch (live theme switch checks); `<light>/<dark>` sets each.
    static func debugTheme(_ preferences: ClientPreferences) async {
      guard let spec = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_THEME"] else { return }
      let parts = spec.split(separator: "@", maxSplits: 1)
      if parts.count == 2, let delay = Double(parts[1]) { try? await Task.sleep(for: .seconds(delay)) }
      let ids = parts[0].split(separator: "/").map(String.init)
      preferences.values.lightThemeId = ids.first
      preferences.values.darkThemeId = ids.last
    }
  }
#endif

struct AppearanceState: Equatable {
  var mode: ThemeMode
  var theme: ThemeSelection
}

/// How code reads in threads: a fixed size (nil follows Dynamic Type) and wrapping.
struct CodeAppearance: Equatable {
  var fontSize: Double?
  var wraps = false

  var font: Font {
    fontSize.map { Typography.monoFixed($0) } ?? Typography.monoSmall
  }
}

extension EnvironmentValues {
  @Entry var codeAppearance = CodeAppearance()
}

extension WidgetTheme {
  /// The snapshot of a theme the widget draws with.
  init(_ theme: ThemeSelection) {
    func colors(dark: Bool) -> Colors {
      let c = theme.colors(dark: dark)
      return Colors(background: c.canvas, text: c.textPrimary, secondaryText: c.textSecondary, danger: c.danger)
    }
    self.init(light: colors(dark: false), dark: colors(dark: true))
  }
}
