import Foundation

/// Everything that can stop a connect or a pairing, in terms a UI can explain.
public enum ConnectionError: Error, Sendable, Hashable {
  case pairingInput(PairingInputError)
  case unreachable(String)
  case environmentMismatch(expected: String, found: String)
  case incompatibleProtocol(serverVersion: Int)
  /// The credential was refused after one renewal: pair again.
  case credentialRejected
  case socketRefused(status: Int)
  case socket(String)
  case rpc(RpcError)
  case configStreamEnded
}

/// Pairs with an environment and opens authenticated RPC sockets to it.
public struct EnvironmentConnector: Sendable {
  public let http: EnvironmentHTTPClient
  public let store: any CredentialStore
  public let client: ClientIdentity
  public var rpcOptions: RpcClient.Options

  public init(
    store: any CredentialStore, client: ClientIdentity, http: EnvironmentHTTPClient = EnvironmentHTTPClient(),
    rpcOptions: RpcClient.Options = RpcClient.Options()
  ) {
    self.store = store
    self.client = client
    self.http = http
    self.rpcOptions = rpcOptions
  }

  // MARK: Pairing

  /// Reads the descriptor (before spending the one-time code), exchanges the code, and saves the
  /// credential. DPoP when the server can renew tokens; bearer otherwise.
  public func pair(_ target: PairingTarget, expectedEnvironmentId: String? = nil) async throws(ConnectionError)
    -> (SavedEnvironment, AccessCredential)
  {
    let descriptor = try await verifiedDescriptor(target.endpoint, environmentId: expectedEnvironmentId)
    let key = descriptor.capability("accessTokenRenewal") ? try dpopKey() : nil
    let result: AccessTokenResult
    do {
      result = try await http.exchangePairingCode(target.credential, at: target.endpoint, key: key, client: client)
    } catch let error as EnvironmentHTTPError where error.isAuthInvalid {
      throw .credentialRejected
    } catch {
      throw .unreachable(Self.describe(error))
    }
    let credential = AccessCredential(result)
    let environment = SavedEnvironment(
      environmentId: descriptor.environmentId,
      label: result.environmentLabel ?? descriptor.label,
      endpoint: target.endpoint,
      serverVersion: descriptor.serverVersion)
    try save(credential, for: environment.environmentId)
    return (environment, credential)
  }

  // MARK: Connecting

  /// Verifies the endpoint, renews the token if due, mints a ticket, opens the socket and waits
  /// for the first server config snapshot (the readiness signal).
  public func connect(_ environment: SavedEnvironment) async throws(ConnectionError) -> EnvironmentSession {
    guard var credential = try loadCredential(environment.environmentId) else { throw .credentialRejected }
    let endpoint = environment.endpoint
    _ = try await verifiedDescriptor(endpoint, environmentId: environment.environmentId)
    let key: DPoPKey? = if case .dpop = credential { try dpopKey() } else { nil }

    if credential.needsRenewal(), let key {
      credential = try await renew(credential, environment: environment, key: key)
    }

    let ticket: WebSocketTicket
    do {
      ticket = try await http.webSocketTicket(at: endpoint, credential: credential, key: key)
    } catch let error as EnvironmentHTTPError where error.isAuthInvalid {
      // A clock jump or a restored server: renew once and retry.
      guard let key, case .dpop = credential else { throw .credentialRejected }
      credential = try await renew(credential, environment: environment, key: key)
      do {
        ticket = try await http.webSocketTicket(at: endpoint, credential: credential, key: key)
      } catch {
        throw (error as? EnvironmentHTTPError)?.isAuthInvalid == true ? .credentialRejected : .unreachable(Self.describe(error))
      }
    } catch {
      throw .unreachable(Self.describe(error))
    }

    let url: URL
    do {
      url = try socketURL(endpoint: endpoint, ticket: ticket.ticket, key: key)
    } catch {
      throw .socket(Self.describe(error))
    }
    let transport: WebSocketTransport
    do {
      transport = try await WebSocketTransport.connect(to: url)
    } catch WebSocketOpenError.httpStatus(let status) {
      throw status == 401 ? .credentialRejected : .socketRefused(status: status)
    } catch {
      throw .socket(Self.describe(error))
    }

    let rpc = RpcClient(transport: transport, options: rpcOptions)
    await rpc.start()
    do {
      let events = try await rpc.stream(
        ServerConfigSubscription.rpcTag, payload: ServerConfigSubscription(), of: ServerConfigEvent.self)
      let feed = ServerConfigFeed(events.makeAsyncIterator())
      guard case .snapshot(let config)? = try await feed.next() else {
        await rpc.close()
        throw ConnectionError.configStreamEnded
      }
      guard config.environment.environmentId == environment.environmentId else {
        await rpc.close()
        throw ConnectionError.environmentMismatch(
          expected: environment.environmentId, found: config.environment.environmentId)
      }
      return EnvironmentSession(environment: environment, rpc: rpc, initialConfig: config, configFeed: feed)
    } catch let error as ConnectionError {
      throw error
    } catch let error as RpcError {
      await rpc.close()
      throw .rpc(error)
    } catch {
      await rpc.close()
      throw .socket(Self.describe(error))
    }
  }

  /// `{wsBase}/ws?wsTicket=…&dpop=…&orchestrationProtocol=2&…`. The DPoP proof signs `GET` of the
  /// socket URL in `http(s)` form without query, with `ath` over the ticket.
  public func socketURL(endpoint: EnvironmentEndpoint, ticket: String, key: DPoPKey?) throws -> URL {
    let base = endpoint.socketURL()
    var items = [URLQueryItem(name: "wsTicket", value: ticket)]
    if let key {
      items.append(URLQueryItem(name: "dpop", value: try key.proof(method: "GET", url: base, accessToken: ticket)))
    }
    items += [
      URLQueryItem(name: "clientSurface", value: "mobile"),
      URLQueryItem(name: "clientAppVersion", value: client.appVersion),
      URLQueryItem(name: "clientDeviceType", value: client.deviceType.rawValue),
      URLQueryItem(name: "clientOs", value: client.os),
    ]
    if let major = client.osMajorVersion { items.append(URLQueryItem(name: "clientOsMajorVersion", value: major)) }
    if let model = client.deviceModel { items.append(URLQueryItem(name: "clientDeviceModel", value: model)) }
    items += [
      URLQueryItem(name: "connectionMethod", value: "direct"),
      URLQueryItem(name: "orchestrationProtocol", value: "2"),
      URLQueryItem(name: "clientCapabilities", value: "settingsSecretReferences"),
      URLQueryItem(name: "frameParts", value: "1"),
    ]
    var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    // Tickets and proofs are base64url with dots; escape anything else strictly.
    components.percentEncodedQuery = items.map {
      "\(FormEncoding.escape($0.name))=\(FormEncoding.escape($0.value ?? ""))"
    }.joined(separator: "&")
    guard let url = components.url else { throw ConnectionError.socket("Invalid socket URL.") }
    return url
  }

  /// Renews a DPoP token and saves the result. Rejection means the session is gone.
  public func renew(
    _ credential: AccessCredential, environment: SavedEnvironment, key: DPoPKey
  ) async throws(ConnectionError) -> AccessCredential {
    do {
      let result = try await http.renew(credential.token, at: environment.endpoint, key: key)
      let renewed = AccessCredential(result)
      try save(renewed, for: environment.environmentId)
      return renewed
    } catch let error as EnvironmentHTTPError where error.isAuthInvalid {
      throw .credentialRejected
    } catch let error as ConnectionError {
      throw error
    } catch {
      throw .unreachable(Self.describe(error))
    }
  }

  // MARK: Storage

  public func loadCredential(_ environmentId: String) throws(ConnectionError) -> AccessCredential? {
    do {
      return try store.value(AccessCredential.self, for: CredentialKeys.credential(environmentId))
    } catch {
      throw .unreachable("Could not read the saved credential: \(error)")
    }
  }

  public func forget(_ environmentId: String) {
    try? store.remove(CredentialKeys.credential(environmentId))
  }

  private func save(_ credential: AccessCredential, for environmentId: String) throws(ConnectionError) {
    do {
      try store.set(credential, for: CredentialKeys.credential(environmentId))
    } catch {
      throw .unreachable("Could not save the credential: \(error)")
    }
  }

  private func dpopKey() throws(ConnectionError) -> DPoPKey {
    do { return try store.dpopKey() } catch { throw .unreachable("Could not load the DPoP key: \(error)") }
  }

  private func verifiedDescriptor(
    _ endpoint: EnvironmentEndpoint, environmentId: String?
  ) async throws(ConnectionError) -> EnvironmentDescriptor {
    do {
      return try await http.verifiedDescriptor(at: endpoint, environmentId: environmentId)
    } catch EnvironmentHTTPError.environmentMismatch(let expected, let found) {
      throw .environmentMismatch(expected: expected, found: found)
    } catch EnvironmentHTTPError.incompatibleProtocol(let version) {
      throw .incompatibleProtocol(serverVersion: version)
    } catch {
      throw .unreachable(Self.describe(error))
    }
  }

  static func describe(_ error: any Error) -> String {
    switch error {
    case EnvironmentHTTPError.status(let status, let body):
      "HTTP \(status)\(body.map { " \($0.compactDescription)" } ?? "")"
    case EnvironmentHTTPError.transport(let message), EnvironmentHTTPError.decoding(let message):
      message
    default:
      String(describing: error)
    }
  }
}

/// An open, authenticated socket after session start.
public struct EnvironmentSession: Sendable {
  public let environment: SavedEnvironment
  public let rpc: RpcClient
  public let initialConfig: ServerConfig
  /// The rest of the config stream (the first snapshot was consumed). It ending means the session
  /// closed.
  let configFeed: ServerConfigFeed

  /// The next server config event; nil or a throw means the session ended.
  public func nextConfigEvent() async throws -> ServerConfigEvent? {
    try await configFeed.next()
  }

  /// Opens `orchestration.subscribeShell` with the flags this server supports.
  public func subscribeShell(_ subscription: ShellSubscription? = nil) async throws
    -> RpcStream<ShellStreamItem>
  {
    try await rpc.stream(
      ShellSubscription.rpcTag, payload: subscription ?? initialConfig.shellSubscription,
      of: ShellStreamItem.self)
  }

  public func probe() async throws -> JSONValue {
    try await rpc.call("server.probe", as: JSONValue.self)
  }

  public func close() async {
    await rpc.close()
  }
}

/// Owns the config stream's iterator, which must outlive `connect` (releasing it interrupts the
/// stream, and the server treats the session's first stream ending as the session closing).
actor ServerConfigFeed {
  private var iterator: RpcStream<ServerConfigEvent>.Iterator

  init(_ iterator: sending RpcStream<ServerConfigEvent>.Iterator) {
    self.iterator = iterator
  }

  func next() async throws -> ServerConfigEvent? {
    // Copies share the stream's storage and stop token, so this reads the same stream.
    var cursor = iterator
    return try await cursor.next()
  }
}
