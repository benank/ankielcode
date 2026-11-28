import Foundation
import Testing

@testable import AnkielKit

/// Every generated palette keeps readable text (WCAG AA, 4.5:1) in light and dark. The colors are
/// main's (`themePalettes.ts` through RN's theme variables), so a pair that fails there is listed in
/// `upstream` rather than changed here; a new failure, or a listed one that now passes, fails.
@Suite("Theme contrast")
struct ThemeContrastTests {
  static var text: [(name: String, role: KeyPath<ThemeColors, UInt32>)] {
    [("textPrimary", \.textPrimary), ("textSecondary", \.textSecondary), ("textTertiary", \.textTertiary)]
  }
  static var surfaces: [(name: String, role: KeyPath<ThemeColors, UInt32>)] {
    [("canvas", \.canvas), ("sheet", \.sheet), ("surface", \.surface), ("groupedRow", \.groupedRow)]
  }
  static var pairs: [(name: String, fg: KeyPath<ThemeColors, UInt32>, bg: KeyPath<ThemeColors, UInt32>)] {
    text.flatMap { t in surfaces.map { s in ("\(t.name)/\(s.name)", t.role, s.role) } } + [
      ("onAccent/accent", \.onAccent, \.accent),
      ("accentText/canvas", \.accentText, \.canvas),
      ("onPrimaryButton/primaryButton", \.onPrimaryButton, \.primaryButton),
      ("userBubbleText/userBubble", \.userBubbleText, \.userBubble),
      ("codeText/codeBackground", \.codeText, \.codeBackground),
      ("link/canvas", \.link, \.canvas),
      ("danger/canvas", \.danger, \.canvas),
      ("warning/canvas", \.warning, \.canvas),
    ]
  }

  /// Pairs below 4.5:1 in main's own palettes ("theme-mode pair").
  static let upstream: Set<String> = []

  @Test("body text pairs reach 4.5:1 in every theme and appearance")
  func bodyText() {
    var failures: [String] = []
    for theme in ThemeID.allCases {
      for dark in [false, true] {
        let colors = theme.colors(dark: dark)
        for pair in Self.pairs {
          let ratio = Self.contrast(colors[keyPath: pair.fg], over: colors[keyPath: pair.bg], canvas: colors.canvas)
          if ratio < 4.5 {
            failures.append("\(theme.rawValue)-\(dark ? "dark" : "light") \(pair.name) \(String(format: "%.2f", ratio))")
          }
        }
      }
    }
    let failing = Set(failures.map { $0.split(separator: " ").prefix(2).joined(separator: " ") })
    #expect(failing == Self.upstream, "below AA: \(failures.sorted())")
  }

  /// Contrast of `fg` drawn on `bg`, with translucent colors composited (bg over the canvas first).
  static func contrast(_ fg: UInt32, over bg: UInt32, canvas: UInt32) -> Double {
    let base = composite(bg, over: rgb(canvas))
    let front = composite(fg, over: base)
    let (a, b) = (luminance(front), luminance(base))
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }

  static func rgb(_ rgba: UInt32) -> [Double] {
    [24, 16, 8].map { Double((rgba >> UInt32($0)) & 0xFF) / 255 }
  }

  static func composite(_ rgba: UInt32, over base: [Double]) -> [Double] {
    let alpha = Double(rgba & 0xFF) / 255
    return zip(rgb(rgba), base).map { $0 * alpha + $1 * (1 - alpha) }
  }

  static func luminance(_ c: [Double]) -> Double {
    let linear = c.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }
}
