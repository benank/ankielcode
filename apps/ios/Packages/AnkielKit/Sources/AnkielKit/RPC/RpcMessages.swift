import Foundation

/// Client → server Effect RPC frames.
enum ClientFrame {
  static func request(id: Int, tag: String, payload: some Encodable) throws -> String {
    try encode(RequestFrame(id: id, tag: tag, payload: payload))
  }

  static func ack(_ id: Int) -> String { #"{"_tag":"Ack","requestId":\#(id)}"# }
  static func interrupt(_ id: Int) -> String { #"{"_tag":"Interrupt","requestId":\#(id)}"# }
  static let ping = #"{"_tag":"Ping"}"#

  private struct RequestFrame<Payload: Encodable>: Encodable {
    let id: Int
    let tag: String
    let payload: Payload

    enum CodingKeys: String, CodingKey { case _tag, id, tag, payload, headers }

    func encode(to encoder: any Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode("Request", forKey: ._tag)
      try container.encode(id, forKey: .id)
      try container.encode(tag, forKey: .tag)
      try container.encode(payload, forKey: .payload)
      try container.encode([[String]](), forKey: .headers)
    }
  }

  private static func encode(_ value: some Encodable) throws -> String {
    String(decoding: try JSONEncoder.wire.encode(value), as: UTF8.self)
  }
}

/// The routing header of a server frame; bodies are decoded once the request's type is known.
struct ServerFrameHeader: Decodable {
  let tag: String
  let requestId: Int?

  enum CodingKeys: String, CodingKey {
    case tag = "_tag"
    case requestId
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    tag = try container.decode(String.self, forKey: .tag)
    // The server echoes the id's JSON type; accept a string form of our number too.
    if let number = try? container.decodeIfPresent(Int.self, forKey: .requestId) {
      requestId = number
    } else if let text = try? container.decodeIfPresent(String.self, forKey: .requestId) {
      requestId = Int(text)
    } else {
      requestId = nil
    }
  }
}

struct ChunkFrame<Item: Decodable>: Decodable {
  let values: [Item]
}

struct DefectFrame: Decodable {
  let defect: JSONValue?
}

struct ExitFrame<Value: Decodable>: Decodable {
  let exit: RpcExit<Value>
}

/// `ExitEncoded`: `{"_tag":"Success","value":…}` or `{"_tag":"Failure","cause":[…]}`.
enum RpcExit<Value: Decodable>: Decodable {
  case success(Value?)
  case failure([RpcCauseReason])

  enum CodingKeys: String, CodingKey {
    case tag = "_tag"
    case value, cause
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .tag) {
    case "Success":
      self = .success(try container.decodeIfPresent(Value.self, forKey: .value))
    default:
      let cause = (try? container.decodeIfPresent([RpcCauseReason].self, forKey: .cause)) ?? nil
      self = .failure(cause ?? [])
    }
  }
}

/// One reason in an Effect `Cause`.
public enum RpcCauseReason: Sendable, Hashable, Decodable {
  /// A typed failure; `error._tag` names the error class.
  case fail(JSONValue)
  /// A server defect (including a payload that failed the server's schema decode).
  case die(JSONValue)
  case interrupt
  case unknown(JSONValue)

  public init(from decoder: any Decoder) throws {
    let value = try JSONValue(from: decoder)
    switch value["_tag"]?.stringValue {
    case "Fail": self = .fail(value["error"] ?? .null)
    case "Die": self = .die(value["defect"] ?? .null)
    case "Interrupt": self = .interrupt
    default: self = .unknown(value)
    }
  }
}
