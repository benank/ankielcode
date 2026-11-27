import Foundation

/// Arbitrary JSON, for defects, opaque fields and payloads the client passes through untouched.
public enum JSONValue: Sendable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public subscript(key: String) -> JSONValue? {
    if case .object(let object) = self { object[key] } else { nil }
  }

  public var stringValue: String? {
    if case .string(let value) = self { value } else { nil }
  }

  public var doubleValue: Double? {
    if case .number(let value) = self { value } else { nil }
  }

  public var intValue: Int? {
    guard case .number(let value) = self, value.rounded() == value, abs(value) < 9e15 else { return nil }
    return Int(value)
  }

  public var boolValue: Bool? {
    if case .bool(let value) = self { value } else { nil }
  }

  public var isNull: Bool { self == .null }

  /// Compact JSON text, for logs and error messages.
  public var compactDescription: String {
    guard let data = try? JSONEncoder.wire.encode(self) else { return "<unencodable>" }
    return String(decoding: data, as: UTF8.self)
  }
}

extension JSONValue: Codable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value):
      if value.rounded() == value, abs(value) < 9e15 {
        try container.encode(Int64(value))
      } else {
        try container.encode(value)
      }
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByNilLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(nilLiteral: ()) { self = .null }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
}

extension JSONEncoder {
  /// Compact output without escaped slashes (URLs read naturally and DPoP `htu` stays literal).
  public static var wire: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
    return encoder
  }
}
