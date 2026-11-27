import SwiftUI

/// The open "A" from the app icon (`AppIcon.icon/Assets/text.svg`, a 128-point canvas).
nonisolated struct BrandGlyph: Shape {
  func path(in rect: CGRect) -> Path {
    let scale = min(rect.width, rect.height) / 128
    let origin = CGPoint(x: rect.midX - 64 * scale, y: rect.midY - 64 * scale)
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * scale, y: origin.y + y * scale) }
    var path = Path()
    path.move(to: p(60.16, 34))
    path.addLine(to: p(67.84, 34))
    path.addLine(to: p(68.93, 36.65))
    path.addLine(to: p(45.36, 94))
    path.addLine(to: p(35.5, 94))
    path.closeSubpath()
    path.move(to: p(60.16, 34))
    path.addLine(to: p(67.84, 34))
    path.addLine(to: p(92.5, 94))
    path.addLine(to: p(82.64, 94))
    path.addLine(to: p(59.07, 36.65))
    path.closeSubpath()
    return path
  }
}

/// The app icon as a view: the glyph on the icon's near-black tile.
struct BrandMark: View {
  var size: CGFloat = 88

  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
      .fill(Palette.brandTile)
      .overlay {
        BrandGlyph()
          .fill(Palette.brandGlyph)
          .padding(size * 0.02)
      }
      .overlay {
        RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
          .strokeBorder(.white.opacity(0.08), lineWidth: 0.5)
      }
      .frame(width: size, height: size)
      .shadow(color: .black.opacity(0.18), radius: size * 0.16, y: size * 0.08)
      .accessibilityHidden(true)
  }
}

#Preview {
  BrandMark()
    .padding()
}
