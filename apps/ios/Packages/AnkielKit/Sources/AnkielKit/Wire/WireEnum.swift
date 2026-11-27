/// A string enum from the server that may grow new cases. Unknown values decode to `.unknown`
/// instead of failing, and encode back unchanged.
public enum WireEnum<Known: RawRepresentable & Hashable & Sendable>: Hashable, Sendable
where Known.RawValue == String {
  case known(Known)
  case unknown(String)

  public init(rawValue: String) {
    self = Known(rawValue: rawValue).map(Self.known) ?? .unknown(rawValue)
  }

  public init(_ known: Known) { self = .known(known) }

  public var rawValue: String {
    switch self {
    case .known(let known): known.rawValue
    case .unknown(let raw): raw
    }
  }

  public var known: Known? {
    if case .known(let known) = self { known } else { nil }
  }

  public static func == (lhs: Self, rhs: Known) -> Bool { lhs.known == rhs }
  public static func ~= (pattern: Known, value: Self) -> Bool { value.known == pattern }
}

extension WireEnum: Codable {
  public init(from decoder: any Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

extension WireEnum: CustomStringConvertible {
  public var description: String { rawValue }
}

extension Optional {
  /// `row.activityRunStatus == .running` for optional wire enums.
  public static func == <Known>(lhs: Self, rhs: Known) -> Bool where Wrapped == WireEnum<Known> {
    lhs?.known == rhs
  }

  public static func != <Known>(lhs: Self, rhs: Known) -> Bool where Wrapped == WireEnum<Known> {
    lhs?.known != rhs
  }
}
