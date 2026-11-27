import UIKit

/// Imperative haptics for moments that are not tied to a SwiftUI value change. Prefer
/// `.sensoryFeedback` on views when a value change drives the feedback.
enum Haptics {
  static func selection() {
    UISelectionFeedbackGenerator().selectionChanged()
  }

  static func tap(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
    UIImpactFeedbackGenerator(style: style).impactOccurred()
  }

  static func success() {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }

  static func warning() {
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
  }

  static func error() {
    UINotificationFeedbackGenerator().notificationOccurred(.error)
  }
}
