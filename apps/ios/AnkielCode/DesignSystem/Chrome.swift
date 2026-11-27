import SwiftUI

/// Liquid Glass is for chrome (bars, floating controls, the composer), never for content.
extension View {
  /// A floating control on glass.
  func chromeGlass(in shape: some Shape = .capsule, interactive: Bool = false) -> some View {
    glassEffect(.regular.interactive(interactive), in: shape)
  }
}

/// A small floating capsule for transient status (connecting, offline).
struct StatusPill: View {
  let text: LocalizedStringKey
  var systemImage: String?
  var tint: Color = Palette.textSecondary

  var body: some View {
    Label {
      Text(text)
    } icon: {
      if let systemImage { Image(systemName: systemImage).foregroundStyle(tint) }
    }
    .font(Typography.footnote.weight(.medium))
    .foregroundStyle(Palette.textPrimary)
    .padding(.horizontal, Spacing.md)
    .padding(.vertical, Spacing.sm)
    .chromeGlass()
  }
}

/// The canvas behind every screen.
struct CanvasBackground: View {
  var body: some View {
    Palette.canvas.ignoresSafeArea()
  }
}
