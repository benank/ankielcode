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

extension View {
  /// A list's background on the theme instead of the system grouped colors, which no theme reaches.
  /// Rows need `ThemedList` (or `themedRows()` on their sections) for their own background.
  func themedList(_ background: Color = Palette.canvas) -> some View {
    scrollContentBackground(.hidden).background(background)
  }

  /// Grouped rows on the theme's grouped card color (RN's grouped card). Put it on a section or a
  /// group of sections: on a `List` it never reaches the rows. Rows that set their own keep it.
  func themedRows() -> some View {
    listRowBackground(Palette.groupedRow)
  }
}

/// A list on the theme: canvas (or the sheet color in sheets) behind, the grouped card color on
/// every row; plain lists pass the canvas as `rows`.
struct ThemedList<Content: View>: View {
  var background = Palette.canvas
  var rows = Palette.groupedRow
  @ViewBuilder var content: Content

  var body: some View {
    List {
      Group { content }.listRowBackground(rows)
    }
    .themedList(background)
  }
}
