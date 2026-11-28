import Foundation

/// Everything that can stop a connect or a pairing, in terms a UI can explain.
public enum ConnectionError: Error, Sendable, Hashable {
  case pairingInput(PairingInputError)
  case unreachable(String)
  case environmentMismatch(expected: String, found: String)
  case incompatibleProtocol(serverVersion: Int)
  /// The credential (or a pairing code) was refused after one renewal: pair again.
  case credentialRejected
  /// The server refused a DPoP proof's `iat`: the device clock is off by more than 5 minutes.
  case clockSkew
  case socketRefused(status: Int)
  case socket(String)
  case rpc(RpcError)
  case configStreamEnded
  case timedOut
}

/// Pairs with an environment and opens authenticated RPC sockets to it.
public struct EnvironmentConnector: Sendable {
  public let http: EnvironmentHTTPClient
  public let store: any CredentialStore
  public let client: ClientIdentity
  public var rpcOptions: RpcClient.Options
  /// Where new pairings get a hardware key (tests inject fakes).
  public var enclave: any EnclaveKeys = SystemEnclaveKeys()
  /// Wraps each opened socket (the probe counts raw frames through it); nil in the app.
  public var transportTap: (@Sendable (any RpcTransport) -> any RpcTransport)?

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

  /// Step one of pairing: who answers at the target, checked before the one-time code is spent.
  public func describe(
    _ target: PairingTarget, expectedEnvironmentId: String? = nil
  ) async throws(ConnectionError) -> EnvironmentDescriptor {
    try await verifiedDescriptor(target.endpoint, environmentId: expectedEnvironmentId)
  }

  /// Whether an address answers as this environment (its public descriptor); nothing secret is sent.
  public func checkRoute(_ endpoint: EnvironmentEndpoint, environmentId: String) async throws(ConnectionError) -> EnvironmentDescriptor {
    try await verifiedDescriptor(endpoint, environmentId: environmentId)
  }

  /// Step two: spends the code and saves the credential. DPoP when the server can renew tokens,
  /// bearer otherwise. A refused code (expired or already used) is `credentialRejected`.
  public func exchange(
    _ target: PairingTarget, descriptor: EnvironmentDescriptor
  ) async throws(ConnectionError) -> SavedEnvironment {
    let key = descriptor.capability("accessTokenRenewal") ? try pairingKey() : nil
    let result: AccessTokenResult
    do {
      result = try await http.exchangePairingCode(target.credential, at: target.endpoint, key: key, client: client)
    } catch let error as EnvironmentHTTPError {
      throw Self.mapHTTP(error)
    } catch {
      throw .unreachable(Self.describe(error))
    }
    let environment = SavedEnvironment(
      environmentId: descriptor.environmentId,
      label: result.environmentLabel ?? descriptor.label,
      endpoint: target.endpoint,
      serverVersion: descriptor.serverVersion)
    let credential = AccessCredential(result)
    try save(credential, for: environment.environmentId)
    do {
      try store.bind(environment.environmentId, to: credential.isDPoP ? key : nil)
    } catch {
      throw .unreachable("Could not save the credential: \(error)")
    }
    return environment
  }

  /// Both pairing steps.
  public func pair(_ target: PairingTarget, expectedEnvironmentId: String? = nil) async throws(ConnectionError)
    -> SavedEnvironment
  {
    let descriptor = try await describe(target, expectedEnvironmentId: expectedEnvironmentId)
    return try await exchange(target, descriptor: descriptor)
  }

  // MARK: Connecting

  /// One connect through one route: verifies the endpoint answers as `environmentId` before any
  /// credential goes out, renews the token if due, mints a ticket, opens the socket and waits for
  /// the first server config snapshot (the readiness signal). A 401 at the ticket or at the
  /// upgrade renews once and retries before the credential counts as rejected.
  public func connect(
    environmentId: String, endpoint: EnvironmentEndpoint, vault: CredentialVault
  ) async throws(ConnectionError) -> EnvironmentSession {
    _ = try await verifiedDescriptor(endpoint, environmentId: environmentId)
    var credential = try await vault.current(at: endpoint)
    let key: DPoPKey? = if case .dpop = credential { try dpopKey(for: environmentId) } else { nil }

    var renewed = false
    while true {
      do {
        return try await open(environmentId: environmentId, endpoint: endpoint, credential: credential, key: key)
      } catch .credentialRejected where !renewed && key != nil {
        // A clock jump or a restored server: renew once and retry.
        renewed = true
        credential = try await vault.renew(at: endpoint, replacing: credential.token)
      }
    }
  }

  /// Phase-2 entry point kept for the probe CLI: one saved environment, its paired route.
  public func connect(_ environment: SavedEnvironment) async throws(ConnectionError) -> EnvironmentSession {
    try await connect(
      environmentId: environment.environmentId, endpoint: environment.endpoint,
      vault: CredentialVault(environmentId: environment.environmentId, connector: self))
  }

  private func open(
    environmentId: String, endpoint: EnvironmentEndpoint, credential: AccessCredential, key: DPoPKey?
  ) async throws(ConnectionError) -> EnvironmentSession {
    let ticket: WebSocketTicket
    do {
      ticket = try await http.webSocketTicket(at: endpoint, credential: credential, key: key)
    } catch let error as EnvironmentHTTPError {
      throw Self.mapHTTP(error)
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
    } catch WebSocketOpenError.timedOut {
      throw .timedOut
    } catch {
      throw .socket(Self.describe(error))
    }

    let rpc = RpcClient(transport: transportTap?(transport) ?? transport, options: rpcOptions)
    await rpc.start()
    do {
      let events = try await rpc.stream(
        ServerConfigSubscription.rpcTag, payload: ServerConfigSubscription.app, of: ServerConfigEvent.self)
      let feed = ServerConfigFeed(events.makeAsyncIterator())
      guard case .snapshot(let config)? = try await feed.next() else {
        await rpc.close()
        throw ConnectionError.configStreamEnded
      }
      guard config.environment.environmentId == environmentId else {
        await rpc.close()
        throw ConnectionError.environmentMismatch(expected: environmentId, found: config.environment.environmentId)
      }
      return EnvironmentSession(
        environmentId: environmentId, endpoint: endpoint, rpc: rpc, initialConfig: config, configFeed: feed)
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
    _ credential: AccessCredential, environmentId: String, endpoint: EnvironmentEndpoint
  ) async throws(ConnectionError) -> AccessCredential {
    let key = try dpopKey(for: environmentId)
    do {
      let result = try await http.renew(credential.token, at: endpoint, key: key)
      let renewed = AccessCredential(result)
      try save(renewed, for: environmentId)
      return renewed
    } catch let error as EnvironmentHTTPError {
      throw Self.mapHTTP(error)
    } catch let error as ConnectionError {
      throw error
    } catch {
      throw .unreachable(Self.describe(error))
    }
  }

  // MARK: Shell over HTTP

  /// `GET /api/orchestration/shell` with the subscription's omission flags (§5.5).
  public func shellSnapshot(
    _ subscription: ShellSubscription, endpoint: EnvironmentEndpoint, vault: CredentialVault
  ) async throws(ConnectionError) -> ShellHTTPSnapshot {
    var components = URLComponents(
      url: endpoint.httpURL("/api/orchestration/shell"), resolvingAgainstBaseURL: false)!
    var items: [URLQueryItem] = []
    if subscription.omitIdleSubagents == true { items.append(URLQueryItem(name: "omitIdleSubagents", value: "1")) }
    if subscription.omitOlderSettled == true { items.append(URLQueryItem(name: "omitOlderSettled", value: "1")) }
    components.queryItems = items.isEmpty ? nil : items
    var request = URLRequest(url: components.url!)
    request.timeoutInterval = 20
    var credential = try await vault.current(at: endpoint)
    var renewed = false
    while true {
      do {
        let key: DPoPKey? = if case .dpop = credential { try dpopKey(for: vault.environmentId) } else { nil }
        return try await http.authorizedSend(request, credential: credential, key: key, as: ShellHTTPSnapshot.self)
      } catch let error as EnvironmentHTTPError {
        let mapped = Self.mapHTTP(error)
        guard mapped == .credentialRejected, !renewed else { throw mapped }
        renewed = true
        credential = try await vault.renew(at: endpoint, replacing: credential.token)
      } catch let error as ConnectionError {
        throw error
      } catch {
        throw .unreachable(Self.describe(error))
      }
    }
  }

  /// An authorized JSON `POST` (DPoP proof for this method and URL), renewing once on a
  /// rejected credential like `shellSnapshot`. A refusal with a tagged JSON body (the server's
  /// typed errors) throws `RpcError.failed`, as the same error over RPC would.
  public func postJSON<Response: Decodable>(
    _ path: String, body: some Encodable, endpoint: EnvironmentEndpoint, vault: CredentialVault, as type: Response.Type,
    timeout: TimeInterval = 60
  ) async throws -> Response {
    var request = URLRequest(url: endpoint.httpURL(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    request.timeoutInterval = timeout
    return try await sendJSON(request, endpoint: endpoint, vault: vault, as: type)
  }

  /// An authorized JSON `GET`, with `postJSON`'s renewal and error mapping.
  public func getJSON<Response: Decodable>(
    _ path: String, endpoint: EnvironmentEndpoint, vault: CredentialVault, as type: Response.Type, timeout: TimeInterval = 20
  ) async throws -> Response {
    var request = URLRequest(url: endpoint.httpURL(path))
    request.timeoutInterval = timeout
    return try await sendJSON(request, endpoint: endpoint, vault: vault, as: type)
  }

  private func sendJSON<Response: Decodable>(
    _ request: URLRequest, endpoint: EnvironmentEndpoint, vault: CredentialVault, as type: Response.Type
  ) async throws -> Response {
    var credential = try await vault.current(at: endpoint)
    var renewed = false
    while true {
      do {
        let key: DPoPKey? = if case .dpop = credential { try dpopKey(for: vault.environmentId) } else { nil }
        return try await http.authorizedSend(request, credential: credential, key: key, as: type)
      } catch let error as EnvironmentHTTPError {
        if case .status(let status, let body?) = error, status != 401, body["_tag"]?.stringValue != nil {
          throw RpcError.failed(RpcFailure(error: body))
        }
        let mapped = Self.mapHTTP(error)
        guard mapped == .credentialRejected, !renewed else { throw mapped }
        renewed = true
        credential = try await vault.renew(at: endpoint, replacing: credential.token)
      }
    }
  }

  // MARK: Session state

  /// `GET /api/auth/session` with this device's credential.
  public func sessionState(
    endpoint: EnvironmentEndpoint, vault: CredentialVault
  ) async throws(ConnectionError) -> AuthSessionState {
    var request = URLRequest(url: endpoint.httpURL("/api/auth/session"))
    request.timeoutInterval = 15
    let credential = try await vault.current(at: endpoint)
    do {
      let key: DPoPKey? = if case .dpop = credential { try dpopKey(for: vault.environmentId) } else { nil }
      return try await http.authorizedSend(request, credential: credential, key: key, as: AuthSessionState.self)
    } catch let error as EnvironmentHTTPError {
      throw Self.mapHTTP(error)
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
    try? store.remove(CredentialKeys.keyKind(environmentId))
  }

  private func save(_ credential: AccessCredential, for environmentId: String) throws(ConnectionError) {
    do {
      try store.set(credential, for: CredentialKeys.credential(environmentId))
    } catch {
      throw .unreachable("Could not save the credential: \(error)")
    }
  }

  private func dpopKey(for environmentId: String) throws(ConnectionError) -> DPoPKey {
    do { return try store.dpopKey(for: environmentId, enclave: enclave) } catch {
      throw .unreachable("Could not load the DPoP key: \(error)")
    }
  }

  private func pairingKey() throws(ConnectionError) -> DPoPKey {
    do { return try store.pairingKey(enclave: enclave) } catch { throw .unreachable("Could not load the DPoP key: \(error)") }
  }

  /// 401 is a rejected credential unless the proof's timestamp was the problem.
  static func mapHTTP(_ error: EnvironmentHTTPError) -> ConnectionError {
    switch error {
    case .status(401, let body):
      body?["dpopFailureReason"]?.stringValue == "time_window" ? .clockSkew : .credentialRejected
    case .environmentMismatch(let expected, let found):
      .environmentMismatch(expected: expected, found: found)
    case .incompatibleProtocol(let version):
      .incompatibleProtocol(serverVersion: version)
    default:
      .unreachable(describe(error))
    }
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
  public let environmentId: String
  public let endpoint: EnvironmentEndpoint
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
