import CoreGraphics

/// Spacing on a 4-point grid.
enum Spacing {
  static let xxs: CGFloat = 2
  static let xs: CGFloat = 4
  static let sm: CGFloat = 8
  static let md: CGFloat = 12
  static let lg: CGFloat = 16
  static let xl: CGFloat = 24
  static let xxl: CGFloat = 32
  static let xxxl: CGFloat = 48
}

/// Corner radii; used with `.rect(cornerRadius:style: .continuous)`.
enum Radius {
  static let small: CGFloat = 8
  static let medium: CGFloat = 12
  static let large: CGFloat = 20
  static let field: CGFloat = 14
  /// The composer's glass card.
  static let composer: CGFloat = 24
  /// Floating sheet-like cards (pending requests, the scanner frame).
  static let sheet: CGFloat = 28
}

/// Widths for wide panes (iPad).
enum Layout {
  /// The conversation's column: a comfortable line length for body text, centered in wide panes.
  /// The feed, the request dock and the composer share it so their edges line up.
  static let readingWidth: CGFloat = 720
}
