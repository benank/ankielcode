import SwiftUI
import UIKit

/// The terminal's colors, as Ghostty config lines. The 16 ANSI colors are RN's Pierre palette;
/// background, text and cursor follow the app's canvas, text and working tokens.
struct TerminalPalette: Equatable {
  var dark: Bool

  var background: UInt32 { dark ? 0x0B0C0E : 0xFCFCFD }
  var foreground: UInt32 { dark ? 0xD9DBE0 : 0x2A2C31 }
  var cursor: UInt32 { dark ? 0x5B8DEF : 0x2F6FEB }
  var selection: UInt32 { dark ? 0x26324A : 0xD6E2FA }
  var ansi: [UInt32] {
    dark
      ? [0x141415, 0xFF2E3F, 0x0DBE4E, 0xFFCA00, 0x009FFF, 0xC635E4, 0x08C0EF, 0xC6C6C8,
         0x5E626B, 0xFF5C6A, 0x3DD677, 0xFFD84D, 0x4DBBFF, 0xD86AEE, 0x4FD3F4, 0xF1F2F4]
      : [0x1F1F21, 0xE0202F, 0x0A9A3F, 0xB38A00, 0x007FD1, 0xA92BC4, 0x0798BE, 0x8E8E95,
         0x5E626B, 0xFF2E3F, 0x0DBE4E, 0xCC9F00, 0x009FFF, 0xC635E4, 0x08C0EF, 0x6C6C71]
  }

  var backgroundColor: UIColor { UIColor(rgb: background) }
  var foregroundColor: Color { Color(uiColor: UIColor(rgb: foreground)) }

  /// The Ghostty config for this palette, the font size and the cursor blink.
  func ghosttyConfig(fontSize: Double, blink: Bool) -> String {
    var lines = [
      "background = \(hex(background))",
      "foreground = \(hex(foreground))",
      "cursor-color = \(hex(cursor))",
      "cursor-text = \(hex(background))",
      "selection-background = \(hex(selection))",
      "cursor-style-blink = \(blink)",
      "font-size = \(String(format: "%g", fontSize))",
    ]
    for (index, color) in ansi.enumerated() { lines.append("palette = \(index)=\(hex(color))") }
    return lines.joined(separator: "\n") + "\n"
  }

  private func hex(_ value: UInt32) -> String { String(format: "#%06x", value) }
}
