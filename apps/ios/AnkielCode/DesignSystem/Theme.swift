import AnkielKit
import SwiftUI
import UIKit

/// The color theme for each appearance, like RN's `lightThemeId` / `darkThemeId`: the system
/// light/dark setting (or the theme mode) picks which one shows.
nonisolated struct ThemeSelection: Hashable, Sendable {
  var light: ThemeID = .ankielCode
  var dark: ThemeID = .ankielCode

  static let standard = ThemeSelection()

  init(light: ThemeID = .ankielCode, dark: ThemeID = .ankielCode) {
    self.light = light
    self.dark = dark
  }

  /// From stored ids; unknown or missing ids fall back to the default theme.
  init(lightId: String?, darkId: String?) {
    light = lightId.flatMap(ThemeID.init(rawValue:)) ?? .ankielCode
    dark = darkId.flatMap(ThemeID.init(rawValue:)) ?? .ankielCode
  }

  func colors(dark isDark: Bool) -> ThemeColors {
    (isDark ? dark : light).colors(dark: isDark)
  }
}

/// The theme travels as a trait, set on every window next to the light/dark override
/// (`Appearance.apply`). Dynamic colors read it when they resolve, so a theme change repaints
/// SwiftUI, UIKit and sheets that are already up, with no relaunch and no observation.
nonisolated struct ThemeTrait: UITraitDefinition {
  static let defaultValue = ThemeSelection.standard
  static let affectsColorAppearance = true
  static let identifier = "com.ankiel.code.theme"
  static let name = "Theme"
}

extension UITraitCollection {
  nonisolated var theme: ThemeSelection { self[ThemeTrait.self] }
}

extension UIMutableTraits {
  nonisolated var theme: ThemeSelection {
    get { self[ThemeTrait.self] }
    set { self[ThemeTrait.self] = newValue }
  }
}

extension Color {
  /// A theme role, resolved per appearance and theme when drawn.
  nonisolated init(_ role: KeyPath<ThemeColors, UInt32> & Sendable) {
    self.init(uiColor: UIColor(role))
  }
}

extension UIColor {
  nonisolated convenience init(_ role: KeyPath<ThemeColors, UInt32> & Sendable) {
    self.init { traits in
      UIColor(rgba: traits.theme.colors(dark: traits.userInterfaceStyle == .dark)[keyPath: role])
    }
  }

  nonisolated convenience init(rgba: UInt32) {
    self.init(
      red: CGFloat((rgba >> 24) & 0xFF) / 255,
      green: CGFloat((rgba >> 16) & 0xFF) / 255,
      blue: CGFloat((rgba >> 8) & 0xFF) / 255,
      alpha: CGFloat(rgba & 0xFF) / 255)
  }
}

/// The theme as a SwiftUI environment value, bridged to the trait, for views that hand colors to
/// something that cannot resolve dynamic colors itself (the terminal's config, the widget snapshot).
nonisolated struct ThemeSelectionKey: EnvironmentKey, UITraitBridgedEnvironmentKey {
  static let defaultValue = ThemeSelection.standard

  static func read(from traitCollection: UITraitCollection) -> ThemeSelection { traitCollection.theme }

  static func write(to mutableTraits: inout UIMutableTraits, value: ThemeSelection) {
    mutableTraits.theme = value
  }
}

extension EnvironmentValues {
  var themeSelection: ThemeSelection {
    get { self[ThemeSelectionKey.self] }
    set { self[ThemeSelectionKey.self] = newValue }
  }
}
