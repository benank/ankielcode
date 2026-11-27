/// `Schema.Number` on the wire: a JSON number, or `"Infinity"`, `"-Infinity"`, `"NaN"`.
public struct WireNumber: Hashable, Sendable, Codable {
  public var value: Double

  public init(_ value: Double) { self.value = value }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let number = try? container.decode(Double.self) {
      value = number
      return
    }
    switch try container.decode(String.self) {
    case "Infinity": value = .infinity
    case "-Infinity": value = -.infinity
    case "NaN": value = .nan
    case let other:
      guard let parsed = Double(other) else {
        throw DecodingError.dataCorruptedError(
          in: container, debugDescription: "Not a number: \(other)")
      }
      value = parsed
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    if value.isNaN {
      try container.encode("NaN")
    } else if value.isInfinite {
      try container.encode(value > 0 ? "Infinity" : "-Infinity")
    } else {
      try container.encode(value)
    }
  }
}
