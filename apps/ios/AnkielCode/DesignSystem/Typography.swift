import SwiftUI

/// The type scale: system SF on text styles, so every size follows Dynamic Type.
enum Typography {
  static let largeTitle = Font.largeTitle.weight(.semibold)
  static let title = Font.title2.weight(.semibold)
  static let headline = Font.headline
  static let body = Font.body
  static let callout = Font.callout
  static let subheadline = Font.subheadline
  static let footnote = Font.footnote
  static let caption = Font.caption
  static let mono = Font.system(.callout, design: .monospaced)
  static let monoSmall = Font.system(.footnote, design: .monospaced)
}
