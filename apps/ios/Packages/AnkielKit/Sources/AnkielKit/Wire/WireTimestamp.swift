import Foundation

/// An ISO-8601 UTC timestamp kept as the server's string, so rows round-trip and compare exactly.
public struct WireTimestamp: Hashable, Sendable, Codable, Comparable {
  public let rawValue: String

  public init(rawValue: String) { self.rawValue = rawValue }

  public init(_ date: Date) {
    rawValue = date.formatted(Self.fractional)
  }

  public init(from decoder: any Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var date: Date? {
    (try? Date(rawValue, strategy: Self.fractional)) ?? (try? Date(rawValue, strategy: Self.whole))
  }

  public static func < (lhs: Self, rhs: Self) -> Bool {
    switch (lhs.date, rhs.date) {
    case (let left?, let right?): left < right
    default: lhs.rawValue < rhs.rawValue
    }
  }

  private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  private static let whole = Date.ISO8601FormatStyle()
}
