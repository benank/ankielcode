import Foundation

/// When a streaming reply ticks (RN `threadStreamHaptics.ts`): a new stream always ticks; growth
/// of the same stream ticks at most once per throttle window, so a fast stream reads as texture
/// rather than a buzz.
public enum StreamHaptics {
  public struct Mark: Sendable, Hashable {
    public var id: String
    public var length: Int

    public init(id: String, length: Int) {
      self.id = id
      self.length = length
    }
  }

  public static let throttle: TimeInterval = 0.32

  /// The newest assistant reply still streaming, if any.
  public static func mark(_ timeline: ThreadTimeline) -> Mark? {
    for row in timeline.rows.reversed() {
      if case .assistant(let reply) = row.content {
        return reply.streaming ? Mark(id: reply.messageId, length: reply.text.count) : nil
      }
    }
    return nil
  }

  public static func shouldTick(previous: Mark?, latest: Mark?, lastTick: Date, now: Date) -> Bool {
    guard let latest else { return false }
    if previous?.id != latest.id { return true }
    guard let previous, latest.length > previous.length else { return false }
    return now.timeIntervalSince(lastTick) >= throttle
  }
}
