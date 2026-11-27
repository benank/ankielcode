import Foundation

/// A failed environment HTTP request. `body` is the server's tagged JSON error when it sent one
/// (`{"_tag":"EnvironmentAuthInvalidError","reason":"invalid_credential",…}`).
public enum EnvironmentHTTPError: Error, Sendable, Hashable {
  case status(Int, body: JSONValue?)
  case transport(String)
  case decoding(String)
  case environmentMismatch(expected: String, found: String)
  case incompatibleProtocol(serverVersion: Int)

  /// A rejected credential: renew once, then pair again.
  public var isAuthInvalid: Bool {
    if case .status(401, _) = self { true } else { false }
  }

  public var errorTag: String? {
    if case .status(_, let body) = self { body?["_tag"]?.stringValue } else { nil }
  }
}

/// The unauthenticated and authenticated HTTP calls a client needs before and around the socket.
public struct EnvironmentHTTPClient: Sendable {
  public let session: URLSession

  public init(session: URLSession = EnvironmentHTTPClient.makeSession()) {
    self.session = session
  }

  public static func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
  }

  // MARK: Descriptor

  /// Reads who answers at `endpoint`. 3 s for a local address, 10 s otherwise.
  public func descriptor(at endpoint: EnvironmentEndpoint) async throws -> EnvironmentDescriptor {
    var request = URLRequest(url: endpoint.httpURL("/.well-known/ankiel/environment"))
    request.timeoutInterval = endpoint.isLocalNetwork ? 3 : 10
    return try await send(request, as: EnvironmentDescriptor.self)
  }

  /// The descriptor, checked to be `environmentId` speaking protocol 2, before any credential goes out.
  public func verifiedDescriptor(
    at endpoint: EnvironmentEndpoint, environmentId: String?
  ) async throws -> EnvironmentDescriptor {
    let descriptor = try await descriptor(at: endpoint)
    if let environmentId, descriptor.environmentId != environmentId {
      throw EnvironmentHTTPError.environmentMismatch(expected: environmentId, found: descriptor.environmentId)
    }
    guard descriptor.protocolVersion == EnvironmentDescriptor.supportedProtocolVersion else {
      throw EnvironmentHTTPError.incompatibleProtocol(serverVersion: descriptor.protocolVersion)
    }
    return descriptor
  }

  // MARK: Tokens

  /// Spends a one-time pairing code. With a key, the session is DPoP-bound and renewable.
  public func exchangePairingCode(
    _ code: String, at endpoint: EnvironmentEndpoint, key: DPoPKey?, client: ClientIdentity
  ) async throws -> AccessTokenResult {
    try await tokenExchange(
      at: endpoint, key: key,
      fields: [
        ("subject_token", code),
        ("subject_token_type", "urn:ankiel:params:oauth:token-type:environment-bootstrap"),
        ("client_label", client.label),
        ("client_device_type", client.deviceType.exchangeValue),
        ("client_os", client.os),
      ])
  }

  /// Renews a DPoP token in place (same session id, so open sockets stay up).
  public func renew(
    _ accessToken: String, at endpoint: EnvironmentEndpoint, key: DPoPKey
  ) async throws -> AccessTokenResult {
    try await tokenExchange(
      at: endpoint, key: key,
      fields: [
        ("subject_token", accessToken),
        ("subject_token_type", "urn:ietf:params:oauth:token-type:access_token"),
      ])
  }

  private func tokenExchange(
    at endpoint: EnvironmentEndpoint, key: DPoPKey?, fields: [(String, String)]
  ) async throws -> AccessTokenResult {
    let url = endpoint.httpURL("/oauth/token")
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    if let key {
      request.setValue(try key.proof(method: "POST", url: url), forHTTPHeaderField: "DPoP")
    }
    let body: [(String, String)] =
      [("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange")] + fields
      + [("requested_token_type", "urn:ietf:params:oauth:token-type:access_token")]
    request.httpBody = Data(FormEncoding.encode(body.filter { !$0.1.isEmpty }).utf8)
    request.timeoutInterval = 15
    return try await send(request, as: AccessTokenResult.self)
  }

  // MARK: Authorized requests

  /// Adds `Authorization` (and a fresh `DPoP` proof for this exact method and URL).
  public func authorize(
    _ request: inout URLRequest, credential: AccessCredential, key: DPoPKey?
  ) throws {
    switch credential {
    case .bearer(let token):
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    case .dpop(let accessToken, _):
      guard let key, let url = request.url else { throw EnvironmentHTTPError.transport("Missing DPoP key.") }
      request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue(
        try key.proof(method: request.httpMethod ?? "GET", url: url, accessToken: accessToken),
        forHTTPHeaderField: "DPoP")
    }
    if request.url?.path().contains("/api/orchestration/") == true {
      request.setValue("2", forHTTPHeaderField: "x-ankiel-orchestration-protocol")
    }
  }

  /// Sends an authorized request and decodes its JSON response.
  public func authorizedSend<Response: Decodable>(
    _ request: URLRequest, credential: AccessCredential, key: DPoPKey?, as type: Response.Type
  ) async throws -> Response {
    var request = request
    try authorize(&request, credential: credential, key: key)
    return try await send(request, as: type)
  }

  /// Mints a 5-minute RPC socket ticket. Falls back to the unbound legacy route on 404.
  public func webSocketTicket(
    at endpoint: EnvironmentEndpoint, credential: AccessCredential, key: DPoPKey?
  ) async throws -> WebSocketTicket {
    func mint(_ path: String) async throws -> WebSocketTicket {
      var request = URLRequest(url: endpoint.httpURL(path))
      request.httpMethod = "POST"
      request.timeoutInterval = 15
      return try await authorizedSend(request, credential: credential, key: key, as: WebSocketTicket.self)
    }
    do {
      return try await mint("/api/auth/websocket-ticket/rpc")
    } catch EnvironmentHTTPError.status(404, _) {
      return try await mint("/api/auth/websocket-ticket")
    }
  }

  // MARK: Plumbing

  public func send<Response: Decodable>(_ request: URLRequest, as _: Response.Type) async throws -> Response {
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw EnvironmentHTTPError.transport(error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw EnvironmentHTTPError.status(status, body: try? JSONDecoder().decode(JSONValue.self, from: data))
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw EnvironmentHTTPError.decoding(describeDecodingError(error))
    }
  }
}
