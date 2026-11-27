/// Where the thread feed holds its place. The feed re-applies it after every layout pass, so
/// anything that changes heights or insets (streaming text, rows opening, the keyboard, the
/// composer growing, rotation, Dynamic Type) keeps the same content in view.
///
/// Rules:
/// 1. Only the reader moves the anchor: a drag or fling (`scrolled`), the scroll-to-latest button
///    or a send (`jumpToEnd`), or opening/closing a row (`toggled`). Layout never does.
/// 2. At (or within `threshold` of) the end the feed follows the end; anywhere else it holds the
///    row at the top of the screen at the same distance from the visible top.
/// 3. Opening or closing a row holds that row where it was tapped, even at the end.
/// 4. New content while not following raises the new-content dot; reaching the end clears it.
public struct FeedScroll: Equatable, Sendable {
  public enum Anchor: Equatable, Sendable {
    case end
    /// A row's top edge, `offset` points below the visible top.
    case row(String, offset: Double)
  }

  /// How close to the end still counts as at the end.
  public static let threshold: Double = 56

  public private(set) var anchor: Anchor
  public private(set) var unseen = false

  public var following: Bool { anchor == .end }

  public init(_ anchor: Anchor = .end) {
    self.anchor = anchor
  }

  /// The reader moved the feed. `top` is the first row on screen and its offset below the visible top.
  public mutating func scrolled(distanceToEnd: Double, top: (id: String, offset: Double)?) {
    if distanceToEnd <= Self.threshold {
      jumpToEnd()
    } else if let top {
      anchor = .row(top.id, offset: top.offset)
    }
  }

  /// The thread changed (a new or longer row from the server).
  public mutating func contentChanged() {
    if !following { unseen = true }
  }

  /// The reader sent a message or tapped scroll to latest.
  public mutating func jumpToEnd() {
    anchor = .end
    unseen = false
  }

  /// The reader opened or closed `row`, whose top sits `offset` below the visible top.
  public mutating func toggled(_ row: String, offset: Double) {
    anchor = .row(row, offset: offset)
  }

  /// A layout pass applied the anchor and ended `distanceToEnd` from the end. A held row that the
  /// end clamped (a row closed near the end, or a short thread) means the reader is at the end.
  public mutating func settled(distanceToEnd: Double) {
    if !following, distanceToEnd <= 0.5 { jumpToEnd() }
  }

  /// The scroll offset that keeps the anchor, clamped to `range` (the scroll view's offsets);
  /// nil keeps the current offset (the held row is gone, e.g. folded away).
  /// - Parameters:
  ///   - rowTop: A row's top edge in content coordinates, nil when it is not in the feed.
  ///   - insetTop: How far the visible top sits below the scroll offset (the bars' inset).
  public func target(rowTop: (String) -> Double?, insetTop: Double, range: ClosedRange<Double>) -> Double? {
    switch anchor {
    case .end:
      range.upperBound
    case .row(let id, let offset):
      rowTop(id).map { min(max($0 - offset - insetTop, range.lowerBound), range.upperBound) }
    }
  }
}
