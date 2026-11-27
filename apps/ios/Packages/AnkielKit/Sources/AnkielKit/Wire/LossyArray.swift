/// An array that skips elements it cannot decode instead of failing the whole document, like the
/// server's `ForwardCompatibleArray`. `droppedCount` says how many were skipped.
public struct LossyArray<Element: Decodable & Sendable>: Decodable, Sendable {
  public var elements: [Element]
  public var droppedCount: Int
  public var firstDropReason: String?

  public init(_ elements: [Element]) {
    self.elements = elements
    droppedCount = 0
  }

  public init(from decoder: any Decoder) throws {
    var container = try decoder.unkeyedContainer()
    var elements: [Element] = []
    elements.reserveCapacity(container.count ?? 0)
    var dropped = 0
    var reason: String?
    while !container.isAtEnd {
      do {
        elements.append(try container.decode(Element.self))
      } catch {
        _ = try? container.decode(JSONValue.self)
        dropped += 1
        if reason == nil { reason = describeDecodingError(error) }
      }
    }
    self.elements = elements
    droppedCount = dropped
    firstDropReason = reason
  }

}

/// A short, path-qualified message for a decoding failure.
public func describeDecodingError(_ error: any Error) -> String {
  func path(_ context: DecodingError.Context) -> String {
    context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined()
  }
  switch error as? DecodingError {
  case .typeMismatch(let type, let context):
    return "type mismatch (\(type)) at \(path(context)): \(context.debugDescription)"
  case .valueNotFound(let type, let context):
    return "missing value (\(type)) at \(path(context))"
  case .keyNotFound(let key, let context):
    return "missing key \(key.stringValue) at \(path(context))"
  case .dataCorrupted(let context):
    return "corrupted at \(path(context)): \(context.debugDescription)"
  default:
    return String(describing: error)
  }
}
