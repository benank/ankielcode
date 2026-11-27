/// Reassembles `frameParts=1` splits: every part but the last starts with U+001E.
public struct FrameJoiner: Sendable {
  public static let partPrefix: Character = "\u{1E}"
  private var pending = ""

  public init() {}

  /// Returns a complete JSON frame, or nil when the message was a partial frame.
  public mutating func accept(_ message: String) -> String? {
    if message.first == Self.partPrefix {
      pending += message.dropFirst()
      return nil
    }
    guard !pending.isEmpty else { return message }
    defer { pending = "" }
    return pending + message
  }

  public var isPending: Bool { !pending.isEmpty }
}
