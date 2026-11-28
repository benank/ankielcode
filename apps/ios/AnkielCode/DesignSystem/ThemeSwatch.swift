import AnkielKit
import SwiftUI

/// A theme's preview orb (RN `PreviewOrb`, `THEME_PREVIEW_RENDER_SPECS`): the theme's base with
/// its accent and message-action colors glowing from opposite corners. Drawn in fixed colors, so
/// it shows the theme it names whatever the app's current theme is.
struct ThemeSwatch: View {
  let theme: ThemeID
  let dark: Bool
  var size: CGFloat = 56

  var body: some View {
    let colors = theme.colors(dark: dark)
    let spec = dark ? Spec.dark : Spec.light
    let accent = Color(uiColor: UIColor(rgba: colors.previewAccent))
    let action = Color(uiColor: UIColor(rgba: colors.previewAction))
    Circle()
      .fill(Color(uiColor: UIColor(rgba: colors.previewBase)))
      .overlay {
        Circle().fill(
          RadialGradient(
            stops: [
              .init(color: action.opacity(0.45), location: 0),
              .init(color: action.opacity(0), location: 0.55),
            ],
            center: spec.action, startRadius: 0, endRadius: radius(spec.action)))
      }
      .overlay {
        Circle().fill(
          RadialGradient(
            stops: [
              .init(color: accent, location: 0),
              .init(color: accent.opacity(spec.accentMiddle), location: 0.28),
              .init(color: accent.opacity(0), location: 0.58),
            ],
            center: spec.accent, startRadius: 0, endRadius: radius(spec.accent)))
      }
      .overlay { Circle().strokeBorder(dark ? Color.white.opacity(0.14) : Color.black.opacity(0.1)) }
      .frame(width: size, height: size)
  }

  /// The gradient reaches the farthest corner, like RN's `objectBoundingBox` radius.
  private func radius(_ center: UnitPoint) -> CGFloat {
    hypot(max(center.x, 1 - center.x), max(center.y, 1 - center.y)) * size
  }

  private struct Spec {
    let accent: UnitPoint
    let action: UnitPoint
    let accentMiddle: Double
    static let light = Spec(accent: UnitPoint(x: 0.72, y: 0.22), action: UnitPoint(x: 0.18, y: 0.82), accentMiddle: 0.72)
    static let dark = Spec(accent: UnitPoint(x: 0.28, y: 0.78), action: UnitPoint(x: 0.82, y: 0.18), accentMiddle: 0.62)
  }
}
