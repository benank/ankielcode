import SwiftUI

extension Palette {
  /// A provider's identity color on usage bars (RN `providerColors`); nil for unknown drivers.
  static func provider(_ driver: String) -> Color? {
    switch driver {
    case "claudeAgent": Color(light: 0xD97757, dark: 0xD97757)
    case "codex": Color(light: 0x3C3C43, dark: 0xE6E6E6)
    case "grok": Color(light: 0x52525B, dark: 0xA1A1AA)
    case "cursor": Color(light: 0x8B8B8B, dark: 0x8B8B8B)
    case "opencode": Color(light: 0x5B9BBD, dark: 0x5B9BBD)
    case "antigravity": Color(light: 0x8C7BD1, dark: 0x8C7BD1)
    case "pi": Color(light: 0x4D9F8A, dark: 0x4D9F8A)
    case "muse": Color(light: 0x0866FF, dark: 0x0866FF)
    default: nil
    }
  }

  /// The empty part of a meter.
  static let meterTrack = Color(light: 0xE4E6EA, dark: 0x2C2D33)
  /// A meter's fill when nothing else colors it.
  static let meterFill = Color(light: 0x16171A, dark: 0xF1F2F4)
}

extension Typography {
  /// Technical metadata (token counts, percents, timings): monospaced, uppercase, tracked.
  static let tech = Font.system(.caption, design: .monospaced).weight(.medium)
  static let techSmall = Font.system(.caption2, design: .monospaced).weight(.medium)
}

/// Mono uppercase metadata (`.plans` spectral C): numbers that are data, not prose.
struct TechLabel: View {
  let text: String
  var small = false

  init(_ text: String, small: Bool = false) {
    self.text = text
    self.small = small
  }

  var body: some View {
    Text(text)
      .font(small ? Typography.techSmall : Typography.tech)
      .textCase(.uppercase)
      .tracking(0.6)
      .monospacedDigit()
  }
}
