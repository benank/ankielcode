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
  /// The composer's send button: ink on paper, inverted in dark mode.
  static let primaryButton = Color(light: 0x16171A, dark: 0xF1F2F4)
  static let onPrimaryButton = Color(light: 0xFFFFFF, dark: 0x0B0C0E)
  static let working = Color(light: 0x2F6FEB, dark: 0x5B8DEF)
  static let attention = Color(light: 0xC77700, dark: 0xF0A33A)
  static let success = Color(light: 0x1F8A4C, dark: 0x45C07A)
  static let danger = Color(light: 0xC8302B, dark: 0xF0625C)

  /// Conversation surfaces: the user's bubble, code and table blocks, inline code.
  static let userBubble = Color(light: 0xECEDF1, dark: 0x1F2024)
  static let codeBackground = Color(light: 0xF0F1F4, dark: 0x141518)
  static let codeHeader = Color(light: 0xE7E8EC, dark: 0x1B1C20)
  static let inlineCode = Color(light: 0xE6E7EB, dark: 0x25262B)
  static let quoteBar = Color(light: 0xD3D6DC, dark: 0x3A3C43)

  /// Code tokens: muted, so code reads as text first.
  static let codeKeyword = Color(light: 0xA4327C, dark: 0xE38BC7)
  static let codeString = Color(light: 0x3F7A2A, dark: 0x9BCF7F)
  static let codeComment = Color(light: 0x8A8F98, dark: 0x6E747D)
  static let codeNumber = Color(light: 0x9A5B00, dark: 0xE7B26A)
  static let codeType = Color(light: 0x2C62B8, dark: 0x7FAAF0)
  static let codeProperty = Color(light: 0x6B4FBB, dark: 0xB79CF2)
  static let diffAdded = Color(light: 0x1F7A43, dark: 0x5CCB86)
  static let diffRemoved = Color(light: 0xB3261E, dark: 0xF07B74)

  /// Settings row icon tiles (system-like hues, used only on Settings' root rows).
  static let settingsBlue = Color(light: 0x2F6FEB, dark: 0x3D7BF0)
  static let settingsGreen = Color(light: 0x2E9E5B, dark: 0x34A865)
  static let settingsRed = Color(light: 0xE0443C, dark: 0xE5524A)
  static let settingsGray = Color(light: 0x8A8F98, dark: 0x6E737C)

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
