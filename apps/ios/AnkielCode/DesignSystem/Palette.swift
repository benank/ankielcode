import AnkielKit
import SwiftUI
import UIKit

/// Semantic colors. Neutral-first: a cool near-black canvas in dark mode, a cool near-white one in
/// light mode, and color reserved for status (well under a tenth of the screen).
enum Palette {
  // Theme roles (`ThemePalettes.generated.swift`, from RN's theme variables): every screen,
  // sheet and list reads these, so a theme change repaints everything.
  static let canvas = Color(\.canvas)
  /// Sheets and grouped lists' background.
  static let sheet = Color(\.sheet)
  static let surface = Color(\.surface)
  static let surfaceRaised = Color(\.surfaceRaised)
  /// A grouped list's rows (Settings), RN's grouped card.
  static let groupedRow = Color(\.groupedRow)
  static let fill = Color(\.fill)
  static let fillStrong = Color(\.fillStrong)
  static let border = Color(\.border)
  static let separator = Color(\.separator)
  static let sidebar = Color(\.sidebar)

  static let textPrimary = Color(\.textPrimary)
  /// Contrast-corrected to WCAG AA (4.5:1) on the theme's surfaces, like RN.
  static let textSecondary = Color(\.textSecondary)
  /// Still WCAG AA on the theme's surfaces: timestamps, timers and placeholders are read, not decoration.
  static let textTertiary = Color(\.textTertiary)
  static let placeholder = Color(\.placeholder)

  /// The theme's action color: the app tint, switches, prominent buttons (ink in the default theme).
  static let accent = Color(\.accent)
  /// Text and icons on a filled accent control.
  static let onAccent = Color(\.onAccent)
  /// The accent as text on the canvas (contrast-corrected).
  static let accentText = Color(\.accentText)
  static let link = Color(\.link)
  /// The composer's send button.
  static let primaryButton = Color(\.primaryButton)
  static let onPrimaryButton = Color(\.onPrimaryButton)

  /// Status: the tones of `StatusTone`, named for their use.
  static let working = StatusTone.active.color
  static let success = StatusTone.success.color
  static let attention = StatusTone.attention.color
  static let attentionSurface = Color(\.warningSurface)
  static let danger = StatusTone.failed.color
  static let dangerSurface = Color(\.dangerSurface)

  /// Conversation surfaces: the user's bubble, code and table blocks, inline code.
  static let userBubble = Color(\.userBubble)
  static let userBubbleText = Color(\.userBubbleText)
  static let codeBackground = Color(\.codeBackground)
  static let codeHeader = Color(\.fill)
  static let inlineCode = Color(\.fill)
  static let quoteBar = Color(\.quoteBar)

  /// Code tokens: muted, so code reads as text first.
  static let codeKeyword = Color(light: 0xA4327C, dark: 0xE38BC7)
  static let codeString = Color(light: 0x3F7A2A, dark: 0x9BCF7F)
  static let codeComment = Color(light: 0x656A73, dark: 0x878D96)
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

/// The shared status vocabulary (`packages/shared/src/pixelStatus.ts`, RN `STATUS_TONE_VARIABLE`):
/// live work glows the fixed signal cyan, a finished thread the fixed signal green, attention and
/// failure take the theme's warning and error, and plain "done" dots stay muted.
enum StatusTone {
  case active, attention, failed, success, done

  var color: Color {
    switch self {
    case .active: Color(\.signalActive)
    case .attention: Color(\.warning)
    case .failed: Color(\.danger)
    case .success: Color(\.signalSuccess)
    case .done: Color(\.textTertiary)
    }
  }
}
