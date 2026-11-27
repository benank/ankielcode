/// Why an RPC call or stream did not succeed.
public enum RpcError: Error, Sendable, Hashable {
  /// The handler failed with a typed error (`error._tag` names it, e.g.
  /// `EnvironmentAuthorizationError`).
  case failed(RpcFailure)
  /// The server hit a defect for this request, such as a payload its schema rejected.
  case defect(JSONValue)
  /// The server interrupted the call (for a stream: resubscribe).
  case interrupted
  /// A top-level `Defect` frame, which fails every open request on the socket.
  case protocolDefect(JSONValue)
  /// The socket closed or went silent; reconnect.
  case connectionClosed(String)
  /// A frame for this request did not decode.
  case decoding(String)
}

/// A typed `Fail` from an exit, kept as JSON so callers decode only the errors they handle.
public struct RpcFailure: Sendable, Hashable, CustomStringConvertible {
  public let error: JSONValue

  public init(error: JSONValue) { self.error = error }

  public var tag: String? { error["_tag"]?.stringValue }
  public var message: String? { error["message"]?.stringValue }

  public var description: String {
    [tag, message].compactMap(\.self).joined(separator: ": ")
  }
}

extension RpcError {
  init(cause: [RpcCauseReason]) {
    for reason in cause {
      if case .fail(let error) = reason {
        self = .failed(RpcFailure(error: error))
        return
      }
    }
    for reason in cause {
      if case .die(let defect) = reason {
        self = .defect(defect)
        return
      }
    }
    if cause.contains(.interrupt) {
      self = .interrupted
    } else {
      self = .defect(cause.first.map { reason in
        if case .unknown(let value) = reason { value } else { .null }
      } ?? .null)
    }
  }
}
