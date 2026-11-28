import CoreText
import SwiftUI
import UIKit
import WidgetKit

/// The widget's type: the app's Geist and Geist Mono. Compiled into the app too, where `UIAppFonts`
/// registered them; the extension registers the containing app's copies once (`registerFonts`).
enum WidgetFont {
  static func sans(_ size: CGFloat, _ style: Font.TextStyle) -> Font {
    .custom("Geist", size: size, relativeTo: style)
  }

  static func mono(_ size: CGFloat, _ style: Font.TextStyle) -> Font {
    .custom("Geist Mono", size: size, relativeTo: style)
  }

  private static let files = [
    "Geist_400Regular", "Geist_500Medium", "Geist_600SemiBold", "Geist_700Bold",
    "GeistMono_400Regular", "GeistMono_500Medium", "GeistMono_600SemiBold", "GeistMono_700Bold",
  ]

  /// Registers the fonts for this process from the containing app's bundle (extension only).
  static func registerFonts() {
    let urls = files.compactMap { WidgetCopy.bundle.url(forResource: $0, withExtension: "ttf") }
    CTFontManagerRegisterFontURLs(urls as CFArray, .process, false, nil)
  }
}

/// The colors of the app's current theme, for the widget's full-color rendering. The app writes
/// them to the App Group when the theme changes; tinted and clear widgets keep system styles.
struct WidgetTheme: Codable, Equatable {
  struct Colors: Codable, Equatable {
    var background: UInt32
    var text: UInt32
    var secondaryText: UInt32
    var danger: UInt32
  }

  var light: Colors
  var dark: Colors

  static let key = "widget-theme.v1"
  private static var defaults: UserDefaults? { UserDefaults(suiteName: "group.com.ankiel.code.native") }

  static func load() -> WidgetTheme? {
    defaults?.data(forKey: key).flatMap { try? JSONDecoder().decode(WidgetTheme.self, from: $0) }
  }

  /// Saves the snapshot and reloads the widget when it changed.
  func save() {
    guard Self.load() != self, let data = try? JSONEncoder().encode(self) else { return }
    Self.defaults?.set(data, forKey: Self.key)
    WidgetCenter.shared.reloadAllTimelines()
  }

  func colors(_ scheme: ColorScheme) -> Colors { scheme == .dark ? dark : light }
}

extension Color {
  init(widgetRGBA rgba: UInt32) {
    self.init(
      .sRGB, red: Double((rgba >> 24) & 0xFF) / 255, green: Double((rgba >> 16) & 0xFF) / 255,
      blue: Double((rgba >> 8) & 0xFF) / 255, opacity: Double(rgba & 0xFF) / 255)
  }
}
