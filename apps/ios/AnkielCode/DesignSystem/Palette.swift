import SwiftUI
import UIKit

/// Semantic colors. Neutral-first: a cool near-black canvas in dark mode, a cool near-white one in
/// light mode, and color reserved for status (well under a tenth of the screen).
enum Palette {
  static let canvas = Color(light: 0xF6F7F9, dark: 0x0B0C0E)
  static let surface = Color(light: 0xFFFFFF, dark: 0x141518)
  static let surfaceRaised = Color(light: 0xFFFFFF, dark: 0x1C1D21)
  static let fill = Color(light: 0xEDEEF1, dark: 0x232429)
  static let separator = Color(light: 0xE1E3E8, dark: 0x2A2B31)

  static let textPrimary = Color(light: 0x16171A, dark: 0xF1F2F4)
  static let textSecondary = Color(light: 0x5E626B, dark: 0xA3A7AF)
  static let textTertiary = Color(light: 0x8E929B, dark: 0x6E727A)

  static let accent = Color.accentColor
  /// Text and icons on a filled accent control (`.glassProminent`): the accent is near-black in
  /// light mode and near-white in dark mode.
  static let onAccent = Color(light: 0xFFFFFF, dark: 0x0B0C0E)
  static let working = Color(light: 0x2F6FEB, dark: 0x5B8DEF)
  static let attention = Color(light: 0xC77700, dark: 0xF0A33A)
  static let success = Color(light: 0x1F8A4C, dark: 0x45C07A)
  static let danger = Color(light: 0xC8302B, dark: 0xF0625C)

  /// The app icon's tile and glyph (fixed in both appearances, like the icon).
  static let brandTile = Color(light: 0x161615, dark: 0x1E1E1C)
  static let brandGlyph = Color(light: 0xF2F2EE, dark: 0xF2F2EE)
  /// A soft light behind the brand mark on the welcome screen.
  static let welcomeGlow = Color(light: 0xFFFFFF, dark: 0x23252B)
}

extension Color {
  /// A color that resolves per appearance, from `0xRRGGBB` literals. Nonisolated: SwiftUI
  /// resolves dynamic colors off the main thread (async list rendering).
  nonisolated init(light: UInt32, dark: UInt32) {
    self.init(
      uiColor: UIColor { traits in
        UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
      })
  }
}

extension UIColor {
  nonisolated convenience init(rgb: UInt32) {
    self.init(
      red: CGFloat((rgb >> 16) & 0xFF) / 255,
      green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255,
      alpha: 1)
  }
}
