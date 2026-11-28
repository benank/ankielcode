import SwiftUI
import UIKit

/// The type scale: Geist and Geist Mono (OFL, bundled in `Fonts/`, registered by `UIAppFonts`),
/// sized like RN's `MOBILE_TYPOGRAPHY` and scaled with Dynamic Type through the text style each
/// size is relative to. Fonts are named by family, so `.weight(_:)` picks the bundled face.
/// Titles are regular weight and tightly tracked: use `.typeStyle(.title)`, which adds tracking.
nonisolated enum Typography {
  static let sansFamily = "Geist"
  static let monoFamily = "Geist Mono"

  static let largeTitle = sans(30, .largeTitle)
  static let title = sans(21, .title2)
  /// Emphasized labels: buttons, card and section titles.
  static let headline = sans(17, .headline).weight(.medium)
  static let body = sans(16, .body)
  static let callout = sans(15, .callout)
  static let subheadline = sans(14, .subheadline)
  static let footnote = sans(13, .footnote)
  static let caption = sans(12, .caption)
  static let caption2 = sans(11, .caption2)

  static let mono = monoFont(14, .callout)
  static let monoSmall = monoFont(12, .footnote)
  static let monoCaption = monoFont(11, .caption)

  static func sans(_ size: CGFloat, _ style: Font.TextStyle) -> Font {
    .custom(sansFamily, size: size, relativeTo: style)
  }

  static func monoFont(_ size: CGFloat, _ style: Font.TextStyle) -> Font {
    .custom(monoFamily, size: size, relativeTo: style)
  }

  /// A code font at a fixed size (the code size preference): it does not follow Dynamic Type.
  static func monoFixed(_ size: CGFloat) -> Font {
    .custom(monoFamily, fixedSize: size)
  }

  // MARK: UIKit

  /// The UIKit counterpart of a scale step, scaled for `traits` (the current Dynamic Type size).
  static func uiFont(
    _ step: UIStep, weight: UIFont.Weight = .regular, mono: Bool = false, traits: UITraitCollection? = nil
  ) -> UIFont {
    let base = uiFont(size: step.size, weight: weight, mono: mono)
    return UIFontMetrics(forTextStyle: step.style).scaledFont(for: base, compatibleWith: traits)
  }

  /// Geist or Geist Mono at a fixed size; falls back to the system font if registration failed.
  static func uiFont(size: CGFloat, weight: UIFont.Weight = .regular, mono: Bool = false) -> UIFont {
    let name = "\(mono ? "GeistMono" : "Geist")-\(faceName(weight))"
    return UIFont(name: name, size: size)
      ?? (mono ? .monospacedSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight))
  }

  private static func faceName(_ weight: UIFont.Weight) -> String {
    switch weight {
    case ..<UIFont.Weight.medium: "Regular"
    case ..<UIFont.Weight.semibold: "Medium"
    case ..<UIFont.Weight.bold: "SemiBold"
    default: "Bold"
    }
  }

  struct UIStep: Sendable {
    let size: CGFloat
    let style: UIFont.TextStyle
    static let body = UIStep(size: 16, style: .body)
    static let subheadline = UIStep(size: 14, style: .subheadline)
    static let footnote = UIStep(size: 13, style: .footnote)
    static let headline = UIStep(size: 17, style: .headline)
    static let title = UIStep(size: 21, style: .title2)
    static let largeTitle = UIStep(size: 30, style: .largeTitle)
    static let monoSmall = UIStep(size: 12, style: .footnote)
  }
}

/// A font with the tracking it is designed with. Tracking is a view modifier in SwiftUI, so the
/// steps that need it (the titles, technical labels) go through `.typeStyle(_:)`.
enum TypeStyle {
  case largeTitle, title, headline, tech, techSmall

  var font: Font {
    switch self {
    case .largeTitle: Typography.largeTitle
    case .title: Typography.title
    case .headline: Typography.headline
    case .tech: Typography.tech
    case .techSmall: Typography.techSmall
    }
  }

  /// In points: about -0.03 em on titles, +0.06 em on mono labels.
  var tracking: CGFloat {
    switch self {
    case .largeTitle: -0.9
    case .title: -0.45
    case .headline: -0.15
    case .tech, .techSmall: 0.6
    }
  }
}

extension View {
  func typeStyle(_ style: TypeStyle) -> some View {
    font(style.font).tracking(style.tracking)
  }

  /// Compact chrome (pills, chips, badges, bar labels) follows Dynamic Type only to just past the
  /// largest standard size, like RN's `CHROME_MAX_FONT_SCALE` (1.4); content scales freely.
  func chromeTextSize() -> some View {
    dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }
}
