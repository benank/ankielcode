/// A forward-compatible optional field: a value that is absent, `null` or unreadable decodes to
/// nil instead of failing the containing row (the server's `ForwardCompatibleOptional`).
@propertyWrapper
public struct Tolerant<Value: Codable & Sendable & Hashable>: Codable, Sendable, Hashable {
  public var wrappedValue: Value?

  public init(wrappedValue: Value?) {
    self.wrappedValue = wrappedValue
  }

  public init(from decoder: any Decoder) throws {
    wrappedValue = try? decoder.singleValueContainer().decode(Value.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    if let wrappedValue { try container.encode(wrappedValue) } else { try container.encodeNil() }
  }
}

extension KeyedDecodingContainer {
  public func decode<Value>(_ type: Tolerant<Value>.Type, forKey key: Key) throws -> Tolerant<Value> {
    ((try? decodeIfPresent(type, forKey: key)) ?? nil) ?? Tolerant(wrappedValue: nil)
  }
}

extension KeyedEncodingContainer {
  public mutating func encode<Value>(_ value: Tolerant<Value>, forKey key: Key) throws {
    if let wrapped = value.wrappedValue { try encode(wrapped, forKey: key) }
  }
}
