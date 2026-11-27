import AnkielKit
import SwiftUI
import UIKit

/// The theme preference, applied to every window. Set on the window rather than with
/// `preferredColorScheme`, which does not reach sheets that are already up and does not always
/// return them to the system appearance.
enum Appearance {
  static func apply(_ mode: ThemeMode) {
    let style: UIUserInterfaceStyle =
      switch mode {
      case .system: .unspecified
      case .light: .light
      case .dark: .dark
      }
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows where window.overrideUserInterfaceStyle != style {
        window.overrideUserInterfaceStyle = style
      }
    }
  }
}

/// How code reads in threads: a fixed size (nil follows Dynamic Type) and wrapping.
struct CodeAppearance: Equatable {
  var fontSize: Double?
  var wraps = false

  var font: Font {
    fontSize.map { Font.system(size: $0, design: .monospaced) } ?? Typography.monoSmall
  }
}

extension EnvironmentValues {
  @Entry var codeAppearance = CodeAppearance()
}
