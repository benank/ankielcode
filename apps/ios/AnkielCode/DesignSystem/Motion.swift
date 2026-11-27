import SwiftUI

/// Named one-shot animations. Nothing here repeats; every animation settles and stops.
enum Motion {
  /// 120 ms: press states, toggles.
  static let microFast = Animation.easeOut(duration: 0.12)
  /// 160 ms: small reveals, badges, status dots.
  static let micro = Animation.easeOut(duration: 0.16)
  /// 180 ms: selection and highlight changes.
  static let microSlow = Animation.easeInOut(duration: 0.18)
  /// 280 ms: content swaps and screen-level transitions.
  static let transition = Animation.smooth(duration: 0.28)
  /// 380 ms: larger layout moves.
  static let transitionSlow = Animation.smooth(duration: 0.38)
  /// Springs for things that follow a gesture or land in place.
  static let snappy = Animation.snappy(duration: 0.3, extraBounce: 0)
  static let gentle = Animation.spring(duration: 0.4, bounce: 0.12)
  static let lively = Animation.spring(duration: 0.35, bounce: 0.25)

  /// Under Reduce Motion, movement becomes a short cross-fade.
  static let reduced = Animation.linear(duration: 0.12)

  static func resolve(_ animation: Animation, reduceMotion: Bool) -> Animation {
    reduceMotion ? reduced : animation
  }
}

extension View {
  /// `.animation(_:value:)` that collapses to a cross-fade under Reduce Motion.
  func motion(_ animation: Animation, value: some Equatable) -> some View {
    modifier(MotionModifier(animation: animation, value: value))
  }
}

private struct MotionModifier<Value: Equatable>: ViewModifier {
  let animation: Animation
  let value: Value
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content.animation(Motion.resolve(animation, reduceMotion: reduceMotion), value: value)
  }
}

extension View {
  /// `.transition(_:)` that becomes a cross-fade under Reduce Motion.
  func motionTransition(_ transition: AnyTransition) -> some View {
    modifier(MotionTransitionModifier(transition: transition))
  }
}

private struct MotionTransitionModifier: ViewModifier {
  let transition: AnyTransition
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content.transition(reduceMotion ? .opacity : transition)
  }
}

/// `withAnimation` that honors Reduce Motion (pass the environment value from the view).
func withMotion<Result>(
  _ animation: Animation, reduceMotion: Bool, _ body: () throws -> Result
) rethrows -> Result {
  try withAnimation(Motion.resolve(animation, reduceMotion: reduceMotion), body)
}
